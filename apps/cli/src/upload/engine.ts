import { createHash } from 'node:crypto';
import { createSourceReader, type SourceReader } from '@memory-vault/media';
import type { ApiClient } from '@memory-vault/api-client';
import {
  formatBytes,
  formatCount,
  formatDuration,
  mimeTypeOf,
  type Origin,
  type SourceId,
} from '@memory-vault/shared';
import type { FileRow, Manifest, SourceRow } from '../manifest/manifest';
import { bar, LiveView, RateMeter } from '../ui/live';
import { interruptSignal, runPool } from '../ui/pool';
import { putBuffer, withRetry } from './transport';

export interface StagedFile {
  reader: SourceReader;
  relativePath: string;
  release(succeeded: boolean): Promise<void>;
}

export interface UploadOptions {
  sourceIds: SourceId[];
  apiUrl: string;
  retryFailed: boolean;
  /** Upload content the owner deleted for good from the vault, too. */
  includeDeleted?: boolean;
  parallelParts: number;
  parallelFiles: number;
  stagePhoneFile: (source: SourceRow, row: FileRow, signal: AbortSignal) => Promise<StagedFile>;
}

export interface UploadSummary {
  uploaded: number;
  uploadedBytes: number;
  deduplicated: number;
  failed: number;
  awaitingReview: number;
  /** Stored, but in the vault's Trash. */
  inTrash: number;
  /** Deleted for good from the vault by you; not uploaded again. */
  deletedByYou: number;
  interrupted: boolean;
}

interface Content {
  sha256: string;
  size: number;
  rows: FileRow[];
}

class FileChangedError extends Error {}

class Slots {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }
  release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free += 1;
  }
}

const sha256Base64 = (data: Buffer) => createHash('sha256').update(data).digest('base64');
const sha256Hex = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const BATCH = 500;

