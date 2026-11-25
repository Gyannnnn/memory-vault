import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AlbumList, AlbumSummary, AssetDetail, AssetPage } from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { originalKey, thumbKey } from '../storage/keys';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;

const api = () => request(harness.app);
const as = (user: SignedInUser) => ({
  get: (path: string) => api().get(path).set(bearer(user.accessToken)),
  post: (path: string, body?: object) => api().post(path).set(bearer(user.accessToken)).send(body),
  patch: (path: string, body: object) => api().patch(path).set(bearer(user.accessToken)).send(body),
  delete: (path: string) => api().delete(path).set(bearer(user.accessToken)),
});

/** A processed photo with a small preview, taken on `day`. */
async function seed(user: SignedInUser, day: string, name: string): Promise<string> {
  const id = newId();
  const sha256 = createHash('sha256').update(id).digest('hex');
  await withUser(harness.ctx.db, user.userId, async (tx) => {
    await tx.asset.create({
      data: {
        id,
        userId: user.userId,
        sha256,
        sizeBytes: 2048n,
        mimeType: 'image/jpeg',
        kind: 'photo',
        extension: 'jpg',
        originalName: name,
        s3Key: originalKey(user.userId, sha256, 'jpg'),
        status: 'verified',
        verifiedAt: new Date(),
        takenAt: new Date(`${day}T10:00:00Z`),
        takenAtOffsetMinutes: 0,
        width: 4000,
        height: 3000,
        processedAt: new Date(),
      },
    });
    await tx.derivative.create({
      data: {
        id: newId(),
        userId: user.userId,
        assetId: id,
        variant: 'sm',
        s3Key: thumbKey(user.userId, sha256, 'sm'),
        mimeType: 'image/webp',
        width: 400,
        height: 300,
        sizeBytes: 100,
      },
    });
  });
  return id;
}

let beach: string;
let hills: string;
let city: string;
let trashed: string;
let bobsPhoto: string;

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  beach = await seed(alice, '2025-12-20', 'beach.jpg');
  hills = await seed(alice, '2025-12-24', 'hills.jpg');
  city = await seed(alice, '2026-01-02', 'city.jpg');
  trashed = await seed(alice, '2025-12-22', 'trashed.jpg');
  await withUser(harness.ctx.db, alice.userId, (tx) =>
    tx.asset.update({ where: { id: trashed }, data: { deletedAt: new Date() } }),
  );
  bobsPhoto = await seed(bob, '2025-12-21', 'bob.jpg');
});

afterAll(() => harness.close());

