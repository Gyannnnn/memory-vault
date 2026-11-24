import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppContext } from '../context';
import { newId, withUser } from '../db';
import { streamKey } from '../storage/keys';
import { putFile } from '../storage/put-file';
import { probeForStreaming, runNiced, streamCodecs, type StreamProbe } from './media-tools';
import { obtainOriginal } from './originals';
import type { TranscodeJob } from './queues';

/**
 * Streaming versions of every video, named by their short side so portrait and landscape
 * clips get the same quality ladder. Never larger than the original.
 */
export const LADDER = [
  { short: 360, maxrateKbps: 800, audioKbps: 96, maxFps: 30 },
  { short: 720, maxrateKbps: 2800, audioKbps: 128, maxFps: 30 },
  { short: 1080, maxrateKbps: 5000, audioKbps: 128, maxFps: 60 },
] as const;

export interface Rendition {
  short: number;
  width: number;
  height: number;
  fps: number;
  maxrateKbps: number;
  audioKbps: number;
}

export interface StreamDetails {
  playlist: string;
  fileName: string;
  bandwidth: number;
  averageBandwidth: number;
  codecs: string;
  frameRate: number;
  durationSeconds: number;
}

const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);

export function planRenditions(probe: Pick<StreamProbe, 'width' | 'height' | 'frameRate'>): Rendition[] {
  const sourceShort = Math.min(probe.width, probe.height);
  const landscape = probe.width >= probe.height;
  const steps = LADDER.filter((step) => step.short <= sourceShort);
  // Smaller than 360p: one version at the original size.
  const chosen = steps.length > 0 ? steps : [{ ...LADDER[0], short: even(sourceShort) }];
  return chosen.map((step) => {
    const long = even((Math.max(probe.width, probe.height) * step.short) / sourceShort);
    return {
      short: step.short,
      width: landscape ? long : step.short,
      height: landscape ? step.short : long,
      fps: Math.min(step.maxFps, Math.round(probe.frameRate * 1000) / 1000),
      maxrateKbps: step.maxrateKbps,
      audioKbps: step.audioKbps,
    };
  });
}

/** HDR (PQ or HLG) → SDR BT.709, so HDR phone clips don't look washed out in browsers. */
const TONE_MAP =
  'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,';

/**
 * One ffmpeg run decodes the original once and writes every rendition as HLS: fragmented
 * MP4 in a single file per rendition, addressed by byte range, 4-second segments that all
 * start on a keyframe. Rotation is applied by ffmpeg's decoder.
 */
export function transcodeArgs(
  input: string,
  directory: string,
  probe: Pick<StreamProbe, 'hasAudio' | 'hdr' | 'frameRate'>,
  renditions: Rendition[],
): string[] {
  const outputs = renditions.map((_, index) => `[s${index}]`).join('');
  // Tone mapping works on 32-bit float frames: shrink to the largest rendition first, so a
  // 4K HDR clip never needs gigabytes of frame buffers.
  const largest = renditions.reduce((big, rendition) => (rendition.short > big.short ? rendition : big));
  const toneMap = probe.hdr ? `scale=${largest.width}:${largest.height}:flags=bicubic,${TONE_MAP}` : '';
  const filters = [
    `[0:v]${toneMap}split=${renditions.length}${outputs}`,
    ...renditions.map(
      (rendition, index) =>
        `[s${index}]scale=${rendition.width}:${rendition.height}:flags=bicubic,${
          probe.frameRate > rendition.fps + 0.5 ? `fps=${rendition.fps},` : ''
        }format=yuv420p,setsar=1[v${index}]`,
    ),
  ];
  // Threads are capped: the Docker VM has little memory, and every thread holds frames.
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-threads',
    '4',
    '-i',
    input,
    '-filter_complex_threads',
    '2',
    '-filter_complex',
    filters.join(';'),
  ];
  renditions.forEach((rendition, index) => {
    args.push('-map', `[v${index}]`);
    if (probe.hasAudio) args.push('-map', '0:a:0');
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-threads',
      '4',
      '-maxrate',
      `${rendition.maxrateKbps}k`,
      '-bufsize',
      `${rendition.maxrateKbps * 2}k`,
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
      '-sc_threshold',
      '0',
    );
    if (probe.hasAudio)
      args.push('-c:a', 'aac', '-b:a', `${rendition.audioKbps}k`, '-ac', '2', '-ar', '48000');
    args.push(
      '-f',
      'hls',
      '-hls_time',
      '4',
      '-hls_playlist_type',
      'vod',
      '-hls_segment_type',
      'fmp4',
      '-hls_flags',
      'single_file',
      '-hls_segment_filename',
      join(directory, `${rendition.short}p.mp4`),
      join(directory, `${rendition.short}p.m3u8`),
    );
  });
  return args;
}

