import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ExportItem, ExportPage } from '@memory-vault/shared';
import { ConflictError, exportPaths, fetchVerified, runExport, safeSegment } from './export';

const files = new Map<string, Buffer>();
const requests: { path: string; range: string | undefined }[] = [];
let server: Server;
let base: string;
let directory: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://x');
    requests.push({ path: url.pathname, range: request.headers.range });
    if (url.searchParams.has('expired')) {
      response.writeHead(403).end();
      return;
    }
    const body = files.get(url.pathname);
    if (!body) {
      response.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
    if (range && !url.searchParams.has('no-ranges')) {
      const from = Number(range[1]);
      response.writeHead(206, { 'content-length': body.length - from }).end(body.subarray(from));
    } else {
      response.writeHead(200, { 'content-length': body.length }).end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'vault-export-'));
  requests.length = 0;
  return () => rmSync(directory, { recursive: true, force: true });
});

const content = (seed: string, size: number) =>
  Buffer.from(Array.from({ length: size }, (_, index) => (index * 7 + seed.charCodeAt(0)) % 256));
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

function item(
  id: string,
  data: Buffer,
  origins: ExportItem['origins'],
  extra: Partial<ExportItem> = {},
): ExportItem {
  files.set(`/${id}`, data);
  return {
    id: `00000000-0000-4000-8000-${id.padStart(12, '0')}`,
    sha256: sha(data),
    sizeBytes: data.length,
    kind: 'photo',
    mimeType: 'image/jpeg',
    originalName: origins[0]?.path.split('/').at(-1) ?? 'nameless.jpg',
    modifiedAt: '2026-01-02T03:04:05.000Z',
    takenAt: null,
    localAt: '2026-01-02T08:34:05.000',
    location: null,
    camera: null,
    origins,
    url: `${base}/${id}`,
    ...extra,
  };
}

describe('export paths', () => {
  it('rebuilds each source folder, safe on any drive, and never climbs out', () => {
    expect(safeSegment('a:b*c?.jpg')).toBe('a_b_c_.jpg');
    expect(safeSegment('trailing. ')).toBe('trailing');
    expect(safeSegment('CON.txt')).toBe('_CON.txt');
    expect(safeSegment('..')).toBeNull();
    expect(
      exportPaths({
        sha256: 'f'.repeat(64),
        originalName: 'x.jpg',
        origins: [
          { sourceId: 'phone:s21fe', path: 'DCIM/Camera/x.jpg', modifiedAt: null },
          { sourceId: 'laptop:s21fe', path: '../../etc/x.jpg', modifiedAt: null },
          { sourceId: 'phone:s21fe', path: 'DCIM/Camera/x.jpg', modifiedAt: null },
        ],
      }),
    ).toEqual(['phone-s21fe/DCIM/Camera/x.jpg', 'laptop-s21fe/etc/x.jpg']);
    expect(exportPaths({ sha256: 'a'.repeat(64), originalName: 'lost.jpg', origins: [] })).toEqual([
      'unsorted/lost.jpg',
    ]);
  });
});

