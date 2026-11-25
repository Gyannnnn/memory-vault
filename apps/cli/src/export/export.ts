import { createHash, type Hash } from 'node:crypto';
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  linkSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ExportItem, ExportPage } from '@memory-vault/shared';
import { formatBytes, formatCount, formatDuration } from '@memory-vault/shared';
import { LiveView, progressLine, RateMeter } from '../ui/live';
import { interruptSignal, runPool } from '../ui/pool';

/**
 * `vault export`: every original, back in the folders it came from, under its own name and
 * date, each checked against its SHA-256. Runs again to resume or to add what's new.
 */

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** One path segment that works on Linux, macOS and Windows drives; null for "", "." and "..". */
export function safeSegment(segment: string): string | null {
  if (segment === '' || segment === '.' || segment === '..') return null;
  const cleaned = [...segment]
    .map((char) => (char.charCodeAt(0) < 32 || '<>:"\\|?*'.includes(char) ? '_' : char))
    .join('')
    .replace(/[. ]+$/, '');
  if (!cleaned) return '_';
  return WINDOWS_RESERVED.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Where a file goes: once per place it was found (source/path), or unsorted/ if it has none. */
export function exportPaths(item: Pick<ExportItem, 'origins' | 'originalName' | 'sha256'>): string[] {
  const paths = item.origins
    .map((origin) => {
      const segments = origin.path
        .split('/')
        .map(safeSegment)
        .filter((part): part is string => part !== null);
      const source = safeSegment(origin.sourceId.replace(':', '-'));
      return segments.length && source ? [source, ...segments].join('/') : null;
    })
    .filter((path): path is string => path !== null);
  const unique = [...new Set(paths)];
  return unique.length ? unique : [`unsorted/${safeSegment(item.originalName) ?? item.sha256}`];
}

/** The date a file should carry: when it was last changed where it was found. */
export function fileTime(
  item: Pick<ExportItem, 'modifiedAt' | 'takenAt' | 'localAt'>,
  originModifiedAt?: string | null,
): Date {
  const value = originModifiedAt ?? item.modifiedAt ?? item.takenAt ?? item.localAt;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

export class ConflictError extends Error {}

async function hashExisting(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
}

/**
 * Downloads to `<target>.part`, checking size and SHA-256, then renames it into place. A
 * `.part` from an earlier run is continued with a range request. A file already at the
 * target is left alone: if it's the right size it counts as done (re-hashed with `verify`),
 * otherwise it's someone else's file and is reported, never overwritten.
 */
export async function fetchVerified(
  url: () => Promise<string>,
  target: string,
  expected: { size: number; sha256: string },
  options: { fetch?: typeof fetch; onBytes?: (bytes: number) => void; verify?: boolean } = {},
): Promise<'downloaded' | 'resumed' | 'present'> {
  const doFetch = options.fetch ?? fetch;
  if (existsSync(target)) {
    if (statSync(target).size !== expected.size)
      throw new ConflictError('a different file is already there; left as it is');
    if (options.verify) {
      const hash = createHash('sha256');
      await hashExisting(target, hash);
      if (hash.digest('hex') !== expected.sha256)
        throw new ConflictError('the file there differs from the original; left as it is');
    }
    options.onBytes?.(expected.size);
    return 'present';
  }
  mkdirSync(dirname(target), { recursive: true });
  const part = `${target}.part`;
  let have = existsSync(part) ? statSync(part).size : 0;
  if (have > expected.size) {
    rmSync(part);
    have = 0;
  }
  const hash = createHash('sha256');
  if (have > 0) await hashExisting(part, hash);
  options.onBytes?.(have);

  if (have < expected.size) {
    const request = async () => doFetch(await url(), have ? { headers: { range: `bytes=${have}-` } } : {});
    let response = await request();
    if (response.status === 403) {
      // Links expire after a few hours; ask for a fresh one once.
      await response.body?.cancel();
      response = await request();
    }
    if (have > 0 && response.status === 200) {
      // The server ignored the range and sent the whole file: start that file over.
      await response.body?.cancel();
      rmSync(part);
      options.onBytes?.(-have);
      return fetchVerified(url, target, expected, options);
    }
    if (response.status !== 200 && response.status !== 206)
      throw new Error(`storage answered ${response.status}`);
    if (!response.body) throw new Error('empty response');
    const count = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        hash.update(chunk);
        options.onBytes?.(chunk.length);
        done(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      count,
      createWriteStream(part, { flags: have ? 'a' : 'w' }),
    );
  }
  const size = statSync(part).size;
  const digest = hash.digest('hex');
  if (size !== expected.size || digest !== expected.sha256) {
    rmSync(part, { force: true });
    throw new Error(
      size !== expected.size
        ? `got ${size} bytes instead of ${expected.size}`
        : 'the download does not match its SHA-256',
    );
  }
  renameSync(part, target);
  return have > 0 ? 'resumed' : 'downloaded';
}

/** Puts the same file at another path without using more space (or copies it if it must). */
function placeCopy(from: string, to: string): void {
  if (existsSync(to)) {
    if (statSync(to).size === statSync(from).size) return;
    throw new ConflictError('a different file is already there; left as it is');
  }
  mkdirSync(dirname(to), { recursive: true });
  try {
    linkSync(from, to);
  } catch {
    copyFileSync(from, to);
  }
}

export interface ExportApi {
  exportPage(cursor?: string, limit?: number): Promise<ExportPage>;
  downloadUrl(assetId: string): Promise<string>;
}

const README = (count: number, bytes: number, when: string) => `Memory Vault export
===================

Made ${when}: ${count.toLocaleString()} files, ${formatBytes(bytes)}.

Every original is here exactly as it was uploaded, byte for byte, in the folders it came
from: one top-level folder per source (laptop-…, phone-…, web-…), then the same path the
file had there. A file that was in several places appears in each (as hard links, so it
takes the space of one). Files with no recorded place are in unsorted/. Each file carries
its original modification date.

catalogue.json lists every file with its SHA-256, size, capture time, place, camera and
every path it was found at. To check a file by hand:

  sha256sum "phone-s21fe/DCIM/Camera/IMG_1.jpg"

and compare with its "sha256" in the catalogue.

Running \`vault export <this folder>\` again resumes an interrupted export and adds anything
new. Nothing here is changed or deleted by doing so.
`;

export async function runExport(
  directory: string,
  api: ExportApi,
  options: { concurrency?: number; verify?: boolean; fetch?: typeof fetch; quiet?: boolean } = {},
): Promise<{ files: number; bytes: number; failures: { path: string; reason: string }[] }> {
  const root = resolve(directory);
  mkdirSync(root, { recursive: true });
  const view = new LiveView();
  const meter = new RateMeter();
  const interrupt = interruptSignal(() =>
    view.finish(['Stopping… (partly downloaded files are kept and resumed next time)']),
  );
  const counts = { downloaded: 0, resumed: 0, present: 0, links: 0 };
  const failures: { path: string; reason: string }[] = [];
  const catalogue: Omit<ExportItem, 'url'>[] = [];
  let total = 0;
  let totalBytes = 0;
  let doneBytes = 0;
  let cursor: string | undefined;

  const render = () => {
    if (options.quiet) return;
    view.render([
      progressLine('Exporting', doneBytes, totalBytes, meter),
      `${formatCount(catalogue.length)} of ${formatCount(total)} files · ${formatCount(counts.downloaded + counts.resumed)} downloaded, ${formatCount(counts.present)} already there${failures.length ? ` · ${formatCount(failures.length)} problems` : ''}`,
    ]);
  };

  try {
    do {
      const page = await api.exportPage(cursor, 200);
      if (page.total !== null) total = page.total;
      if (page.totalBytes !== null) totalBytes = page.totalBytes;
      await runPool(
        page.items,
        options.concurrency ?? 3,
        async (item) => {
          const [first, ...others] = exportPaths(item);
          const target = join(root, first!);
          let url: string | null = item.url;
          try {
            const result = await fetchVerified(
              async () => {
                const current = url ?? (await api.downloadUrl(item.id));
                url = null; // a second request (expired link, restart) gets a fresh one
                return current;
              },
              target,
              { size: item.sizeBytes, sha256: item.sha256 },
              {
                fetch: options.fetch,
                verify: options.verify,
                onBytes: (bytes) => {
                  doneBytes += bytes;
                  if (bytes > 0) meter.add(bytes);
                  render();
                },
              },
            );
            counts[result] += 1;
            const origins = item.origins;
            utimesSync(target, new Date(), fileTime(item, origins[0]?.modifiedAt));
            for (const other of others) {
              placeCopy(target, join(root, other));
              counts.links += 1;
            }
            const { url: _link, ...entry } = item;
            catalogue.push(entry);
          } catch (error) {
            failures.push({ path: first!, reason: error instanceof Error ? error.message : String(error) });
          }
          render();
        },
        interrupt.signal,
      );
      cursor = interrupt.signal.aborted ? undefined : (page.nextCursor ?? undefined);
    } while (cursor);
  } finally {
    interrupt.dispose();
  }

  const stopped = interrupt.signal.aborted;
  if (!stopped) {
    catalogue.sort((a, b) => a.localAt.localeCompare(b.localAt) || a.id.localeCompare(b.id));
    writeFileSync(
      join(root, 'catalogue.json'),
      `${JSON.stringify({ exportedAt: new Date().toISOString(), files: catalogue }, null, 1)}\n`,
    );
    writeFileSync(join(root, 'README.txt'), README(catalogue.length, totalBytes, new Date().toUTCString()));
  }
  const reportPath = join(root, 'export-problems.txt');
  if (failures.length > 0)
    writeFileSync(
      reportPath,
      failures.map((failure) => `${failure.path}\t${failure.reason}`).join('\n') + '\n',
    );
  else rmSync(reportPath, { force: true });

  if (!options.quiet)
    view.finish(
      [
        stopped ? 'Stopped. Run the same command again to carry on.' : 'Done.',
        `  Downloaded: ${formatCount(counts.downloaded + counts.resumed)}${counts.resumed ? ` (${formatCount(counts.resumed)} resumed)` : ''} · already there: ${formatCount(counts.present)} · extra locations: ${formatCount(counts.links)}`,
        `  ${formatBytes(doneBytes)} in ${formatDuration(meter.elapsedSeconds())}`,
        ...(failures.length
          ? [
              `  ${formatCount(failures.length)} problems, listed in ${reportPath}`,
              ...failures.slice(0, 5).map((failure) => `    ${failure.path}: ${failure.reason}`),
            ]
          : []),
        stopped ? '' : `  Every file checked against its SHA-256. Catalogue: ${join(root, 'catalogue.json')}`,
      ].filter(Boolean),
    );
  return { files: catalogue.length, bytes: doneBytes, failures };
}
