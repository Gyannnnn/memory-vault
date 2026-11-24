import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AssetDetail,
  AssetPage,
  AssetTile,
  FolderListing,
  TimelineResponse,
} from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { parsePlaces, savePlaces, unzipSingle } from '../places/geonames';
import { originalKey, thumbKey } from '../storage/keys';
import { recordOrigin } from './folders';
import { prefixQuery } from './browse';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;
const ids: Record<string, string> = {};

const api = () => request(harness.app);
const get = <T>(user: SignedInUser, path: string) =>
  api()
    .get(path)
    .set(bearer(user.accessToken))
    .then((response) => {
      if (response.status !== 200) throw new Error(`${path} → ${response.status} ${response.text}`);
      return response.body as T;
    });

interface Seed {
  path: string;
  sourceId?: string;
  kind?: 'photo' | 'video' | 'document';
  takenAt?: string;
  offsetMinutes?: number;
  takenAtSource?: string;
  modifiedAt?: string;
  gps?: [number, number];
  camera?: string;
  thumb?: boolean;
}

async function seed(user: SignedInUser, input: Seed): Promise<string> {
  const id = newId();
  const sha256 = createHash('sha256').update(id).digest('hex');
  await withUser(harness.ctx.db, user.userId, async (tx) => {
    await tx.asset.create({
      data: {
        id,
        userId: user.userId,
        sha256,
        sizeBytes: 1234n,
        mimeType:
          input.kind === 'video' ? 'video/mp4' : input.kind === 'document' ? 'application/pdf' : 'image/jpeg',
        kind: input.kind ?? 'photo',
        extension: 'jpg',
        originalName: input.path.split('/').at(-1)!,
        originalModifiedAt: input.modifiedAt ? new Date(input.modifiedAt) : null,
        s3Key: originalKey(user.userId, sha256, 'jpg'),
        status: 'verified',
        verifiedAt: new Date(),
        takenAt: input.takenAt ? new Date(input.takenAt) : null,
        takenAtOffsetMinutes: input.offsetMinutes ?? null,
        gpsLatitude: input.gps?.[0] ?? null,
        gpsLongitude: input.gps?.[1] ?? null,
        cameraModel: input.camera ?? null,
        width: 4000,
        height: 3000,
        processedAt: input.takenAt ? new Date() : null,
        exif: { takenAtSource: input.takenAtSource ?? 'exif', FNumber: 1.8 },
      },
    });
    await recordOrigin(tx, user.userId, id, {
      sourceId: input.sourceId ?? 'phone:s21fe',
      path: input.path,
    });
    if (input.thumb !== false && input.takenAt) {
      for (const variant of ['sm', 'md', 'lg']) {
        await tx.derivative.create({
          data: {
            id: newId(),
            userId: user.userId,
            assetId: id,
            variant,
            s3Key: thumbKey(user.userId, sha256, variant),
            mimeType: 'image/webp',
            width: 400,
            height: 300,
            sizeBytes: 10,
          },
        });
      }
    }
    await tx.$executeRaw`UPDATE assets SET place_id = nearest_place(gps_latitude, gps_longitude)
      WHERE id = ${id}::uuid AND gps_latitude IS NOT NULL`;
  });
  return id;
}

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  await harness.owner.user.update({ where: { id: alice.userId }, data: { timezone: 'Asia/Kolkata' } });
  await savePlaces(harness.owner, [
    {
      id: 1,
      name: 'Koraput',
      asciiName: 'Koraput',
      latitude: 18.81,
      longitude: 82.71,
      countryCode: 'IN',
      countryName: 'India',
      admin1Name: 'Odisha',
      population: 47_000,
    },
    {
      id: 2,
      name: 'Bengaluru',
      asciiName: 'Bengaluru',
      latitude: 12.97,
      longitude: 77.59,
      countryCode: 'IN',
      countryName: 'India',
      admin1Name: 'Karnataka',
      population: 8_400_000,
    },
  ]);

  ids.newYear = await seed(alice, {
    path: 'DCIM/Camera/20250101_093000.jpg',
    takenAt: '2025-01-01T04:00:00Z',
    offsetMinutes: 330,
    gps: [18.9, 82.6],
    camera: 'SM-G990B2',
  });
  // 20:00 UTC on 31 January is already 1 February in India.
  ids.lateNight = await seed(alice, {
    path: 'DCIM/Camera/20250201_013000.jpg',
    takenAt: '2025-01-31T20:00:00Z',
    offsetMinutes: 330,
    gps: [12.95, 77.6],
    camera: 'SM-G990B2',
  });
  ids.whatsapp = await seed(alice, {
    path: 'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-20240101-WA0001.jpg',
    takenAt: '2024-01-01T06:00:00Z',
    offsetMinutes: 330,
  });
  ids.video = await seed(alice, {
    kind: 'video',
    path: 'trip/VID_1.mp4',
    sourceId: 'laptop:s21fe',
    takenAt: '2024-06-15T10:00:00Z',
    offsetMinutes: 0,
    gps: [18.8, 82.7],
    camera: 'iPhone 13',
  });
  ids.fileDate = await seed(alice, {
    path: 'Download/old.jpg',
    takenAt: '2024-01-01T10:00:00Z',
    offsetMinutes: 330,
    takenAtSource: 'file-modified',
  });
  ids.unprocessed = await seed(alice, {
    path: 'DCIM/Camera/pending.jpg',
    modifiedAt: '2023-12-31T20:00:00Z',
  });
  ids.document = await seed(alice, {
    kind: 'document',
    path: 'Documents/receipt.pdf',
    takenAt: '2024-03-01T00:00:00Z',
    offsetMinutes: 0,
  });
  ids.bobs = await seed(bob, {
    path: 'DCIM/Camera/bob.jpg',
    takenAt: '2025-01-01T05:00:00Z',
    offsetMinutes: 0,
    gps: [18.8, 82.7],
  });
});

