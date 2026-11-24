import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../context';
import { newId, withUser } from '../db';
import { motionKey } from '../storage/keys';
import { putFile } from '../storage/put-file';
import { probeForStreaming, runNiced, type StreamProbe } from './media-tools';
import { obtainOriginal } from './originals';
import type { TranscodeJob } from './queues';
import { TONE_MAP } from './transcode';

/** Brands of an MP4/QuickTime video, as opposed to the HEIF image a HEIC photo starts with. */
const VIDEO_BRANDS = /^(isom|iso\d|mp4\d|mp42|avc1|qt {2}|M4V |3gp\d|hvc1|dash)$/;
const BOX_TYPE = /^[a-zA-Z0-9 ©_-]{4}$/;

/**
 * Length of the MP4 starting at `start`, by walking its top-level boxes; null unless it has
 * the boxes every playable file has (ftyp, moov, mdat). Stops at whatever follows the video
 * (Samsung appends its own trailer after it).
 */
export function mp4Length(buffer: Buffer, start: number): number | null {
  let offset = start;
  const seen = new Set<string>();
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    if (!BOX_TYPE.test(type)) break;
    if (size === 1) {
      if (offset + 16 > buffer.length) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
    } else if (size === 0) {
      size = buffer.length - offset;
    }
    if (size < 8 || offset + size > buffer.length) break;
    seen.add(type);
    offset += size;
  }
  return seen.has('ftyp') && seen.has('moov') && seen.has('mdat') ? offset - start : null;
}

/**
 * The video inside a motion photo (Samsung and Google both append an MP4 to the image),
 * found by its own `ftyp` box rather than by vendor metadata. Null if there isn't one.
 */
export function findEmbeddedVideo(buffer: Buffer): { start: number; length: number } | null {
  for (let at = buffer.indexOf('ftyp', 4, 'latin1'); at >= 0; at = buffer.indexOf('ftyp', at + 4, 'latin1')) {
    const start = at - 4;
    const brand = buffer.toString('latin1', at + 4, at + 8);
    if (start <= 0 || !VIDEO_BRANDS.test(brand)) continue;
    const length = mp4Length(buffer, start);
    if (length) return { start, length };
  }
  return null;
}

/** ffmpeg arguments for a motion photo's clip: H.264 up to 720p (short side), sound kept, ready to stream. */
export function motionClipArgs(
  input: string,
  output: string,
  probe: Pick<StreamProbe, 'width' | 'height' | 'hdr'>,
): { args: string[]; width: number; height: number } {
  const sourceShort = Math.min(probe.width, probe.height);
  const short = Math.max(2, Math.round(Math.min(720, sourceShort) / 2) * 2);
  const long = Math.max(2, Math.round((Math.max(probe.width, probe.height) * short) / sourceShort / 2) * 2);
  const [width, height] = probe.width >= probe.height ? [long, short] : [short, long];
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-threads',
    '4',
    '-i',
    input,
    '-map',
    '0:v:0',
    '-map',
    '0:a:0?',
    '-vf',
    `scale=${width}:${height}:flags=bicubic,${probe.hdr ? TONE_MAP : ''}format=yuv420p,setsar=1`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '24',
    '-profile:v',
    'high',
    '-threads',
    '4',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-ac',
    '2',
    '-movflags',
    '+faststart',
    output,
  ];
  return { args, width, height };
}

type MotionContext = Pick<AppContext, 'db' | 's3' | 'env' | 'logger'>;

/** Makes the short clip of a motion photo playable everywhere: H.264, up to 720p, ready to stream. */
export async function processMotion(
  ctx: MotionContext,
  job: TranscodeJob,
): Promise<'made' | 'none' | 'skipped'> {
  const asset = await withUser(ctx.db, job.userId, (tx) =>
    tx.asset.findUnique({
      where: { id: job.assetId },
      include: {
        origins: { select: { sourceId: true, originalPath: true } },
        derivatives: { where: { variant: 'motion' }, select: { id: true } },
      },
    }),
  );
  if (!asset || asset.kind !== 'photo' || asset.status !== 'verified' || asset.deletedAt) return 'skipped';
  if (asset.derivatives.length > 0) return 'skipped';

  const workDirectory = mkdtempSync(join(tmpdir(), 'vault-motion-'));
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
    const bytes = readFileSync(original.path);
    const found = findEmbeddedVideo(bytes);
    if (!found) {
      ctx.logger.info({ assetId: asset.id }, 'motion photo has no embedded video');
      return 'none';
    }
    const clip = join(workDirectory, 'embedded.mp4');
    writeFileSync(clip, bytes.subarray(found.start, found.start + found.length));
    const probe = await probeForStreaming(clip);
    const output = join(workDirectory, 'motion.mp4');
    const { args, width, height } = motionClipArgs(clip, output, probe);
    await runNiced('ffmpeg', args, 10 * 60_000);
    const key = motionKey(asset.userId, asset.sha256);
    const sizeBytes = await putFile(ctx, { key, path: output, contentType: 'video/mp4' });
    await withUser(ctx.db, job.userId, (tx) =>
      tx.derivative.upsert({
        where: { assetId_variant: { assetId: asset.id, variant: 'motion' } },
        create: {
          id: newId(),
          userId: asset.userId,
          assetId: asset.id,
          variant: 'motion',
          s3Key: key,
          mimeType: 'video/mp4',
          width,
          height,
          sizeBytes,
          details: { durationSeconds: Math.round(probe.durationMs) / 1000 },
        },
        update: { s3Key: key, width, height, sizeBytes },
      }),
    );
    return 'made';
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}