/** Peak and average bits per second from a byte-range playlist, as HLS BANDWIDTH wants them. */
export function playlistStats(playlist: string): {
  durationSeconds: number;
  bandwidth: number;
  averageBandwidth: number;
} {
  let duration = 0;
  let bytes = 0;
  let peak = 0;
  let pending: number | null = null;
  for (const line of playlist.split('\n')) {
    const extinf = /^#EXTINF:([\d.]+)/.exec(line);
    if (extinf) pending = Number(extinf[1]);
    const range = /^#EXT-X-BYTERANGE:(\d+)@\d+/.exec(line);
    if (range && pending !== null) {
      const length = Number(range[1]);
      duration += pending;
      bytes += length;
      if (pending > 0.5) peak = Math.max(peak, (length * 8) / pending);
      pending = null;
    }
  }
  const average = duration > 0 ? (bytes * 8) / duration : 0;
  return {
    durationSeconds: Math.round(duration * 1000) / 1000,
    bandwidth: Math.ceil(Math.max(peak, average)),
    averageBandwidth: Math.ceil(average),
  };
}

type TranscodeContext = Pick<AppContext, 'db' | 's3' | 'env' | 'logger'>;

export async function processTranscode(
  ctx: TranscodeContext,
  job: TranscodeJob,
): Promise<'transcoded' | 'skipped'> {
  const asset = await withUser(ctx.db, job.userId, (tx) =>
    tx.asset.findUnique({
      where: { id: job.assetId },
      include: {
        origins: { select: { sourceId: true, originalPath: true } },
        derivatives: { where: { variant: { startsWith: 'hls-' } }, select: { id: true } },
      },
    }),
  );
  if (!asset || asset.kind !== 'video' || asset.status !== 'verified' || asset.deletedAt) return 'skipped';
  if (asset.derivatives.length > 0) return 'skipped';

  const workDirectory = mkdtempSync(join(tmpdir(), 'vault-transcode-'));
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
    const probe = await probeForStreaming(original.path);
    const renditions = planRenditions(probe);
    const outDirectory = join(workDirectory, 'out');
    mkdirSync(outDirectory);
    const started = Date.now();
    await runNiced(
      'ffmpeg',
      transcodeArgs(original.path, outDirectory, probe, renditions),
      Math.max(20 * 60_000, probe.durationMs * 8),
    );

    const made: { rendition: Rendition; key: string; size: number; details: StreamDetails }[] = [];
    for (const rendition of renditions) {
      const fileName = `${rendition.short}p.mp4`;
      const file = join(outDirectory, fileName);
      const playlist = readFileSync(join(outDirectory, `${rendition.short}p.m3u8`), 'utf8');
      const stats = playlistStats(playlist);
      const key = streamKey(asset.userId, asset.sha256, rendition.short);
      const size = await putFile(ctx, { key, path: file, contentType: 'video/mp4' });
      made.push({
        rendition,
        key,
        size,
        details: { playlist, fileName, codecs: await streamCodecs(file), frameRate: rendition.fps, ...stats },
      });
    }

    await withUser(ctx.db, job.userId, async (tx) => {
      for (const { rendition, key, size, details } of made) {
        const values = {
          s3Key: key,
          mimeType: 'video/mp4',
          width: rendition.width,
          height: rendition.height,
          sizeBytes: size,
          details: { ...details },
        };
        await tx.derivative.upsert({
          where: { assetId_variant: { assetId: asset.id, variant: `hls-${rendition.short}` } },
          create: {
            id: newId(),
            userId: asset.userId,
            assetId: asset.id,
            variant: `hls-${rendition.short}`,
            ...values,
          },
          update: values,
        });
      }
    });
    ctx.logger.info(
      {
        assetId: asset.id,
        from: original.from,
        renditions: renditions.map((rendition) => rendition.short),
        seconds: Math.round((Date.now() - started) / 1000),
        videoSeconds: Math.round(probe.durationMs / 1000),
      },
      'video transcoded',
    );
    return 'transcoded';
  } finally {
    rmSync(workDirectory, { recursive: true, force: true });
  }
}