function originOf(row: FileRow, localPath?: string): Origin {
  return {
    sourceId: row.sourceId,
    path: row.path,
    ...(row.mtimeMs !== null ? { modifiedAt: new Date(row.mtimeMs).toISOString() } : {}),
    ...(localPath ? { localPath } : {}),
  };
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export async function runUpload(
  manifest: Manifest,
  api: ApiClient,
  options: UploadOptions,
): Promise<UploadSummary> {
  const view = new LiveView();
  const { signal, dispose } = interruptSignal(() =>
    view.finish(['Pausing: finishing the parts in flight… (Ctrl+C again to quit immediately)']),
  );
  const summary: UploadSummary = {
    uploaded: 0,
    uploadedBytes: 0,
    deduplicated: 0,
    failed: 0,
    awaitingReview: 0,
    inTrash: 0,
    deletedByYou: 0,
    interrupted: false,
  };

  try {
    const sources = new Map<SourceId, SourceRow>();
    const readers = new Map<SourceId, SourceReader>();
    for (const id of options.sourceIds) {
      const source = manifest.getSource(id);
      if (!source) throw new Error(`unknown source ${id}`);
      sources.set(id, source);
      if (source.kind === 'local') readers.set(id, createSourceReader(source.root));
      summary.awaitingReview += manifest.holdForReview(id);
    }

    const contents = new Map<string, Content>();
    for (const id of options.sourceIds) {
      for (const row of manifest.uploadCandidates(id, options.retryFailed, options.includeDeleted)) {
        const content = contents.get(row.sha256!) ?? { sha256: row.sha256!, size: row.size ?? 0, rows: [] };
        content.rows.push(row);
        contents.set(row.sha256!, content);
      }
    }
    if (contents.size === 0) {
      view.finish([
        'Nothing to upload: every selected file is already uploaded, deduplicated or waiting for review.',
      ]);
      return summary;
    }

    let offlineSince: number | null = null;
    const retry = async <T>(work: (attempt: number) => Promise<T>) => {
      const result = await withRetry(work, {
        attempts: 8,
        signal,
        apiUrl: options.apiUrl,
        onWaiting: (seconds) => {
          offlineSince = Date.now() - seconds * 1000;
        },
      });
      offlineSince = null;
      return result;
    };

    const trashed = new Set<string>();
    const markRows = (rows: FileRow[], status: 'uploaded' | 'deduplicated', assetId?: string) => {
      for (const row of rows) {
        if (status === 'deduplicated' && trashed.has(row.sha256!)) {
          manifest.setStatus(row.sourceId, row.path, 'in_trash', assetId ? { assetId } : {});
          summary.inTrash += 1;
          continue;
        }
        manifest.setStatus(row.sourceId, row.path, status, assetId ? { assetId } : {});
        if (status === 'uploaded') summary.uploaded += 1;
        else summary.deduplicated += 1;
      }
    };

    const recordOrigins = async (rows: FileRow[]) => {
      for (let start = 0; start < rows.length; start += BATCH) {
        const slice = rows.slice(start, start + BATCH);
        const result = await retry(() =>
          api.recordOrigins(slice.map((row) => ({ sha256: row.sha256!, ...originOf(row) }))),
        );
        const unknown = new Set(result.unknown);
        markRows(
          slice.filter((row) => !unknown.has(row.sha256!)),
          'deduplicated',
        );
      }
    };

    view.render([`Checking ${formatCount(contents.size)} files against your library…`]);
    const all = [...contents.values()];
    const existing = new Set<string>();
    const deleted = new Map<string, string>();
    for (let start = 0; start < all.length && !signal.aborted; start += 1000) {
      const slice = all.slice(start, start + 1000);
      const result = await retry(() => api.checkUploads(slice.map(({ sha256, size }) => ({ sha256, size }))));
      for (const sha256 of result.existing) existing.add(sha256);
      for (const sha256 of result.trashed) trashed.add(sha256);
      for (const row of result.deleted) deleted.set(row.sha256, row.purgedAt);
    }
    const alreadyStored = all.filter((content) => existing.has(content.sha256));
    await recordOrigins(alreadyStored.flatMap((content) => content.rows));

    // Deleted for good by you: said so in the report, not uploaded again unless asked.
    const skippedDeleted = options.includeDeleted
      ? []
      : all.filter((content) => !existing.has(content.sha256) && deleted.has(content.sha256));
    for (const content of skippedDeleted) {
      const on = deleted.get(content.sha256)!.slice(0, 10);
      for (const row of content.rows) {
        manifest.setStatus(row.sourceId, row.path, 'deleted_by_you', {
          error: `Deleted by you from the vault on ${on}; upload with --include-deleted to add it again`,
        });
        summary.deletedByYou += 1;
      }
    }

    const queue = all
      .filter((content) => !existing.has(content.sha256) && !skippedDeleted.includes(content))
      .sort((a, b) => Number(isPhoneOnly(a)) - Number(isPhoneOnly(b)));
    const totalBytes = queue.reduce((sum, content) => sum + content.size, 0);
    const meter = new RateMeter();
    const active = new Map<string, { name: string; size: number; sent: number; stage: string }>();
    const slots = new Slots(options.parallelParts);
    let done = 0;

    function isPhoneOnly(content: Content): boolean {
      return content.rows.every((row) => sources.get(row.sourceId)?.kind === 'phone');
    }

    const redraw = () => {
      const fraction = totalBytes > 0 ? meter.total / totalBytes : 1;
      const eta = meter.etaSeconds(totalBytes - meter.total);
      const lines = [
        `Uploading ${bar(fraction)} ${(fraction * 100).toFixed(1).padStart(5)}%  ${formatBytes(meter.total)} / ${formatBytes(totalBytes)}  ${formatBytes(meter.perSecond())}/s  ETA ${Number.isFinite(eta) ? formatDuration(eta) : '—'}`,
        `  ${formatCount(done)} / ${formatCount(queue.length)} files · ${formatCount(summary.uploaded)} uploaded · ${formatCount(summary.deduplicated)} already stored · ${formatCount(summary.failed)} failed · ${formatCount(summary.awaitingReview)} awaiting review`,
        ...[...active.values()].map((file) => {
          const percent = file.size > 0 ? Math.min(100, (file.sent / file.size) * 100) : 100;
          return `  ↑ ${percent.toFixed(0).padStart(3)}%  ${formatBytes(file.size).padStart(9)}  ${file.stage.padEnd(8)} ${file.name}`;
        }),
      ];
      if (offlineSince !== null)
        lines.push(`  offline for ${formatDuration((Date.now() - offlineSince) / 1000)}, waiting…`);
      view.render(lines);
    };
    const timer = setInterval(redraw, 500);

    async function locate(content: Content): Promise<StagedFile & { row: FileRow }> {
      for (const row of content.rows) {
        const reader = readers.get(row.sourceId);
        if (!reader) continue;
        const stat = await reader.stat(row.path).catch(() => null);
        if (
          stat &&
          stat.size === content.size &&
          (row.mtimeNs === null || stat.mtimeNs.toString() === row.mtimeNs)
        ) {
          return { reader, row, relativePath: row.path, release: () => Promise.resolve() };
        }
      }
      const phoneRow = content.rows.find((row) => sources.get(row.sourceId)?.kind === 'phone');
      if (phoneRow) {
        const staged = await options.stagePhoneFile(sources.get(phoneRow.sourceId)!, phoneRow, signal);
        return { ...staged, row: phoneRow };
      }
      throw new FileChangedError(
        'the file changed or disappeared since it was scanned; run `vault scan` again',
      );
    }

    async function uploadOne(content: Content): Promise<void> {
      const progress = { name: content.rows[0]!.path, size: content.size, sent: 0, stage: 'prepare' };
      active.set(content.sha256, progress);
      const onBytes = (bytes: number) => {
        progress.sent += bytes;
        meter.add(bytes);
      };
      let located: Awaited<ReturnType<typeof locate>> | undefined;
      let succeeded = false;
      try {
        progress.stage = 'locate';
        located = await locate(content);
        const { reader, row, relativePath } = located;
        progress.name = `${row.sourceId}/${row.path}`;
        const request = {
          sha256: content.sha256,
          size: content.size,
          mimeType: mimeTypeOf(row.path),
          origin: originOf(row, reader.absolutePath(relativePath)),
        };
        const created = await retry(() => api.createUpload(request));
        let assetId = created.assetId;
        if (created.mode === 'exists') {
          markRows([row], 'deduplicated', assetId);
        } else if (created.mode === 'single') {
          progress.stage = 'upload';
          const body = await reader.readRange(relativePath, 0, content.size);
          if (sha256Hex(body) !== content.sha256) {
            throw new FileChangedError(
              'content no longer matches its scanned SHA-256; run `vault scan` again',
            );
          }
          await slots.acquire();
          try {
            await retry(async (attempt) => {
              const target =
                attempt === 1
                  ? created.request
                  : ((await api.createUpload(request)) as typeof created).request;
              await putBuffer(target.url, target.headers, body, onBytes);
            });
          } finally {
            slots.release();
          }
          progress.stage = 'verify';
          assetId = (await retry(() => api.completeUpload(created.uploadId))).assetId;
          markRows([row], 'uploaded', assetId);
          summary.uploadedBytes += content.size;
        } else {
          progress.stage = 'resume';
          const uploaded = await retry(() => api.listParts(created.uploadId));
          const have = new Set(uploaded.parts.map((part) => part.partNumber));
          for (const part of uploaded.parts) onBytes(part.size);
          progress.stage = 'upload';
          const missing = Array.from({ length: created.partCount }, (_, index) => index + 1).filter(
            (partNumber) => !have.has(partNumber),
          );
          await runPool(
            missing,
            options.parallelParts,
            async (partNumber) => {
              await slots.acquire();
              try {
                if (signal.aborted) return;
                const start = (partNumber - 1) * created.partSize;
                const length = Math.min(created.partSize, content.size - start);
                const data = await reader.readRange(relativePath, start, length);
                const sha256 = sha256Base64(data);
                await retry(async () => {
                  const signed = await api.presignParts(created.uploadId, [{ partNumber, sha256 }]);
                  const target = signed.parts[0]!;
                  await putBuffer(target.url, target.headers, data, onBytes);
                });
              } finally {
                slots.release();
              }
            },
            signal,
          );
          if (signal.aborted) return;
          const after = await reader.stat(relativePath);
          if (row.mtimeNs !== null && after.mtimeNs.toString() !== row.mtimeNs) {
            throw new FileChangedError('the file was modified during upload; run `vault scan` again');
          }
          progress.stage = 'verify';
          const parts = (await retry(() => api.listParts(created.uploadId))).parts;
          const completed = await retry(() =>
            api.completeUpload(
              created.uploadId,
              parts.map(({ partNumber, etag, sha256 }) => ({ partNumber, etag, sha256 })),
            ),
          );
          assetId = completed.assetId;
          markRows([row], 'uploaded', assetId);
          summary.uploadedBytes += content.size;
        }
        const others = content.rows.filter((other) => other !== row);
        if (others.length > 0) await recordOrigins(others);
        succeeded = true;
      } catch (error) {
        if (signal.aborted) return;
        summary.failed += content.rows.length;
        for (const row of content.rows) {
          manifest.setStatus(row.sourceId, row.path, 'failed', { error: errorMessage(error) });
        }
        meter.add(-progress.sent);
      } finally {
        await located?.release(succeeded).catch(() => undefined);
        active.delete(content.sha256);
        done += 1;
      }
    }

    try {
      await runPool(queue, options.parallelFiles, uploadOne, signal);
    } finally {
      clearInterval(timer);
    }
    summary.interrupted = signal.aborted;
    view.finish([
      summary.interrupted
        ? `Paused. ${formatCount(summary.uploaded)} files uploaded so far; run the same command again to resume.`
        : `Done in ${formatDuration(meter.elapsedSeconds())}: ${formatCount(summary.uploaded)} uploaded (${formatBytes(summary.uploadedBytes)}), ${formatCount(summary.deduplicated)} already stored, ${formatCount(summary.failed)} failed, ${formatCount(summary.awaitingReview)} awaiting your review${summary.inTrash ? `, ${formatCount(summary.inTrash)} in your Trash` : ''}${summary.deletedByYou ? `, ${formatCount(summary.deletedByYou)} deleted by you before (not uploaded)` : ''}.`,
    ]);
    return summary;
  } finally {
    dispose();
  }
}
