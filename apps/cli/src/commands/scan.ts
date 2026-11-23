import { createSourceReader, sha256Stream } from '@memory-vault/media';
import {
  classifyPath,
  extensionOf,
  formatBytes,
  formatCount,
  formatDuration,
  mediaKindOf,
  type SourceId,
} from '@memory-vault/shared';
import type { EntryUpsert, Manifest } from '../manifest/manifest';
import { LiveView, progressLine, RateMeter } from '../ui/live';
import { interruptSignal, runPool } from '../ui/pool';

export interface ScanResult {
  entries: number;
  hashed: number;
  hashErrors: number;
  missing: number;
  interrupted: boolean;
}

const BATCH = 1000;

export function describeEntry(path: string): Pick<EntryUpsert, 'kind' | 'ext' | 'route' | 'reasons'> {
  const { route, reasons } = classifyPath(path);
  return { kind: mediaKindOf(path), ext: extensionOf(path), route, reasons };
}

export async function scanLocalSource(
  manifest: Manifest,
  sourceId: SourceId,
  rootPath: string,
  options: { concurrency?: number } = {},
): Promise<ScanResult> {
  const reader = createSourceReader(rootPath);
  manifest.registerSource({ id: sourceId, kind: 'local', root: reader.root });
  const view = new LiveView();
  const { signal, dispose } = interruptSignal(() =>
    view.finish(['Stopping after the files in progress… (press Ctrl+C again to quit now)']),
  );

  try {
    const scanId = manifest.startScan(sourceId);
    let entries = 0;
    let batch: EntryUpsert[] = [];
    for await (const entry of reader.walk()) {
      if (signal.aborted) break;
      entries += 1;
      if (entry.type === 'file') {
        batch.push({
          path: entry.relativePath,
          entryType: 'file',
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          mtimeNs: entry.mtimeNs.toString(),
          ino: entry.ino.toString(),
          ...describeEntry(entry.relativePath),
        });
      } else if (entry.type === 'error') {
        batch.push({ path: entry.relativePath, entryType: 'error', error: entry.error });
      } else {
        batch.push({ path: entry.relativePath, entryType: entry.type, ...describeEntry(entry.relativePath) });
      }
      if (batch.length >= BATCH) {
        manifest.upsertEntries(sourceId, scanId, batch);
        batch = [];
        view.render([`Scanning ${reader.root}  ${formatCount(entries)} entries`]);
      }
    }
    manifest.upsertEntries(sourceId, scanId, batch);
    if (signal.aborted) {
      view.finish();
      return { entries, hashed: 0, hashErrors: 0, missing: 0, interrupted: true };
    }
    const { missing } = manifest.finishScan(sourceId, scanId);
    view.finish([`Scanned ${formatCount(entries)} entries in ${reader.root}`]);

    const toHash = manifest.filesNeedingHash(sourceId);
    const totalBytes = toHash.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const meter = new RateMeter();
    let hashed = 0;
    let hashErrors = 0;
    const redraw = () =>
      view.render([
        progressLine('Hashing', meter.total, totalBytes, meter),
        `        ${formatCount(hashed)} / ${formatCount(toHash.length)} files${hashErrors ? `, ${hashErrors} unreadable` : ''}`,
      ]);
    const timer = setInterval(redraw, 250);

    try {
      await runPool(
        toHash,
        options.concurrency ?? 4,
        async (file) => {
          const stream = reader.openRead(file.path);
          const stop = () => stream.destroy();
          signal.addEventListener('abort', stop, { once: true });
          try {
            const before = await reader.stat(file.path);
            const sha256 = await sha256Stream(stream, (bytes) => meter.add(bytes));
            const after = await reader.stat(file.path);
            if (after.size !== before.size || after.mtimeNs !== before.mtimeNs) {
              throw new Error('file changed while it was being hashed');
            }
            manifest.setHash(sourceId, file.path, sha256, after.size, after.mtimeNs.toString());
            hashed += 1;
          } catch (error) {
            if (signal.aborted) return;
            hashErrors += 1;
            manifest.setError(sourceId, file.path, error instanceof Error ? error.message : String(error));
          } finally {
            signal.removeEventListener('abort', stop);
            stream.destroy();
          }
        },
        signal,
      );
    } finally {
      clearInterval(timer);
    }

    view.finish([
      signal.aborted
        ? `Paused after hashing ${formatCount(hashed)} files. Re-run the same command to continue.`
        : `Hashed ${formatCount(hashed)} files (${formatBytes(totalBytes)}) in ${formatDuration(meter.elapsedSeconds())}` +
          (hashErrors ? `; ${hashErrors} could not be read (listed in the report)` : ''),
    ]);
    return { entries, hashed, hashErrors, missing, interrupted: signal.aborted };
  } finally {
    dispose();
  }
}
