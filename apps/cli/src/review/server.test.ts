import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { scanLocalSource } from '../commands/scan';
import { Manifest } from '../manifest/manifest';
import { startReviewServer } from './server';

vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

let manifest: Manifest;
let server: Awaited<ReturnType<typeof startReviewServer>>;
let origin: string;
let cookie: string;

function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>(
    (resolve, reject) => {
      const url = new URL(path, origin);
      http
        .get(url, { headers: { cookie, ...headers } }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () =>
            resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks) }),
          );
        })
        .on('error', reject);
    },
  );
}

async function post(path: string, body: unknown) {
  const response = await fetch(new URL(path, origin), {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), 'vault-review-'));
  mkdirSync(join(root, 'WhatsApp Images/Sent'), { recursive: true });
  mkdirSync(join(root, 'Camera'));
  const photo = await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#7a5' } })
    .jpeg()
    .toBuffer();
  writeFileSync(join(root, 'WhatsApp Images/IMG-20240101-WA0001.jpg'), photo);
  writeFileSync(
    join(root, 'WhatsApp Images/Sent/IMG-20240101-WA0002.jpg'),
    Buffer.concat([photo, Buffer.from('x')]),
  );
  writeFileSync(join(root, 'Camera/IMG_1.jpg'), Buffer.concat([photo, Buffer.from('y')]));
  writeFileSync(join(root, 'Camera/.temp-1.mp4'), '');
  const ui = mkdtempSync(join(tmpdir(), 'vault-review-ui-'));
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Review</title>');
  mkdirSync(join(ui, 'assets'));
  writeFileSync(join(ui, 'assets/app.css'), 'body{}');

  manifest = new Manifest(':memory:');
  await scanLocalSource(manifest, 'laptop:review', root);
  server = await startReviewServer({
    manifest,
    sourceIds: ['laptop:review'],
    staticDir: ui,
    cacheDir: mkdtempSync(join(tmpdir(), 'vault-review-cache-')),
    stagePhoneFile: () => Promise.reject(new Error('no phone')),
  });
  origin = new URL(server.url).origin;
  cookie = '';
});
afterAll(async () => {
  await server.close();
});

describe('review server', () => {
  it('requires the one-time link, then a cookie', async () => {
    expect((await get('/api/summary')).status).toBe(401);
    expect((await get('/?t=wrong')).status).toBe(401);
    const signIn = await get(new URL(server.url).pathname + new URL(server.url).search);
    expect(signIn.status).toBe(302);
    cookie = String(signIn.headers['set-cookie']).split(';')[0]!;
    expect((await get('/')).status).toBe(200);
    const css = await get('/assets/app.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect((await get('/assets/../../etc/passwd')).status).toBe(404);
  });

  it('refuses other host names (DNS rebinding)', async () => {
    expect((await get('/api/summary', { host: 'evil.example' })).status).toBe(403);
  });

  it('groups review files and leaves direct uploads out', async () => {
    const summary = JSON.parse((await get('/api/summary')).body.toString()) as {
      total: number;
      groups: { key: string; count: number }[];
    };
    expect(summary.total).toBe(3);
    expect(summary.groups.map((group) => [group.key, group.count])).toEqual([
      ['whatsapp-sent', 1],
      ['whatsapp-received', 1],
      ['temp-file', 1],
    ]);
  });

  it('serves previews and byte ranges of the original, read-only', async () => {
    const { items } = JSON.parse((await get('/api/items?group=whatsapp-received')).body.toString()) as {
      items: { id: string; preview: string; size: number }[];
    };
    const [item] = items;
    expect(item!.preview).toBe('image');
    const preview = await get(`/api/preview/${item!.id}`);
    expect(preview.status).toBe(200);
    expect((await sharp(preview.body).metadata()).width).toBe(480);
    const range = await get(`/api/original/${item!.id}`, { range: 'bytes=0-9' });
    expect(range.status).toBe(206);
    expect(range.body.length).toBe(10);
    expect((await get('/api/original/bm90LWFuLWlk')).status).toBe(404);
  });

  it('saves decisions in bulk', async () => {
    const { items } = JSON.parse((await get('/api/items?group=temp-file')).body.toString()) as {
      items: { id: string }[];
    };
    const result = await post('/api/decisions', { ids: items.map((item) => item.id), decision: 'skipped' });
    expect(result.body.changed).toBe(1);
    expect(manifest.file('laptop:review', 'Camera/.temp-1.mp4')).toMatchObject({
      decision: 'skipped',
      status: 'skipped',
    });
    await post('/api/decisions', { ids: items.map((item) => item.id), decision: null });
    expect(manifest.file('laptop:review', 'Camera/.temp-1.mp4')).toMatchObject({
      decision: null,
      status: 'pending',
    });
    expect((await post('/api/decisions', { ids: 'nope', decision: 'approved' })).status).toBe(400);
  });
});
