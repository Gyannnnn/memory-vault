import { createHash, randomBytes } from 'node:crypto';
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AlbumSummary,
  AssetDetail,
  AssetPage,
  CheckUploadsResponse,
  FolderListing,
  TrashPage,
  VerifyAssetsResponse,
} from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import type { AppContext } from '../context';
import { newId, withUser } from '../db';
import { thumbKey } from '../storage/keys';
import { purgeTrash, STORAGE_PERMISSION_MISSING } from './trash';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;

const api = () => request(harness.app);
const as = (user: SignedInUser) => ({
  get: (path: string) => api().get(path).set(bearer(user.accessToken)),
  post: (path: string, body?: object) => api().post(path).set(bearer(user.accessToken)).send(body),
});
const sha256Hex = (data: Buffer) => createHash('sha256').update(data).digest('hex');

interface Uploaded {
  id: string;
  sha256: string;
  s3Key: string;
  thumb: string;
  content: Buffer;
}

/** A real upload through the API, plus a stored preview, so purging has S3 objects to delete. */
async function upload(
  user: SignedInUser,
  path: string,
  content: Buffer = randomBytes(2048),
): Promise<Uploaded> {
  const created = await as(user).post('/v1/uploads', {
    sha256: sha256Hex(content),
    size: content.length,
    mimeType: 'image/jpeg',
    origin: { sourceId: 'laptop:test', path, modifiedAt: '2025-12-20T10:00:00.000Z' },
  });
  expect(created.status).toBe(200);
  const target = created.body.request as { url: string; headers: Record<string, string> };
  expect(
    (await fetch(target.url, { method: 'PUT', headers: target.headers, body: new Uint8Array(content) }))
      .status,
  ).toBe(200);
  expect((await as(user).post(`/v1/uploads/${created.body.uploadId}/complete`, {})).status).toBe(200);
  const sha256 = sha256Hex(content);
  const asset = await withUser(harness.ctx.db, user.userId, async (tx) => {
    const row = await tx.asset.findFirstOrThrow({ where: { sha256 } });
    const thumb = thumbKey(user.userId, sha256, 'sm');
    await tx.asset.update({ where: { id: row.id }, data: { processedAt: new Date(), kind: 'photo' } });
    await tx.derivative.create({
      data: {
        id: newId(),
        userId: user.userId,
        assetId: row.id,
        variant: 'sm',
        s3Key: thumb,
        mimeType: 'image/webp',
        width: 400,
        height: 300,
        sizeBytes: 3,
      },
    });
    return { id: row.id, s3Key: row.s3Key, thumb };
  });
  await harness.ctx.s3.send(
    new PutObjectCommand({ Bucket: harness.ctx.env.S3_BUCKET, Key: asset.thumb, Body: Buffer.from('web') }),
  );
  return { ...asset, sha256, content };
}

const exists = async (Key: string) =>
  harness.ctx.s3
    .send(new HeadObjectCommand({ Bucket: harness.ctx.env.S3_BUCKET, Key }))
    .then(() => true)
    .catch(() => false);

const versions = async (Key: string) => {
  const listed = await harness.ctx.s3.send(
    new ListObjectVersionsCommand({ Bucket: harness.ctx.env.S3_BUCKET, Prefix: Key }),
  );
  return {
    versions: (listed.Versions ?? []).filter((version) => version.Key === Key).length,
    markers: (listed.DeleteMarkers ?? []).filter((marker) => marker.Key === Key).length,
  };
};

let beach: Uploaded;
let hills: Uploaded;
let city: Uploaded;
let old: Uploaded;
let recent: Uploaded;
let bobs: Uploaded;
let album: AlbumSummary;

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  beach = await upload(alice, 'Goa/beach.jpg');
  hills = await upload(alice, 'Goa/hills.jpg');
  city = await upload(alice, 'Goa/city.jpg');
  old = await upload(alice, 'Old/old.jpg');
  recent = await upload(alice, 'Old/recent.jpg');
  bobs = await upload(bob, 'Bob/bob.jpg');
  album = (await as(alice).post('/v1/albums', { name: 'Goa', assetIds: [beach.id, hills.id, city.id] }))
    .body as AlbumSummary;
});

