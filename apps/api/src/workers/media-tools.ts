import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ExifTool } from 'exiftool-vendored';

const run = promisify(execFile);
const TOOL_TIMEOUT_MS = 10 * 60 * 1000;

export const exiftool = new ExifTool({
  taskTimeoutMillis: 60_000,
  defaultVideosToUTC: true,
  inferTimezoneFromDatestamps: true,
  ignoreZeroZeroLatLon: true,
});

async function firstAvailable(candidates: string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await run('which', [candidate]);
      return candidate;
    } catch {
      // try the next one
    }
  }
  throw new Error(`none of ${candidates.join(', ')} is installed; run the worker in its Docker image`);
}

/** HEIC/HEIF → JPEG via libheif, which applies the image's rotation and mirroring. */
export async function heifToJpeg(input: string, output: string): Promise<string> {
  const tool = await firstAvailable(['heif-dec', 'heif-convert']);
  await run(tool, ['--quality', '92', input, output], { timeout: TOOL_TIMEOUT_MS });
  if (existsSync(output)) return output;
  // Multi-image HEIFs are written as name-1.jpg, name-2.jpg…; the first is the primary image.
  const base = output.replace(/\.jpg$/, '');
  const first = `${base}-1.jpg`;
  if (existsSync(first)) return first;
  throw new Error('libheif produced no image');
}

export interface VideoProbe {
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

export async function probeVideo(input: string): Promise<VideoProbe> {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input],
    { timeout: TOOL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
  );
  const probe = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      width?: number;
      height?: number;
      side_data_list?: { rotation?: number }[];
      tags?: { rotate?: string };
    }[];
  };
  const video = probe.streams?.find((stream) => stream.codec_type === 'video');
  const rotation = Math.abs(
    Number(
      video?.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ??
        video?.tags?.rotate ??
        0,
    ),
  );
  const sideways = rotation === 90 || rotation === 270;
  const duration = Number(probe.format?.duration);
  return {
    durationMs: Number.isFinite(duration) ? Math.round(duration * 1000) : null,
    width: (sideways ? video?.height : video?.width) ?? null,
    height: (sideways ? video?.width : video?.height) ?? null,
  };
}

/** A representative frame: one second in, or the first frame for very short clips. Rotation is applied. */
export async function videoPoster(input: string, output: string, durationMs: number | null): Promise<string> {
  const at = durationMs !== null && durationMs < 2000 ? 0 : 1;
  await run(
    'ffmpeg',
    ['-v', 'error', '-y', '-ss', String(at), '-i', input, '-frames:v', '1', '-q:v', '2', output],
    { timeout: TOOL_TIMEOUT_MS },
  );
  if (!existsSync(output)) throw new Error('ffmpeg produced no frame');
  return output;
}

export async function pdfFirstPage(input: string, outputPrefix: string): Promise<string> {
  await run('pdftoppm', ['-png', '-f', '1', '-l', '1', '-scale-to', '2048', input, outputPrefix], {
    timeout: TOOL_TIMEOUT_MS,
  });
  const directory = join(outputPrefix, '..');
  const prefix = outputPrefix.split('/').at(-1)!;
  const page = readdirSync(directory).find((name) => name.startsWith(`${prefix}-`) && name.endsWith('.png'));
  if (!page) throw new Error('pdftoppm produced no page');
  return join(directory, page);
}

/** RAW files: the camera's embedded JPEG preview, or a half-size development with LibRaw. */
export async function rawPreview(input: string, workDirectory: string): Promise<string> {
  const preview = join(workDirectory, 'raw-preview.jpg');
  try {
    await exiftool.extractPreview(input, preview);
    if (existsSync(preview)) return preview;
  } catch {
    // no embedded preview
  }
  try {
    await exiftool.extractJpgFromRaw(input, preview);
    if (existsSync(preview)) return preview;
  } catch {
    // fall through to LibRaw
  }
  // LibRaw writes next to its input, and sources are mounted read-only, so develop a copy.
  const copy = join(workDirectory, `raw-input${input.slice(input.lastIndexOf('.'))}`);
  copyFileSync(input, copy);
  await run('dcraw_emu', ['-T', '-h', '-w', copy], { timeout: TOOL_TIMEOUT_MS });
  const developed = `${copy}.tiff`;
  if (!existsSync(developed)) throw new Error('could not decode RAW file');
  return developed;
}
