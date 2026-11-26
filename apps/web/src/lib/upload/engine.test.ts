import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UploadManager, type SignedRequest, type UploadTransport } from './engine';

const PART = 10;
const SINGLE_MAX = 16;

interface Session {
  id: string;
  sha256: string;
  size: number;
  parts: Map<number, { etag: string; sha256: string; size: number }>;
  multipart: boolean;
  path: string;
}

/** The upload API and S3, as far as the browser can tell: same answers, same checks. */
class FakeVault implements UploadTransport {
  readonly stored = new Map<string, Buffer>();
  /** Stored, but in Trash. */
  readonly trashed = new Set<string>();
  /** Deleted for good: content hash → when. */
  readonly deleted = new Map<string, string>();
  readonly paths: string[] = [];
  readonly sessions = new Map<string, Session>();
  readonly puts: string[] = [];
  failNextPut = false;
  /** Called before each part PUT; may abort the test's manager. */
  beforePut?: (url: string) => void;

  async hash(file: Blob, onProgress: (bytes: number) => void): Promise<string> {
    const bytes = Buffer.from(await file.arrayBuffer());
    onProgress(bytes.length);
    return createHash('sha256').update(bytes).digest('hex');
  }

  async hashPart(blob: Blob): Promise<string> {
    return createHash('sha256')
      .update(Buffer.from(await blob.arrayBuffer()))
      .digest('base64');
  }

  api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    // Answers on a later tick, like a network call would.
    return Promise.resolve().then(() => this.answer<T>(path, init));
  }

  private answer<T>(path: string, init: { method?: string; body?: unknown }): T {
    const body = init.body as Record<string, unknown> | undefined;
    if (path === '/uploads/check') {
      const [{ sha256 }] = (body as { items: { sha256: string }[] }).items as [{ sha256: string }];
      return {
        existing: this.stored.has(sha256) ? [sha256] : [],
        trashed: this.trashed.has(sha256) ? [sha256] : [],
        deleted: this.deleted.has(sha256) ? [{ sha256, purgedAt: this.deleted.get(sha256)! }] : [],
      } as T;
    }
    if (path === '/uploads') {
      const { sha256, size, origin } = body as { sha256: string; size: number; origin: { path: string } };
      if (this.stored.has(sha256)) {
        this.paths.push(origin.path);
        return { mode: 'exists', assetId: sha256 } as T;
      }
      let session = [...this.sessions.values()].find((open) => open.sha256 === sha256);
      if (!session) {
        session = {
          id: `u${this.sessions.size + 1}`,
          sha256,
          size,
          parts: new Map(),
          multipart: size > SINGLE_MAX,
          path: origin.path,
        };
        this.sessions.set(session.id, session);
      }
      if (!session.multipart)
        return {
          mode: 'single',
          uploadId: session.id,
          assetId: sha256,
          request: {
            url: `s3://${session.id}/whole`,
            headers: { 'x-amz-checksum-sha256': Buffer.from(sha256, 'hex').toString('base64') },
          },
        } as T;
      return {
        mode: 'multipart',
        uploadId: session.id,
        assetId: sha256,
        partSize: PART,
        partCount: Math.ceil(size / PART),
      } as T;
    }
    const [, , id, action] = path.split('/');
    const session = this.sessions.get(id!)!;
    if (action === 'parts' && init.method !== 'POST')
      return { parts: [...session.parts].map(([partNumber, part]) => ({ partNumber, ...part })) } as T;
    if (action === 'parts') {
      const { partNumber, sha256 } = (body as { parts: { partNumber: number; sha256: string }[] }).parts[0]!;
      return {
        parts: [
          { partNumber, url: `s3://${id}/part/${partNumber}`, headers: { 'x-amz-checksum-sha256': sha256 } },
        ],
      } as T;
    }
    if (action === 'complete') {
      const assembled = session.multipart
        ? Buffer.concat(
            (body as { parts: { partNumber: number; etag: string }[] }).parts.map(({ partNumber, etag }) => {
              const part = session.parts.get(partNumber)!;
              expect(etag).toBe(part.etag);
              return this.partBytes.get(`${id}/${partNumber}`)!;
            }),
          )
        : this.partBytes.get(`${id}/whole`)!;
      expect(createHash('sha256').update(assembled).digest('hex')).toBe(session.sha256);
      this.stored.set(session.sha256, assembled);
      this.paths.push(session.path);
      this.sessions.delete(id!);
      return { assetId: session.sha256 } as T;
    }
    throw new Error(`unexpected ${path}`);
  }

  private readonly partBytes = new Map<string, Buffer>();

  async put(request: SignedRequest, body: Blob, onProgress: (sent: number) => void, signal: AbortSignal) {
    this.beforePut?.(request.url);
    signal.throwIfAborted();
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('network went away');
    }
    const bytes = Buffer.from(await body.arrayBuffer());
    // S3 checks the declared checksum.
    expect(createHash('sha256').update(bytes).digest('base64')).toBe(
      request.headers['x-amz-checksum-sha256'],
    );
    onProgress(bytes.length);
    const [, , id, kind, number] = request.url.split('/');
    this.puts.push(request.url);
    this.partBytes.set(kind === 'part' ? `${id}/${number}` : `${id}/whole`, bytes);
    if (kind === 'part')
      this.sessions.get(id!)!.parts.set(Number(number), {
        etag: `etag-${number}`,
        sha256: request.headers['x-amz-checksum-sha256']!,
        size: bytes.length,
      });
    return { etag: kind === 'part' ? `etag-${number}` : null };
  }
}