afterAll(() => harness.close());

const ids = (page: AssetPage) => page.items.map((item) => item.id);

describe('moving to Trash and back', () => {
  it('hides trashed items everywhere but Trash, and only the owner can trash', async () => {
    expect((await as(bob).post('/v1/assets/trash', { ids: [beach.id] })).body).toEqual({ trashed: 0 });
    expect((await as(alice).post('/v1/assets/trash', { ids: [beach.id, bobs.id] })).body).toEqual({
      trashed: 1,
    });

    expect(ids((await as(alice).get('/v1/assets')).body as AssetPage)).not.toContain(beach.id);
    expect(ids((await as(alice).get(`/v1/assets?album=${album.id}`)).body as AssetPage)).toHaveLength(2);
    expect(((await as(alice).get(`/v1/albums/${album.id}`)).body as AlbumSummary).count).toBe(2);
    expect((await as(alice).post('/v1/downloads', { assetIds: [beach.id] })).status).toBe(404);

    // Folder counts leave it out too.
    const root = (await as(alice).get('/v1/folders')).body as FolderListing;
    const source = (await as(alice).get(`/v1/folders/${root.folders[0]!.id}`)).body as FolderListing;
    expect(source.folders.find((folder) => folder.name === 'Goa')?.fileCount).toBe(2);

    // Its owner can still look at it, and sees that it's in Trash.
    const detail = (await as(alice).get(`/v1/assets/${beach.id}`)).body as AssetDetail;
    expect(detail.trashedAt).not.toBeNull();
    expect((await as(bob).get(`/v1/assets/${beach.id}`)).status).toBe(404);
  });

  it('lists Trash with when each item goes, to its owner only', async () => {
    const page = (await as(alice).get('/v1/trash')).body as TrashPage;
    expect(page.items.map((item) => item.id)).toEqual([beach.id]);
    const item = page.items[0]!;
    const days = (Date.parse(item.purgeAt) - Date.parse(item.deletedAt)) / 86_400_000;
    expect(days).toBeCloseTo(30, 5);
    expect(page.summary).toEqual({ count: 1, bytes: 2048, due: 0, problem: null });
    expect(((await as(bob).get('/v1/trash')).body as TrashPage).items).toEqual([]);
  });

  it('restores', async () => {
    expect((await as(bob).post('/v1/assets/restore', { ids: [beach.id] })).body).toEqual({ restored: 0 });
    expect((await as(alice).post('/v1/assets/restore', { ids: [beach.id] })).body).toEqual({ restored: 1 });
    expect(ids((await as(alice).get('/v1/assets')).body as AssetPage)).toContain(beach.id);
    expect(((await as(alice).get('/v1/trash')).body as TrashPage).items).toEqual([]);
  });

  it('reports trashed content to uploaders and to verify', async () => {
    await as(alice).post('/v1/assets/trash', { ids: [hills.id] });
    const check = (
      await as(alice).post('/v1/uploads/check', { items: [{ sha256: hills.sha256, size: 2048 }] })
    ).body as CheckUploadsResponse;
    expect(check).toEqual({ existing: [hills.sha256], trashed: [hills.sha256], deleted: [] });
    const verify = (await as(alice).post('/v1/assets/verify', { sha256s: [hills.sha256] }))
      .body as VerifyAssetsResponse;
    expect(verify.results).toEqual([{ sha256: hills.sha256, status: 'trashed' }]);
  });
});

