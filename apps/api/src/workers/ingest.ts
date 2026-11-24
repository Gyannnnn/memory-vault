import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { perceptualHash } from '@memory-vault/media';
import type { AppContext } from '../context';
import { newId, withUser } from '../db';
import type { Asset } from '../generated/prisma/client';
import { thumbKey } from '../storage/keys';
import { normalizeMetadata } from './metadata';
import {
  exiftool,
  heifToJpeg,
  looksLikeHevcHeif,
  pdfFirstPage,
  probeVideo,
  rawPreview,
  videoPoster,
} from './media-tools';
import { obtainOriginal } from './originals';
import type { IngestJob, Jobs } from './queues';

export const VARIANTS = [
  { variant: 'sm', size: 400, quality: 76 },
  { variant: 'md', size: 1080, quality: 80 },
  { variant: 'lg', size: 2048, quality: 82 },
] as const;

type IngestContext = Pick<AppContext, 'db' | 's3' | 'env' | 'logger'> & { jobs?: Pick<Jobs, 'transcode'> };

/** Produces a file sharp can read for the asset, or null when there is nothing to show. */
async function visualFor(asset: Asset, original: string, workDirectory: string, durationMs: number | null) {
  const extension = asset.extension.toLowerCase();
  if (asset.kind === 'photo') {
    return ['heic', 'heif', 'hif'].includes(extension) || looksLikeHevcHeif(original)
      ? heifToJpeg(original, join(workDirectory, 'decoded.jpg'))
      : original;
  }
  if (asset.kind === 'raw') return rawPreview(original, workDirectory);
  if (asset.kind === 'video') return videoPoster(original, join(workDirectory, 'poster.jpg'), durationMs);
  if (extension === 'pdf') return pdfFirstPage(original, join(workDirectory, 'page'));
  return null;
}

export async function processIngest(ctx: IngestContext, job: IngestJob): Promise<'processed' | 'skipped'> {
  const loaded = await withUser(ctx.db, job.userId, async (tx) => ({
    asset: await tx.asset.findUnique({
      where: { id: job.assetId },
      include: { origins: { select: { sourceId: true, originalPath: true } } },
    }),
    user: await tx.user.findUniqueOrThrow({ where: { id: job.userId }, select: { timezone: true } }),
  }));
  const { asset, user } = loaded;
  if (!asset || asset.status !== 'verified' || asset.deletedAt) return 'skipped';

  const workDirectory = mkdtempSync(join(tmpdir(), 'vault-ingest-'));
  try {
    const original = await obtainOriginal(
      ctx,
      asset,
      {
        localPath: job.localPath,
        origins: asset.origins.map((origin) => ({ sourceId: origin.sourceId, path: origin.originalPath })),
      },
      workDirectory,
    );
    const tags = await exiftool.read(original.path);
    const metadata = normalizeMetadata(tags, {
      fileName: asset.originalName,
      timeZone: user.timezone,
      fileModifiedAt: asset.originalModifiedAt,
    });
    if (asset.kind === 'video') {
      const probe = await probeVideo(original.path).catch(() => null);
      if (probe) {
        metadata.durationMs = probe.durationMs ?? metadata.durationMs;
        metadata.width = probe.width ?? metadata.width;
        metadata.height = probe.height ?? metadata.height;
      }
    }

    const visual = await visualFor(asset, original.path, workDirectory, metadata.durationMs).catch(
      (error: unknown) => {
        ctx.logger.warn({ assetId: asset.id, err: error }, 'no preview could be produced');
        return null;
      },
    );

    const derivatives: { variant: string; key: string; width: number; height: number; size: number }[] = [];
    let phash: string | null = null;
    if (visual) {
      const image = sharp(visual, { failOn: 'none', limitInputPixels: false }).rotate();
      const info = await image.metadata();
      if (metadata.width === null && info.width && info.height) {
        const sideways = (info.orientation ?? 1) >= 5;
        metadata.width = sideways ? info.height : info.width;
        metadata.height = sideways ? info.width : info.height;
      }
      for (const { variant, size, quality } of VARIANTS) {
        const { data, info: output } = await image
          .clone()
          .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
          .webp({ quality, effort: 4 })
          .toBuffer({ resolveWithObject: true });
        const key = thumbKey(asset.userId, asset.sha256, variant);
        await ctx.s3.send(
          new PutObjectCommand({
            Bucket: ctx.env.S3_BUCKET,
            Key: key,
            Body: data,
            ContentType: 'image/webp',
            CacheControl: 'private, max-age=31536000, immutable',
            StorageClass: 'INTELLIGENT_TIERING',
            ChecksumSHA256: createHash('sha256').update(data).digest('base64'),
          }),
        );
        derivatives.push({ variant, key, width: output.width, height: output.height, size: data.length });
      }
      phash = await perceptualHash(visual).catch(() => null);
    }

    await withUser(ctx.db, job.userId, async (tx) => {
      for (const derivative of derivatives) {
        await tx.derivative.upsert({
          where: { assetId_variant: { assetId: asset.id, variant: derivative.variant } },
          create: {
            id: newId(),
            userId: asset.userId,
            assetId: asset.id,
            variant: derivative.variant,
            s3Key: derivative.key,
            mimeType: 'image/webp',
            width: derivative.width,
            height: derivative.height,
            sizeBytes: derivative.size,
          },
          update: {
            s3Key: derivative.key,
            width: derivative.width,
            height: derivative.height,
            sizeBytes: derivative.size,
          },
        });
      }
      await tx.asset.update({
        where: { id: asset.id },
        data: {
          takenAt: metadata.takenAt,
          takenAtOffsetMinutes: metadata.takenAtOffsetMinutes,
          gpsLatitude: metadata.gpsLatitude,
          gpsLongitude: metadata.gpsLongitude,
          gpsAltitude: metadata.gpsAltitude,
          cameraMake: metadata.cameraMake,
          cameraModel: metadata.cameraModel,
          lensModel: metadata.lensModel,
          width: metadata.width,
          height: metadata.height,
          durationMs: metadata.durationMs,
          isMotionPhoto: metadata.isMotionPhoto,
          phash,
          exif: {
            ...metadata.exif,
            takenAtSource: metadata.takenAtSource ?? 'unknown',
            readFrom: original.from,
          },
          processedAt: new Date(),
          processingError:
            visual || asset.kind === 'audio' || asset.kind === 'other' || asset.kind === 'document'
              ? null
              : 'no preview could be produced',
        },
      });
      // Nearest town from the bundled GeoNames table; nothing leaves this database.
      await tx.$executeRaw`
        UPDATE assets SET place_id = CASE
          WHEN gps_latitude IS NULL OR gps_longitude IS NULL THEN NULL
          ELSE nearest_place(gps_latitude, gps_longitude) END
        WHERE id = ${asset.id}::uuid`;
    });
    if (asset.kind === 'video') {
      // Streaming versions next; a local copy makes that much quicker, so those go first.
      await ctx.jobs?.transcode(
        { userId: job.userId, assetId: asset.id, ...(job.localPath ? { localPath: job.localPath } : {}) },
        { priority: original.from === 'local' ? 1 : 2 },
      );
    }
    return 'processed';
  } catch (error) {
    await withUser(ctx.db, job.userId, (tx) =>
      tx.asset.update({
        where: { id: job.assetId },
        data: { processingError: error instanceof Error ? error.message.slice(0, 500) : String(error) },
      }),
    ).catch(() => undefined);
    throw error;
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}