describe('fetchVerified', () => {
  it('downloads, checks the SHA-256 and continues a partial download with a range request', async () => {
    const data = content('a', 50_000);
    const it1 = item('1', data, []);
    const target = join(directory, 'one.jpg');
    writeFileSync(`${target}.part`, data.subarray(0, 20_000));
    const result = await fetchVerified(() => Promise.resolve(it1.url), target, {
      size: data.length,
      sha256: it1.sha256,
    });
    expect(result).toBe('resumed');
    expect(requests.at(-1)?.range).toBe('bytes=20000-');
    expect(readFileSync(target)).toEqual(data);
    expect(existsSync(`${target}.part`)).toBe(false);
    expect(
      await fetchVerified(() => Promise.resolve(it1.url), target, { size: data.length, sha256: it1.sha256 }),
    ).toBe('present');
  });

  it('starts over when the server ignores the range, and gets a fresh link when one expired', async () => {
    const data = content('b', 30_000);
    const it2 = item('2', data, []);
    const target = join(directory, 'two.jpg');
    writeFileSync(`${target}.part`, data.subarray(0, 1_000));
    const links = [`${it2.url}?no-ranges`, `${it2.url}?no-ranges`];
    expect(
      await fetchVerified(() => Promise.resolve(links.shift() ?? it2.url), target, {
        size: data.length,
        sha256: it2.sha256,
      }),
    ).toBe('downloaded');
    expect(readFileSync(target)).toEqual(data);

    const target3 = join(directory, 'three.jpg');
    const fresh = [`${it2.url}?expired`, it2.url];
    expect(
      await fetchVerified(() => Promise.resolve(fresh.shift()!), target3, {
        size: data.length,
        sha256: it2.sha256,
      }),
    ).toBe('downloaded');
  });

  it('keeps nothing that fails its check, and never overwrites a different file', async () => {
    const data = content('c', 10_000);
    const it4 = item('4', data, []);
    const target = join(directory, 'four.jpg');
    await expect(
      fetchVerified(() => Promise.resolve(it4.url), target, { size: data.length, sha256: 'e'.repeat(64) }),
    ).rejects.toThrow('does not match its SHA-256');
    expect(existsSync(target) || existsSync(`${target}.part`)).toBe(false);
    writeFileSync(target, 'someone else’s file');
    await expect(
      fetchVerified(() => Promise.resolve(it4.url), target, { size: data.length, sha256: it4.sha256 }),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(readFileSync(target, 'utf8')).toBe('someone else’s file');
  });
});

describe('runExport', () => {
  it('writes every original into its folders with its date, plus a catalogue and a README', async () => {
    const photo = item('10', content('d', 4_000), [
      { sourceId: 'laptop:s21fe', path: 'Camera/IMG_1.jpg', modifiedAt: '2025-05-06T07:08:09.000Z' },
      { sourceId: 'phone:s21fe', path: 'DCIM/Camera/IMG_1.jpg', modifiedAt: '2025-05-06T07:08:09.000Z' },
    ]);
    const video = item('11', content('e', 9_000), [
      { sourceId: 'phone:s21fe', path: 'DCIM/Camera/VID_1.mp4', modifiedAt: null },
    ]);
    const broken = item(
      '12',
      content('f', 100),
      [{ sourceId: 'web:browser', path: 'broken.jpg', modifiedAt: null }],
      {
        sha256: '0'.repeat(64),
      },
    );
    const pages: ExportPage[] = [
      { total: 3, totalBytes: 13_100, items: [photo, video], nextCursor: video.id },
      { total: null, totalBytes: null, items: [broken], nextCursor: null },
    ];
    const api = {
      exportPage: (cursor?: string) => Promise.resolve(cursor ? pages[1]! : pages[0]!),
      downloadUrl: (id: string) =>
        Promise.resolve([photo, video, broken].find((entry) => entry.id === id)!.url),
    };

    const first = await runExport(directory, api, { quiet: true });
    expect(first.files).toBe(2);
    expect(first.failures).toEqual([
      { path: 'web-browser/broken.jpg', reason: 'the download does not match its SHA-256' },
    ]);
    const laptop = join(directory, 'laptop-s21fe/Camera/IMG_1.jpg');
    const phone = join(directory, 'phone-s21fe/DCIM/Camera/IMG_1.jpg');
    expect(readFileSync(laptop)).toEqual(files.get('/10'));
    expect(statSync(phone).ino).toBe(statSync(laptop).ino);
    expect(statSync(laptop).mtime.toISOString()).toBe('2025-05-06T07:08:09.000Z');
    expect(statSync(join(directory, 'phone-s21fe/DCIM/Camera/VID_1.mp4')).mtime.toISOString()).toBe(
      '2026-01-02T03:04:05.000Z',
    );
    const catalogue = JSON.parse(readFileSync(join(directory, 'catalogue.json'), 'utf8')) as {
      files: ExportItem[];
    };
    expect(catalogue.files.map((entry) => entry.id)).toEqual([photo.id, video.id]);
    expect(JSON.stringify(catalogue)).not.toContain('"url"');
    expect(readFileSync(join(directory, 'README.txt'), 'utf8')).toContain('sha256sum');
    expect(readFileSync(join(directory, 'export-problems.txt'), 'utf8')).toContain('web-browser/broken.jpg');

    // Again: nothing downloaded twice.
    requests.length = 0;
    const again = await runExport(directory, api, { quiet: true });
    expect(again.files).toBe(2);
    expect(requests.map((request) => request.path)).toEqual(['/12']);
  });
});