describe('deleting for good', () => {
  it('waits in Trash, untouched, when S3 refuses the delete', async () => {
    await as(alice).post('/v1/trash/delete', { ids: [hills.id] });
    expect(harness.jobs.purges).toEqual([alice.userId]);
    const refusing = {
      ...harness.ctx,
      s3: {
        send: (command: unknown) =>
          command instanceof DeleteObjectCommand
            ? Promise.reject(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }))
            : harness.ctx.s3.send(command as never),
      },
    } as unknown as AppContext;
    expect(await purgeTrash(refusing, { userId: alice.userId })).toEqual({ purged: 0, failed: 1 });
    expect(await exists(hills.s3Key)).toBe(true);
    expect(await exists(hills.thumb)).toBe(true);
    const page = (await as(alice).get('/v1/trash')).body as TrashPage;
    expect(page.items[0]).toMatchObject({ id: hills.id, purgeError: STORAGE_PERMISSION_MISSING });
    expect(page.summary).toMatchObject({ due: 1, problem: STORAGE_PERMISSION_MISSING });
  });

  it('puts delete markers on the original and previews, keeps the versions, and records the content', async () => {
    expect(await purgeTrash(harness.ctx, { userId: alice.userId })).toEqual({ purged: 1, failed: 0 });
    expect(await exists(hills.s3Key)).toBe(false);
    expect(await exists(hills.thumb)).toBe(false);
    expect(await versions(hills.s3Key)).toEqual({ versions: 1, markers: 1 });

    expect(((await as(alice).get('/v1/trash')).body as TrashPage).items).toEqual([]);
    expect((await as(alice).get(`/v1/assets/${hills.id}`)).status).toBe(404);
    expect(((await as(alice).get(`/v1/albums/${album.id}`)).body as AlbumSummary).count).toBe(2);

    const check = (
      await as(alice).post('/v1/uploads/check', { items: [{ sha256: hills.sha256, size: 2048 }] })
    ).body as CheckUploadsResponse;
    expect(check.existing).toEqual([]);
    expect(check.deleted.map((row) => row.sha256)).toEqual([hills.sha256]);
    const verify = (await as(alice).post('/v1/assets/verify', { sha256s: [hills.sha256] }))
      .body as VerifyAssetsResponse;
    expect(verify.results).toEqual([{ sha256: hills.sha256, status: 'deleted' }]);
    // Bob knows nothing about it.
    const bobCheck = (
      await as(bob).post('/v1/uploads/check', { items: [{ sha256: hills.sha256, size: 2048 }] })
    ).body as CheckUploadsResponse;
    expect(bobCheck).toEqual({ existing: [], trashed: [], deleted: [] });

    const events = await harness.owner.auditEvent.findMany({
      where: { userId: alice.userId, type: 'asset.purged' },
    });
    expect(events.map((event) => event.metadata)).toEqual([
      { name: 'hills.jpg', sha256: hills.sha256, sizeBytes: 2048 },
    ]);
  });

  it('deletes on its own only what has been in Trash for 30 days', async () => {
    await as(alice).post('/v1/assets/trash', { ids: [old.id, recent.id] });
    await withUser(harness.ctx.db, alice.userId, async (tx) => {
      await tx.asset.update({
        where: { id: old.id },
        data: { deletedAt: new Date(Date.now() - 31 * 86_400_000) },
      });
      await tx.asset.update({
        where: { id: recent.id },
        data: { deletedAt: new Date(Date.now() - 29 * 86_400_000) },
      });
    });
    expect(await purgeTrash(harness.ctx)).toEqual({ purged: 1, failed: 0 });
    expect(await exists(old.s3Key)).toBe(false);
    expect(await exists(recent.s3Key)).toBe(true);
    expect(((await as(alice).get('/v1/trash')).body as TrashPage).items.map((item) => item.id)).toEqual([
      recent.id,
    ]);
    // Bob's photo was never in Trash.
    expect(await exists(bobs.s3Key)).toBe(true);
  });

  it('uploading deleted content again on purpose brings it back and clears the record', async () => {
    const again = await upload(alice, 'Again/hills.jpg', hills.content);
    expect(ids((await as(alice).get('/v1/assets')).body as AssetPage)).toContain(again.id);
    const check = (
      await as(alice).post('/v1/uploads/check', { items: [{ sha256: hills.sha256, size: 2048 }] })
    ).body as CheckUploadsResponse;
    expect(check).toEqual({ existing: [hills.sha256], trashed: [], deleted: [] });
  });

  it('row-level security hides the deleted-content record from other users', async () => {
    const asBob = await withUser(
      harness.ctx.db,
      bob.userId,
      (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM deleted_content`,
    );
    expect(asBob[0]!.n).toBe(0n);
  });
});