afterAll(async () => {
  await harness.close();
});

describe('timeline', () => {
  it('counts photos and videos per month of the wall-clock time, only the owner’s', async () => {
    const timeline = await get<TimelineResponse>(alice, '/v1/timeline');
    expect(timeline.buckets.map((bucket) => [bucket.month, bucket.count])).toEqual([
      ['2025-02', 1],
      ['2025-01', 1],
      ['2024-06', 1],
      ['2024-01', 3],
    ]);
    expect(timeline.total).toBe(6);
    expect(timeline.pending).toBe(1);
    // 2024-01 holds three files over one day; every test photo is 4:3.
    expect(timeline.buckets.at(-1)!.days).toEqual([[3, 4]]);
  });

  it('lists a month newest first, with a file waiting for processing dated by its file time in the owner’s zone', async () => {
    const { items } = await get<{ items: AssetTile[] }>(alice, '/v1/timeline/2024-01');
    expect(items.map((item) => item.id)).toEqual([ids.fileDate, ids.whatsapp, ids.unprocessed]);
    const pending = items.find((item) => item.id === ids.unprocessed)!;
    expect(pending.localAt).toBe('2024-01-01T01:30:00.000');
    expect(pending.thumb).toBeNull();
    expect(items[0]!.thumb?.sm).toContain('/thumbs/');
  });

  it('refuses a malformed month', async () => {
    expect((await api().get('/v1/timeline/2025-13').set(bearer(alice.accessToken))).status).toBe(400);
  });
});

describe('media links', () => {
  it('signs links that S3 accepts and that stay the same within the hour', async () => {
    const asset = await harness.owner.asset.findUniqueOrThrow({ where: { id: ids.newYear } });
    const body = Buffer.from('webp bytes');
    await harness.ctx.s3.send(
      new PutObjectCommand({
        Bucket: harness.ctx.env.S3_BUCKET,
        Key: thumbKey(alice.userId, asset.sha256, 'sm'),
        Body: body,
        ContentType: 'image/webp',
      }),
    );
    const first = await get<{ items: AssetTile[] }>(alice, '/v1/timeline/2025-01');
    const second = await get<{ items: AssetTile[] }>(alice, '/v1/timeline/2025-01');
    const url = first.items[0]!.thumb!.sm;
    expect(second.items[0]!.thumb!.sm).toBe(url);
    const fetched = await fetch(url);
    expect(fetched.status).toBe(200);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(body);
    const tampered = await fetch(url.replace(asset.sha256, '0'.repeat(64)));
    expect(tampered.status).toBe(403);
  });
});