describe('albums', () => {
  let goa: AlbumSummary;

  it('creates an album with only the caller’s visible photos in it', async () => {
    const created = await as(alice).post('/v1/albums', {
      name: '  Goa · Dec 2025 ',
      assetIds: [beach, hills, trashed, bobsPhoto],
    });
    expect(created.status).toBe(201);
    goa = created.body as AlbumSummary;
    expect(goa).toMatchObject({ name: 'Goa · Dec 2025', count: 2 });
    // The newest item is the cover until one is chosen.
    expect(goa.cover?.sm).toContain(createHash('sha256').update(hills).digest('hex'));
  });

  it('lists albums and favourites; an empty name is refused', async () => {
    const list = (await as(alice).get('/v1/albums')).body as AlbumList;
    expect(list.albums.map((album) => album.name)).toEqual(['Goa · Dec 2025']);
    expect(list.favorites).toEqual({ count: 0, cover: null });
    expect((await as(alice).post('/v1/albums', { name: '   ' })).status).toBe(400);
  });

  it('adds, ignores duplicates and other people’s photos, and removes', async () => {
    const added = await as(alice).post(`/v1/albums/${goa.id}/items`, { assetIds: [city, beach, bobsPhoto] });
    expect(added.body).toEqual({ added: 1 });
    const page = (await as(alice).get(`/v1/assets?album=${goa.id}`)).body as AssetPage;
    expect(page.items.map((item) => item.name)).toEqual(['city.jpg', 'hills.jpg', 'beach.jpg']);
    expect(page.total).toBe(3);
    const removed = await as(alice).post(`/v1/albums/${goa.id}/items/remove`, { assetIds: [city] });
    expect(removed.body).toEqual({ removed: 1 });
    expect(((await as(alice).get(`/v1/albums/${goa.id}`)).body as AlbumSummary).count).toBe(2);
  });

  it('takes a cover only from the album', async () => {
    expect((await as(alice).patch(`/v1/albums/${goa.id}`, { coverAssetId: city })).status).toBe(400);
    const renamed = await as(alice).patch(`/v1/albums/${goa.id}`, { name: 'Goa', coverAssetId: beach });
    expect(renamed.body).toMatchObject({ name: 'Goa', count: 2 });
    expect((renamed.body as AlbumSummary).cover?.sm).toContain(
      createHash('sha256').update(beach).digest('hex'),
    );
  });

  it('shows the albums a photo is in', async () => {
    const detail = (await as(alice).get(`/v1/assets/${beach}`)).body as AssetDetail;
    expect(detail.albums).toEqual([{ id: goa.id, name: 'Goa' }]);
  });

  it('zips an album', async () => {
    const zip = await as(alice).post('/v1/downloads', { albumId: goa.id });
    expect(zip.status).toBe(201);
    expect(zip.body).toMatchObject({ fileName: 'Goa.zip', fileCount: 2 });
  });

  it('keeps another user out of the album entirely', async () => {
    expect((await as(bob).get(`/v1/albums/${goa.id}`)).status).toBe(404);
    expect((await as(bob).patch(`/v1/albums/${goa.id}`, { name: 'mine' })).status).toBe(404);
    expect((await as(bob).post(`/v1/albums/${goa.id}/items`, { assetIds: [bobsPhoto] })).status).toBe(404);
    expect((await as(bob).post(`/v1/albums/${goa.id}/items/remove`, { assetIds: [beach] })).status).toBe(404);
    expect((await as(bob).delete(`/v1/albums/${goa.id}`)).status).toBe(404);
    expect((await as(bob).post('/v1/downloads', { albumId: goa.id })).status).toBe(404);
    const page = (await as(bob).get(`/v1/assets?album=${goa.id}`)).body as AssetPage;
    expect(page.items).toEqual([]);
    expect(((await as(bob).get('/v1/albums')).body as AlbumList).albums).toEqual([]);
  });

  it('row-level security hides albums and their items from raw queries', async () => {
    const asBob = await withUser(harness.ctx.db, bob.userId, async (tx) => ({
      albums: await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM albums`,
      items: await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM album_items`,
    }));
    expect([asBob.albums[0]!.n, asBob.items[0]!.n]).toEqual([0n, 0n]);
    await expect(
      withUser(harness.ctx.db, bob.userId, (tx) =>
        tx.albumItem.create({ data: { albumId: goa.id, assetId: bobsPhoto, userId: alice.userId } }),
      ),
    ).rejects.toThrow();
  });

  it('deleting an album leaves its photos in the library', async () => {
    expect((await as(alice).delete(`/v1/albums/${goa.id}`)).status).toBe(204);
    expect((await as(alice).get(`/v1/albums/${goa.id}`)).status).toBe(404);
    expect((await as(alice).get(`/v1/assets/${beach}`)).status).toBe(200);
  });
});

describe('favourites', () => {
  it('marks and unmarks the caller’s photos only', async () => {
    const marked = await as(alice).post('/v1/assets/favorite', {
      ids: [beach, city, trashed, bobsPhoto],
      favorite: true,
    });
    expect(marked.body).toEqual({ updated: 2 });
    const page = (await as(alice).get('/v1/assets?favorite=1')).body as AssetPage;
    expect(page.items.map((item) => [item.name, item.favorite])).toEqual([
      ['city.jpg', true],
      ['beach.jpg', true],
    ]);
    const list = (await as(alice).get('/v1/albums')).body as AlbumList;
    expect(list.favorites.count).toBe(2);
    expect(((await as(bob).get('/v1/assets?favorite=1')).body as AssetPage).items).toEqual([]);

    await as(alice).post('/v1/assets/favorite', { ids: [city], favorite: false });
    const after = (await as(alice).get('/v1/assets')).body as AssetPage;
    expect(after.items.find((item) => item.id === city)?.favorite).toBe(false);
    expect(after.items.find((item) => item.id === beach)?.favorite).toBe(true);
  });
});
