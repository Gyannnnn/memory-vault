import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';
import { perceptualHash } from '@memory-vault/media';
import type { AppContext } from '../context';
import { newId, withUser } from '../db';
import type { Asset } from '../generated/prisma/client';
import { thumbKey } from '../storage/keys';
import { normalizeMetadata } from './metadata';
import { exiftool, heifToJpeg, pdfFirstPage, probeVideo, rawPreview, videoPoster } from './media-tools';
import type { IngestJob } from './queues';

export const VARIANTS = [
  { variant: 'sm', size: 400, quality: 76 },
  { variant: 'md', size: 1080, quality: 80 },
  { variant: 'lg', size: 2048, quality: 82 },
] as const;

type IngestContext = Pick<AppContext, 'db' | 's3' | 'env' | 'logger'>;

/** Maps a path on the uploading machine to where the worker sees it (read-only mounts). */
export function mapLocalPath(localPath: string, pathMap: string): string | null {
  for (const pair of pathMap.split(';').filter(Boolean)) {
    const [host, container] = pair.split('=');
    if (!host || !container) continue;
    if (localPath === host || localPath.startsWith(`${host}/`))
      return `${container}${localPath.slice(host.length)}`;
  }
  return null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Uses the uploader's local copy when it's visible and identical; otherwise downloads the original from S3. */
async function obtainOriginal(ctx: IngestContext, asset: Asset, job: IngestJob, workDirectory: string) {
  const mapped = job.localPath ? mapLocalPath(job.localPath, ctx.env.LOCAL_PATH_MAP) : null;
  for (const candidate of [mapped, job.localPath].filter((path): path is string => Boolean(path))) {
    if (!existsSync(candidate) || statSync(candidate).size !== Number(asset.sizeBytes)) continue;
    if ((await sha256File(candidate)) === asset.sha256) return { path: candidate, from: 'local' as const };
  }
  const target = join(workDirectory, `original.${asset.extension || 'bin'}`);
  const object = await ctx.s3.send(new GetObjectCommand({ Bucket: ctx.env.S3_BUCKET, Key: asset.s3Key }));
  await pipeline(object.Body as Readable, createWriteStream(target));
  return { path: target, from: 's3' as const };
}

/** Produces a file sharp can read for the asset, or null when there is nothing to show. */
async function visualFor(asset: Asset, original: string, workDirectory: string, durationMs: number | null) {
  const extension = asset.extension.toLowerCase();
  if (asset.kind === 'photo') {
    return ['heic', 'heif', 'hif'].includes(extension)
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
    asset: await tx.asset.findUnique({ where: { id: job.assetId }, include: { origins: { take: 1 } } }),
    user: await tx.user.findUniqueOrThrow({ where: { id: job.userId }, select: { timezone: true } }),
  }));
  const { asset, user } = loaded;
  if (!asset || asset.status !== 'verified' || asset.deletedAt) return 'skipped';

  const workDirectory = mkdtempSync(join(tmpdir(), 'vault-ingest-'));
  try {
    const original = await obtainOriginal(ctx, asset, job, workDirectory);
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
