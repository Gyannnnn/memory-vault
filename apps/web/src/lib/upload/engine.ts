import { mimeTypeOf } from '@memory-vault/shared';

/**
 * Uploads from the browser, through the same API as the CLI: every file is hashed (SHA-256)
 * first; content already in the vault only has its location recorded; new content goes
 * straight to S3 through presigned requests, in parts for large files. A multipart upload
 * that was interrupted (even by a reload) carries on from the parts S3 already holds once
 * the same file is chosen again. Plain TypeScript, so it can be tested without a browser.
 */

export type UploadStatus = 'queued' | 'hashing' | 'uploading' | 'paused' | 'done' | 'duplicate' | 'failed';

export interface UploadItem {
  id: string;
  name: string;
  /** Path inside what was chosen, e.g. "Trip/IMG_1.jpg". */
  path: string;
  size: number;
  status: UploadStatus;
  /** Bytes hashed so far. */
  hashed: number;
  /** Bytes in S3 so far (parts already there when resuming count too). */
  sent: number;
  error?: string;
}

export interface UploadSnapshot {
  items: readonly UploadItem[];
  paused: boolean;
  /** Something is hashing or uploading. */
  busy: boolean;
  totalBytes: number;
  /** Bytes that are uploaded, or didn't need to be (already in the vault). */
  doneBytes: number;
  bytesPerSecond: number;
  /** Seconds left at the current speed; null while unknown. */
  etaSeconds: number | null;
  counts: Record<UploadStatus, number>;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

type CreateResponse =
  | { mode: 'exists'; assetId: string }
  | { mode: 'single'; uploadId: string; assetId: string; request: SignedRequest }
  | { mode: 'multipart'; uploadId: string; assetId: string; partSize: number; partCount: number };

interface StoredPart {
  partNumber: number;
  etag: string;
  sha256: string;
  size: number;
}

/** What the engine needs from the outside world; the browser and the tests each provide one. */
export interface UploadTransport {
  /** SHA-256 of the whole file, lowercase hex. */
  hash(file: Blob, onProgress: (bytes: number) => void, signal: AbortSignal): Promise<string>;
  /** SHA-256 of one part, base64 (what S3 checks). */
  hashPart(blob: Blob): Promise<string>;
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
  put(
    request: SignedRequest,
    body: Blob,
    onProgress: (sent: number) => void,
    signal: AbortSignal,
  ): Promise<{ etag: string | null }>;
}

export interface UploadOptions {
  /** Which source the files are recorded under (Folders shows it as "Web uploads · …"). */
  sourceId: string;
  /** Files uploading at once. */
  files: number;
  /** Parts of one file uploading at once. */
  parts: number;
}

const FINAL: ReadonlySet<UploadStatus> = new Set(['done', 'duplicate', 'failed']);
const HALF_LIFE_SECONDS = 4;

interface Entry {
  item: UploadItem;
  file: File;
  sha256?: string;
  controller?: AbortController;
}

export class UploadManager {
  private readonly entries: Entry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly inflight = new Map<string, Promise<void>>();
  private snapshot: UploadSnapshot;
  private paused = false;
  private running = 0;
  private sequence = 0;
  private rate = 0;
  private lastSample = { at: 0, bytes: 0 };

  constructor(
    private readonly transport: UploadTransport,
    private readonly options: UploadOptions = { sourceId: 'web:browser', files: 2, parts: 3 },
    private readonly now: () => number = () => Date.now(),
  ) {
    this.snapshot = this.build();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): UploadSnapshot => this.snapshot;

  /** Adds files; the same file chosen twice while still queued is only added once. */
  add(chosen: { file: File; path: string }[]): void {
    for (const { file, path } of chosen) {
      const duplicate = this.entries.some(
        (entry) =>
          !FINAL.has(entry.item.status) &&
          entry.item.path === path &&
          entry.file.size === file.size &&
          entry.file.lastModified === file.lastModified,
      );
      if (duplicate) continue;
      this.sequence += 1;
      this.entries.push({
        file,
        item: {
          id: String(this.sequence),
          name: file.name,
          path,
          size: file.size,
          status: 'queued',
          hashed: 0,
          sent: 0,
        },
      });
    }
    this.changed();
    this.pump();
  }

