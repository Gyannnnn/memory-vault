import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import sharp from 'sharp';
import { createSourceReader, type SourceReader } from '@memory-vault/media';
import { mimeTypeOf, type SourceId } from '@memory-vault/shared';
import type { FileRow, Manifest, SourceRow } from '../manifest/manifest';
import type { StagedFile } from '../upload/engine';
import { groupOf } from './groups';

export interface ReviewServerOptions {
  manifest: Manifest;
  sourceIds: SourceId[];
  staticDir: string;
  cacheDir: string;
  stagePhoneFile: (source: SourceRow, row: FileRow, signal: AbortSignal) => Promise<StagedFile>;
  port?: number;
}

type Decision = 'approved' | 'skipped' | null;

const encodeId = (sourceId: string, path: string) =>
  Buffer.from(JSON.stringify([sourceId, path])).toString('base64url');
function decodeId(id: string): [string, string] | null {
  try {
    const value = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string')
      ? (value as [string, string])
      : null;
  } catch {
    return null;
  }
}

const PREVIEWABLE_IMAGES = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif']);
const PLAYABLE_VIDEOS = new Set(['mp4', 'm4v', 'mov', 'webm', '3gp']);
const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function previewKind(row: FileRow): 'image' | 'video' | 'none' {
  const extension = row.ext ?? '';
  if (row.size === 0) return 'none';
  if (PREVIEWABLE_IMAGES.has(extension)) return 'image';
  if (PLAYABLE_VIDEOS.has(extension)) return 'video';
  return 'none';
}

class Gate {
  private waiting: (() => void)[] = [];
  constructor(private free: number) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}