describe('search', () => {
  const search = (query: string) => get<AssetPage>(alice, `/v1/assets?${query}`);
  const found = async (query: string) => (await search(query)).items.map((item) => item.id).sort();

  it('builds prefix queries from free text', () => {
    expect(prefixQuery('Kora 2025!')).toBe('kora:* & 2025:*');
    expect(prefixQuery('  ')).toBeNull();
  });

  it('finds by place name, folder words, file name and camera', async () => {
    expect(await found('q=kora')).toEqual([ids.newYear, ids.video].sort());
    expect(await found('q=odisha')).toEqual([ids.newYear, ids.video].sort());
    expect(await found('q=bengaluru')).toEqual([ids.lateNight]);
    expect(await found('q=whatsapp%20images')).toEqual([ids.whatsapp]);
    expect(await found('q=receipt')).toEqual([ids.document]);
    expect(await found('q=-WA00')).toEqual([ids.whatsapp]);
    expect(await found('camera=iPhone%2013')).toEqual([ids.video]);
  });

  it('filters by type, dates, source and map area', async () => {
    expect(await found('kind=video')).toEqual([ids.video]);
    expect(await found('kind=photo,video&from=2025-01-01&to=2025-01-31')).toEqual([ids.newYear]);
    expect(await found('source=laptop')).toEqual([ids.video]);
    expect(await found('source=phone:s21fe&q=kora')).toEqual([ids.newYear]);
    expect(await found('bbox=82,18,83,19')).toEqual([ids.newYear, ids.video].sort());
    expect(await found('place=1')).toEqual([ids.newYear, ids.video].sort());
    expect(await found('place=1,2')).toEqual([ids.newYear, ids.lateNight, ids.video].sort());
    expect((await api().get('/v1/assets?place=abc').set(bearer(alice.accessToken))).status).toBe(400);
  });

  it('pages through everything exactly once, with the total on the first page', async () => {
    const first = await search('limit=2');
    expect(first.total).toBe(7);
    const seen = [...first.items.map((item) => item.id)];
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await search(`limit=2&cursor=${cursor}`);
      expect(page.total).toBeUndefined();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('never returns another user’s files', async () => {
    const bobsView = await get<AssetPage>(bob, '/v1/assets?q=kora');
    expect(bobsView.items.map((item) => item.id)).toEqual([ids.bobs]);
    expect(await found('q=bob')).toEqual([]);
  });

  it('offers facets from the owner’s library', async () => {
    const facets = await get<{
      years: { year: number; count: number }[];
      cameras: { name: string; count: number }[];
      places: { name: string; ids: number[]; count: number }[];
      sources: { id: string; count: number }[];
    }>(alice, '/v1/search/facets');
    expect(facets.years).toEqual([
      { year: 2025, count: 2 },
      { year: 2024, count: 4 },
    ]);
    expect(facets.cameras).toEqual([
      { name: 'SM-G990B2', count: 2 },
      { name: 'iPhone 13', count: 1 },
    ]);
    expect(facets.places.map((place) => [place.name, place.ids, place.count])).toEqual([
      ['Koraput', [1], 2],
      ['Bengaluru', [2], 1],
    ]);
    expect(facets.sources).toEqual([
      { id: 'phone:s21fe', count: 6 },
      { id: 'laptop:s21fe', count: 1 },
    ]);
  });
});

describe('details', () => {
  it('describes a photo with its place, origins and folders', async () => {
    const detail = await get<AssetDetail>(alice, `/v1/assets/${ids.newYear}`);
    expect(detail).toMatchObject({
      id: ids.newYear,
      name: '20250101_093000.jpg',
      localAt: '2025-01-01T09:30:00.000',
      takenAtSource: 'exif',
      takenAtOffsetMinutes: 330,
      camera: { model: 'SM-G990B2' },
      exif: { FNumber: 1.8 },
      location: {
        latitude: 18.9,
        longitude: 82.6,
        place: { name: 'Koraput', admin1: 'Odisha', country: 'India' },
      },
      origins: [{ sourceId: 'phone:s21fe', path: 'DCIM/Camera/20250101_093000.jpg' }],
      folders: [{ path: 'Phone · s21fe/DCIM/Camera/20250101_093000.jpg' }],
      processing: { done: true, error: null },
    });
    expect(detail.exif).not.toHaveProperty('takenAtSource');
    expect(detail.preview?.lg).toContain('/lg.webp');
    expect(detail.originalUrl).toContain('response-content-disposition');
  });

  it('is not found for anyone else', async () => {
    expect((await api().get(`/v1/assets/${ids.newYear}`).set(bearer(bob.accessToken))).status).toBe(404);
    expect((await api().get('/v1/assets/not-a-uuid').set(bearer(alice.accessToken))).status).toBe(400);
  });
});

describe('folders', () => {
  it('mirrors each source as a folder tree with counts, covers and breadcrumbs', async () => {
    const root = await get<FolderListing>(alice, '/v1/folders');
    expect(root.folders.map((folder) => folder.name)).toEqual(['Laptop · s21fe', 'Phone · s21fe']);
    const phone = root.folders.find((folder) => folder.name === 'Phone · s21fe')!;
    const phoneListing = await get<FolderListing>(alice, `/v1/folders/${phone.id}`);
    const dcim = phoneListing.folders.find((folder) => folder.name === 'DCIM')!;
    const dcimListing = await get<FolderListing>(alice, `/v1/folders/${dcim.id}`);
    const camera = dcimListing.folders[0]!;
    expect(camera).toMatchObject({ name: 'Camera', fileCount: 3, folderCount: 0 });
    expect(camera.cover?.sm).toContain('/sm.webp');

    const cameraListing = await get<FolderListing>(alice, `/v1/folders/${camera.id}?limit=2`);
    expect(cameraListing.folder.path.map((part) => part.name)).toEqual(['Phone · s21fe', 'DCIM', 'Camera']);
    expect(cameraListing.fileTotal).toBe(3);
    expect(cameraListing.files.map((file) => file.name)).toEqual([
      '20250101_093000.jpg',
      '20250201_013000.jpg',
    ]);
    const rest = await get<FolderListing>(
      alice,
      `/v1/folders/${camera.id}?limit=2&cursor=${encodeURIComponent(cameraListing.nextCursor!)}`,
    );
    expect(rest.files.map((file) => file.name)).toEqual(['pending.jpg']);
    expect(rest.nextCursor).toBeNull();
  });

  it('does not open another user’s folder', async () => {
    const root = await get<FolderListing>(alice, '/v1/folders');
    const response = await api().get(`/v1/folders/${root.folders[0]!.id}`).set(bearer(bob.accessToken));
    expect(response.status).toBe(404);
    const bobsRoot = await get<FolderListing>(bob, '/v1/folders');
    expect(bobsRoot.folders.map((folder) => folder.name)).toEqual(['Phone · s21fe']);
  });
});

describe('map and memories', () => {
  it('returns only the owner’s points with a position', async () => {
    const { points } = await get<{ points: [string, number, number, number][] }>(alice, '/v1/map/points');
    expect(points.map(([id]) => id).sort()).toEqual([ids.newYear, ids.lateNight, ids.video].sort());
    expect(points.find(([id]) => id === ids.video)?.[3]).toBe(1);
  });

  it('shows earlier years on this day, skipping dates that only come from file times', async () => {
    const memories = await get<{ groups: { year: number; yearsAgo: number; items: AssetTile[] }[] }>(
      alice,
      '/v1/memories/on-this-day?date=2026-01-01',
    );
    expect(
      memories.groups.map((group) => [group.year, group.yearsAgo, group.items.map((item) => item.id)]),
    ).toEqual([
      [2025, 1, [ids.newYear]],
      [2024, 2, [ids.whatsapp]],
    ]);
    const sameYear = await get<{ groups: unknown[] }>(alice, '/v1/memories/on-this-day?date=2025-01-01');
    expect(sameYear.groups.map((group) => (group as { year: number }).year)).toEqual([2024]);
  });
});

describe('GeoNames loading', () => {
  function zipOf(name: string, content: string): Buffer {
    const data = deflateRawSync(Buffer.from(content));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(0, 42);
    const directoryOffset = local.length + nameBytes.length + data.length;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(1, 8);
    end.writeUInt16LE(1, 10);
    end.writeUInt32LE(central.length + nameBytes.length, 12);
    end.writeUInt32LE(directoryOffset, 16);
    return Buffer.concat([local, nameBytes, data, central, nameBytes, end]);
  }

  it('reads cities1000 with state and country names', () => {
    const row = (...columns: string[]) => columns.join('\t');
    const cities = [
      row(
        '1273865',
        'Koraput',
        'Koraput',
        'Koraput,कोरापुट',
        '18.81199',
        '82.71048',
        'P',
        'PPLA2',
        'IN',
        '',
        '21',
        '',
        '',
        '',
        '47468',
        '',
        '878',
        'Asia/Kolkata',
        '2020-01-01',
      ),
      'bad line',
    ].join('\n');
    const text = unzipSingle(zipOf('cities1000.txt', cities), 'cities1000.txt').toString('utf8');
    const admin1 = row('IN.21', 'Odisha', 'Odisha', '1261029');
    const countries = ['#ISO\tISO3', row('IN', 'IND', '356', 'IN', 'India', 'New Delhi')].join('\n');
    const places = parsePlaces(text, admin1, countries);
    expect(places).toEqual([
      {
        id: 1273865,
        name: 'Koraput',
        asciiName: 'Koraput',
        latitude: 18.81199,
        longitude: 82.71048,
        countryCode: 'IN',
        countryName: 'India',
        admin1Name: 'Odisha',
        population: 47468,
      },
    ]);
  });
});