  pause(): void {
    this.paused = true;
    for (const entry of this.entries) entry.controller?.abort();
    this.changed();
  }

  resume(): void {
    this.paused = false;
    for (const entry of this.entries) if (entry.item.status === 'paused') entry.item.status = 'queued';
    this.changed();
    this.pump();
  }

  retry(id: string): void {
    const entry = this.entries.find((candidate) => candidate.item.id === id);
    if (!entry || entry.item.status !== 'failed') return;
    entry.item = { ...entry.item, status: 'queued', error: undefined };
    this.changed();
    this.pump();
  }

  /** Tries every failed file again. */
  retryFailed(): void {
    for (const entry of this.entries)
      if (entry.item.status === 'failed') entry.item = { ...entry.item, status: 'queued', error: undefined };
    this.changed();
    this.pump();
  }

  /** Forgets finished files (done, already in the vault); failed ones stay to be retried. */
  clearFinished(): void {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const status = this.entries[index]!.item.status;
      if (status === 'done' || status === 'duplicate') this.entries.splice(index, 1);
    }
    this.changed();
  }

  private pump(): void {
    while (!this.paused && this.running < this.options.files) {
      const next = this.entries.find((entry) => entry.item.status === 'queued');
      if (!next) return;
      this.running += 1;
      void this.run(next).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  private update(entry: Entry, patch: Partial<UploadItem>): void {
    entry.item = { ...entry.item, ...patch };
    this.changed();
  }

  private async run(entry: Entry): Promise<void> {
    const controller = new AbortController();
    entry.controller = controller;
    const { signal } = controller;
    try {
      if (!entry.sha256) {
        this.update(entry, { status: 'hashing', hashed: 0 });
        entry.sha256 = await this.transport.hash(
          entry.file,
          (hashed) => this.update(entry, { hashed }),
          signal,
        );
        this.update(entry, { hashed: entry.file.size });
      }
      // The same content twice in one batch: let the first finish, then record the second's location.
      const sha256 = entry.sha256;
      const earlier = this.inflight.get(sha256);
      if (earlier) await earlier.catch(() => undefined);
      const work = this.upload(entry, sha256, signal);
      this.inflight.set(sha256, work);
      try {
        await work;
      } finally {
        if (this.inflight.get(sha256) === work) this.inflight.delete(sha256);
      }
    } catch (error) {
      if (signal.aborted) {
        this.update(entry, { status: 'paused' });
      } else {
        this.update(entry, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      entry.controller = undefined;
    }
  }

  private async upload(entry: Entry, sha256: string, signal: AbortSignal): Promise<void> {
    const { file } = entry;
    this.update(entry, { status: 'uploading' });
    const created = await this.transport.api<CreateResponse>('/uploads', {
      method: 'POST',
      body: {
        sha256,
        size: file.size,
        mimeType: file.type || mimeTypeOf(entry.item.path),
        origin: {
          sourceId: this.options.sourceId,
          path: entry.item.path,
          modifiedAt: new Date(file.lastModified || Date.now()).toISOString(),
        },
      },
    });
    signal.throwIfAborted();

    if (created.mode === 'exists') {
      this.update(entry, { status: 'duplicate', sent: file.size });
      return;
    }
    if (created.mode === 'single') {
      await this.transport.put(created.request, file, (sent) => this.progress(entry, sent), signal);
      await this.transport.api(`/uploads/${created.uploadId}/complete`, { method: 'POST', body: {} });
      this.update(entry, { status: 'done', sent: file.size });
      return;
    }

    // Multipart: skip what S3 already has (an earlier, interrupted try), then send the rest.
    const { parts: stored } = await this.transport.api<{ parts: StoredPart[] }>(
      `/uploads/${created.uploadId}/parts`,
    );
    const done = new Map(stored.map((part) => [part.partNumber, part]));
    const sentBefore = stored.reduce((sum, part) => sum + part.size, 0);
    const inFlight = new Map<number, number>();
    let sentNow = 0;
    const report = () =>
      this.progress(
        entry,
        sentBefore + sentNow + [...inFlight.values()].reduce((sum, value) => sum + value, 0),
      );
    report();

    const waiting = Array.from({ length: created.partCount }, (_, index) => index + 1).filter(
      (number) => !done.has(number),
    );
    const lane = async () => {
      for (let number = waiting.shift(); number !== undefined; number = waiting.shift()) {
        signal.throwIfAborted();
        const start = (number - 1) * created.partSize;
        const blob = file.slice(start, Math.min(file.size, start + created.partSize));
        const partSha = await this.transport.hashPart(blob);
        const { parts } = await this.transport.api<{ parts: ({ partNumber: number } & SignedRequest)[] }>(
          `/uploads/${created.uploadId}/parts`,
          { method: 'POST', body: { parts: [{ partNumber: number, sha256: partSha }] } },
        );
        const signed = parts[0]!;
        inFlight.set(number, 0);
        const { etag } = await this.transport.put(
          { url: signed.url, headers: signed.headers },
          blob,
          (sent) => {
            inFlight.set(number, sent);
            report();
          },
          signal,
        );
        inFlight.delete(number);
        if (!etag) throw new Error('S3 did not return the part’s ETag');
        done.set(number, { partNumber: number, etag, sha256: partSha, size: blob.size });
        sentNow += blob.size;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.options.parts, waiting.length || 1) }, lane));
    await this.transport.api(`/uploads/${created.uploadId}/complete`, {
      method: 'POST',
      body: {
        parts: [...done.values()]
          .sort((a, b) => a.partNumber - b.partNumber)
          .map(({ partNumber, etag, sha256 }) => ({ partNumber, etag, sha256 })),
      },
    });
    this.update(entry, { status: 'done', sent: file.size });
  }

  private progress(entry: Entry, sent: number): void {
    this.update(entry, { sent: Math.min(entry.item.size, sent) });
  }

  private changed(): void {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }

  private build(): UploadSnapshot {
    const items = this.entries.map((entry) => entry.item);
    const counts = { queued: 0, hashing: 0, uploading: 0, paused: 0, done: 0, duplicate: 0, failed: 0 };
    let totalBytes = 0;
    let doneBytes = 0;
    for (const item of items) {
      counts[item.status] += 1;
      if (item.status === 'failed') continue;
      totalBytes += item.size;
      doneBytes += item.status === 'done' || item.status === 'duplicate' ? item.size : item.sent;
    }
    // Upload speed, smoothed: only bytes actually sent count, not files already in the vault.
    const sentNow = items.reduce((sum, item) => sum + (item.status === 'duplicate' ? 0 : item.sent), 0);
    const now = this.now();
    if (this.lastSample.at === 0) this.lastSample = { at: now, bytes: sentNow };
    const elapsed = (now - this.lastSample.at) / 1000;
    if (elapsed >= 0.5) {
      const instant = Math.max(0, sentNow - this.lastSample.bytes) / elapsed;
      const alpha = 1 - Math.pow(0.5, elapsed / HALF_LIFE_SECONDS);
      this.rate = this.rate === 0 ? instant : this.rate + alpha * (instant - this.rate);
      this.lastSample = { at: now, bytes: sentNow };
    }
    const busy = counts.hashing + counts.uploading > 0;
    if (!busy) this.rate = 0;
    const remaining = totalBytes - doneBytes;
    return {
      items,
      paused: this.paused,
      busy,
      totalBytes,
      doneBytes,
      bytesPerSecond: this.rate,
      etaSeconds: busy && this.rate > 0 ? remaining / this.rate : null,
      counts,
    };
  }
}