export async function startReviewServer(
  options: ReviewServerOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  const token = randomBytes(24).toString('base64url');
  const { manifest } = options;
  const sources = new Map(options.sourceIds.map((id) => [id, manifest.getSource(id)!] as const));
  const readers = new Map<string, SourceReader>();
  for (const [id, source] of sources)
    if (source.kind === 'local') readers.set(id, createSourceReader(source.root));
  const pulls = new Gate(3);
  const thumbnails = new Gate(4);
  const abort = new AbortController();
  mkdirSync(options.cacheDir, { recursive: true });

  async function locate(row: FileRow): Promise<{ reader: SourceReader; path: string }> {
    const local = readers.get(row.sourceId);
    if (local) return { reader: local, path: row.path };
    const staged = await pulls.run(() =>
      options.stagePhoneFile(sources.get(row.sourceId)!, row, abort.signal),
    );
    return { reader: staged.reader, path: staged.relativePath };
  }

  function summary() {
    const items = manifest.reviewItems(options.sourceIds);
    const byGroup = new Map<
      string,
      {
        key: string;
        label: string;
        hint: string;
        order: number;
        count: number;
        bytes: number;
        approved: number;
        skipped: number;
        keptElsewhere: number;
      }
    >();
    for (const item of items) {
      const group = groupOf(item);
      const entry = byGroup.get(group.key) ?? {
        ...group,
        count: 0,
        bytes: 0,
        approved: 0,
        skipped: 0,
        keptElsewhere: 0,
      };
      entry.count += 1;
      entry.bytes += item.size ?? 0;
      if (item.decision === 'approved') entry.approved += 1;
      if (item.decision === 'skipped') entry.skipped += 1;
      if (item.keptElsewhere) entry.keptElsewhere += 1;
      byGroup.set(group.key, entry);
    }
    return {
      sources: [...sources.values()].map((source) => ({
        id: source.id,
        kind: source.kind,
        root: source.root,
      })),
      groups: [...byGroup.values()].sort((a, b) => a.order - b.order),
      total: items.length,
      decided: items.filter((item) => item.decision !== null).length,
    };
  }

  function items(groupKey: string) {
    return manifest
      .reviewItems(options.sourceIds)
      .filter((item) => groupOf(item).key === groupKey)
      .map((item) => ({
        id: encodeId(item.sourceId, item.path),
        sourceId: item.sourceId,
        path: item.path,
        name: item.path.slice(item.path.lastIndexOf('/') + 1),
        kind: item.kind,
        size: item.size,
        modifiedAt: item.mtimeMs ? new Date(item.mtimeMs).toISOString() : null,
        decision: item.decision,
        keptElsewhere: item.keptElsewhere,
        preview: previewKind(item),
        junkScore: item.junkScore,
        junkLabel: item.junkLabel,
      }));
  }

  function rowFor(id: string): FileRow | null {
    const decoded = decodeId(id);
    if (!decoded || !sources.has(decoded[0])) return null;
    const row = manifest.file(decoded[0], decoded[1]);
    return row && row.route === 'review' ? row : null;
  }

  async function preview(row: FileRow): Promise<Buffer | null> {
    if (previewKind(row) !== 'image' || !row.sha256) return null;
    const cached = join(options.cacheDir, `${row.sha256}.webp`);
    if (existsSync(cached)) return readFileSync(cached);
    return thumbnails.run(async () => {
      const { reader, path } = await locate(row);
      const data = await sharp(reader.absolutePath(path), { failOn: 'none', animated: false })
        .rotate()
        .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 72 })
        .toBuffer();
      writeFileSync(cached, data);
      return data;
    });
  }

  async function sendOriginal(row: FileRow, request: http.IncomingMessage, response: http.ServerResponse) {
    const { reader, path } = await locate(row);
    const size = row.size ?? 0;
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    const headers = {
      'content-type': mimeTypeOf(row.path),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    };
    if (range && size > 0) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
        return;
      }
      response.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      reader.openRead(path, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, 'content-length': size });
    reader.openRead(path).pipe(response);
  }

  function authorised(request: http.IncomingMessage): boolean {
    const cookie = /(?:^|;\s*)vault_review=([^;]+)/.exec(request.headers.cookie ?? '')?.[1] ?? '';
    return cookie.length === token.length && timingSafeEqual(Buffer.from(cookie), Buffer.from(token));
  }

  async function readJson(request: http.IncomingMessage): Promise<unknown> {
    let body = '';
    for await (const chunk of request) {
      body += String(chunk);
      if (body.length > 5_000_000) throw new Error('request too large');
    }
    return JSON.parse(body) as unknown;
  }

  const json = (response: http.ServerResponse, status: number, value: unknown) =>
    response
      .writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(value));

  const server = http.createServer((request, response) => {
    void (async () => {
      const host = (request.headers.host ?? '').replace(/:\d+$/, '');
      if (host !== '127.0.0.1' && host !== 'localhost') return json(response, 403, { error: 'wrong host' });
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');

      if (url.pathname === '/' && url.searchParams.get('t') === token) {
        response
          .writeHead(302, {
            'set-cookie': `vault_review=${token}; HttpOnly; SameSite=Strict; Path=/`,
            location: '/',
          })
          .end();
        return;
      }
      if (!authorised(request))
        return json(response, 401, { error: 'open the link printed by `vault review`' });

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/assets/'))) {
        const file = url.pathname === '/' ? 'index.html' : normalize(url.pathname.slice('/assets/'.length));
        if (file.startsWith('..')) return json(response, 404, { error: 'not found' });
        const path = join(options.staticDir, file);
        if (!existsSync(path)) return json(response, 404, { error: 'not found' });
        response.writeHead(200, {
          'content-type': STATIC_TYPES[extname(path)] ?? 'application/octet-stream',
          'content-security-policy':
            "default-src 'self'; img-src 'self' blob:; media-src 'self'; style-src 'self'",
          'x-content-type-options': 'nosniff',
        });
        createReadStream(path).pipe(response);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/summary') return json(response, 200, summary());
      if (request.method === 'GET' && url.pathname === '/api/items') {
        return json(response, 200, { items: items(url.searchParams.get('group') ?? '') });
      }
      const match = /^\/api\/(preview|original)\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const row = rowFor(match[2]!);
        if (!row) return json(response, 404, { error: 'not found' });
        if (match[1] === 'original') return sendOriginal(row, request, response);
        const data = await preview(row);
        if (!data) return json(response, 415, { error: 'no preview for this type' });
        response
          .writeHead(200, { 'content-type': 'image/webp', 'cache-control': 'private, max-age=86400' })
          .end(data);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/decisions') {
        const body = (await readJson(request)) as { ids?: unknown; decision?: unknown };
        const decision = body.decision as Decision;
        if (!Array.isArray(body.ids) || !['approved', 'skipped', null].includes(decision)) {
          return json(response, 400, {
            error: 'expected { ids: string[], decision: "approved" | "skipped" | null }',
          });
        }
        let changed = 0;
        manifest.transaction(() => {
          for (const id of body.ids as unknown[]) {
            const row = typeof id === 'string' ? rowFor(id) : null;
            if (!row) continue;
            manifest.setDecision(row.sourceId, row.path, decision);
            changed += 1;
          }
        });
        return json(response, 200, { changed });
      }
      return json(response, 404, { error: 'not found' });
    })().catch((error: unknown) => {
      if (!response.headersSent)
        json(response, 500, { error: error instanceof Error ? error.message : String(error) });
      else response.destroy();
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/?t=${token}`,
    close: () =>
      new Promise((resolve) => {
        abort.abort();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