const file = (name: string, text: string) => new File([text], name, { lastModified: 1_700_000_000_000 });

async function settled(manager: UploadManager) {
  for (let i = 0; i < 200; i += 1) {
    const { counts } = manager.getSnapshot();
    if (counts.queued + counts.hashing + counts.uploading === 0) return manager.getSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('uploads did not settle');
}

describe('browser uploads', () => {
  it('uploads new files whole or in parts, and only records the location of known content', async () => {
    const vault = new FakeVault();
    vault.stored.set(createHash('sha256').update('already here').digest('hex'), Buffer.from('already here'));
    const manager = new UploadManager(vault, { sourceId: 'web:browser', files: 2, parts: 2 });
    manager.add([
      { file: file('small.jpg', 'tiny photo'), path: 'Trip/small.jpg' },
      { file: file('big.mp4', 'a video longer than sixteen bytes, in parts'), path: 'Trip/big.mp4' },
      { file: file('known.jpg', 'already here'), path: 'Trip/known.jpg' },
    ]);
    const snapshot = await settled(manager);
    expect(snapshot.items.map((item) => [item.path, item.status])).toEqual([
      ['Trip/small.jpg', 'done'],
      ['Trip/big.mp4', 'done'],
      ['Trip/known.jpg', 'duplicate'],
    ]);
    expect(
      vault.stored
        .get(createHash('sha256').update('a video longer than sixteen bytes, in parts').digest('hex'))
        ?.toString(),
    ).toBe('a video longer than sixteen bytes, in parts');
    expect(vault.puts.filter((url) => url.includes('/part/'))).toHaveLength(5);
    expect(vault.paths.sort()).toEqual(['Trip/big.mp4', 'Trip/known.jpg', 'Trip/small.jpg']);
    expect(snapshot.doneBytes).toBe(snapshot.totalBytes);
  });

  it('carries on from the parts S3 already has after a reload', async () => {
    const vault = new FakeVault();
    const content = 'x'.repeat(45);
    const first = new UploadManager(vault, { sourceId: 'web:browser', files: 1, parts: 1 });
    let parts = 0;
    vault.beforePut = () => {
      parts += 1;
      if (parts === 3) first.pause();
    };
    first.add([{ file: file('long.mov', content), path: 'long.mov' }]);
    await settled(first);
    expect(first.getSnapshot().items[0]!.status).toBe('paused');
    expect([...vault.sessions.values()][0]!.parts.size).toBe(2);

    // A new page: the same file chosen again.
    vault.beforePut = undefined;
    vault.puts.length = 0;
    const second = new UploadManager(vault, { sourceId: 'web:browser', files: 1, parts: 1 });
    second.add([{ file: file('long.mov', content), path: 'long.mov' }]);
    const snapshot = await settled(second);
    expect(snapshot.items[0]!.status).toBe('done');
    expect(vault.puts).toEqual(['s3://u1/part/3', 's3://u1/part/4', 's3://u1/part/5']);
    expect(vault.stored.get(createHash('sha256').update(content).digest('hex'))?.toString()).toBe(content);
  });

  it('uploads content chosen twice only once', async () => {
    const vault = new FakeVault();
    const manager = new UploadManager(vault, { sourceId: 'web:browser', files: 2, parts: 2 });
    manager.add([
      { file: file('a.jpg', 'same bytes'), path: 'One/a.jpg' },
      { file: file('b.jpg', 'same bytes'), path: 'Two/b.jpg' },
    ]);
    const snapshot = await settled(manager);
    expect(snapshot.items.map((item) => item.status).sort()).toEqual(['done', 'duplicate']);
    expect(vault.puts).toHaveLength(1);
    expect(vault.paths.sort()).toEqual(['One/a.jpg', 'Two/b.jpg']);
  });

  it('says what is in Trash or was deleted before, and uploads the deleted one only when asked', async () => {
    const vault = new FakeVault();
    const sha = (text: string) => createHash('sha256').update(text).digest('hex');
    vault.stored.set(sha('in the bin'), Buffer.from('in the bin'));
    vault.trashed.add(sha('in the bin'));
    vault.deleted.set(sha('gone for good'), '2026-11-20T10:00:00.000Z');
    const manager = new UploadManager(vault, { sourceId: 'web:browser', files: 2, parts: 2 });
    manager.add([
      { file: file('bin.jpg', 'in the bin'), path: 'bin.jpg' },
      { file: file('gone.jpg', 'gone for good'), path: 'gone.jpg' },
    ]);
    const first = await settled(manager);
    expect(first.items.map((item) => [item.path, item.status, item.deletedOn])).toEqual([
      ['bin.jpg', 'trashed', undefined],
      ['gone.jpg', 'deleted', '2026-11-20T10:00:00.000Z'],
    ]);
    expect(vault.stored.has(sha('gone for good'))).toBe(false);
    expect(first.doneBytes).toBe(first.totalBytes);

    manager.uploadAnyway(first.items[1]!.id);
    const second = await settled(manager);
    expect(vault.puts).toHaveLength(1);
    expect(second.items[1]!.status).toBe('done');
    expect(vault.stored.get(sha('gone for good'))?.toString()).toBe('gone for good');
  });

  it('marks a failed file, and retries it on request', async () => {
    const vault = new FakeVault();
    vault.failNextPut = true;
    const manager = new UploadManager(vault, { sourceId: 'web:browser', files: 1, parts: 1 });
    manager.add([{ file: file('x.jpg', 'flaky'), path: 'x.jpg' }]);
    const failed = await settled(manager);
    expect(failed.items[0]).toMatchObject({ status: 'failed', error: 'network went away' });
    expect(failed.totalBytes).toBe(0);
    manager.retry(failed.items[0]!.id);
    expect((await settled(manager)).items[0]!.status).toBe('done');
  });

  it('pauses everything and picks up where it was on resume', async () => {
    const vault = new FakeVault();
    const manager = new UploadManager(vault, { sourceId: 'web:browser', files: 1, parts: 1 });
    vault.beforePut = (url) => {
      if (url.endsWith('/part/2')) manager.pause();
    };
    manager.add([{ file: file('v.mp4', 'y'.repeat(30)), path: 'v.mp4' }]);
    const paused = await settled(manager);
    expect(paused.paused).toBe(true);
    expect(paused.items[0]!.status).toBe('paused');
    vault.beforePut = undefined;
    manager.resume();
    const snapshot = await settled(manager);
    expect(snapshot.items[0]!.status).toBe('done');
    expect(vault.puts).toEqual(['s3://u1/part/1', 's3://u1/part/2', 's3://u1/part/3']);
  });
});
