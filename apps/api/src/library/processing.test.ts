import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetTile, PendingOriginalsResponse, ProcessingStatusResponse } from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { originalKey } from '../storage/keys';
import { recordOrigin } from './folders';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;

const api = () => request(harness.app);

interface Seed {
  origins: { sourceId: string; path: string }[];
  kind?: 'photo' | 'video';
  modifiedAt: string;
  processed?: boolean;
  error?: string;
}

async function seed(user: SignedInUser, input: Seed): Promise<{ id: string; sha256: string }> {
  const id = newId();
  const sha256 = createHash('sha256').update(id).digest('hex');
  await withUser(harness.ctx.db, user.userId, async (tx) => {
    await tx.asset.create({
      data: {
        id,
        userId: user.userId,
        sha256,
        sizeBytes: 1000n,
        mimeType: input.kind === 'video' ? 'video/mp4' : 'image/jpeg',
        kind: input.kind ?? 'photo',
        extension: input.kind === 'video' ? 'mp4' : 'jpg',
        originalName: input.origins[0]!.path.split('/').at(-1)!,
        originalModifiedAt: new Date(input.modifiedAt),
        s3Key: originalKey(user.userId, sha256, 'jpg'),
        status: 'verified',
        verifiedAt: new Date(),
        processedAt: input.processed ? new Date() : null,
        processingError: input.error ?? null,
      },
    });
    for (const origin of input.origins) await recordOrigin(tx, user.userId, id, origin);
  });
  return { id, sha256 };
}

const pending = (user: SignedInUser, query: string) =>
  api().get(`/v1/processing/pending?${query}`).set(bearer(user.accessToken));
const status = (user: SignedInUser, ids: unknown) =>
  api().post('/v1/processing/status').set(bearer(user.accessToken)).send({ ids });

let newest: { id: string; sha256: string };
let twoPaths: { id: string; sha256: string };
let oldest: { id: string; sha256: string };
let done: { id: string; sha256: string };
let laptopOnly: { id: string; sha256: string };
let failed: { id: string; sha256: string };
let bobs: { id: string; sha256: string };

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  newest = await seed(alice, {
    origins: [{ sourceId: 'phone:s21fe', path: 'DCIM/Camera/20261122_092444.jpg' }],
    modifiedAt: '2026-11-22T03:54:44Z',
  });
  twoPaths = await seed(alice, {
    origins: [
      { sourceId: 'phone:s21fe', path: 'Pictures/Telegram/IMG_1.jpg' },
      { sourceId: 'phone:s21fe', path: 'Download/IMG_1.jpg' },
      { sourceId: 'laptop:s21fe', path: 'backup/IMG_1.jpg' },
    ],
    modifiedAt: '2025-06-01T10:00:00Z',
  });
  oldest = await seed(alice, {
    kind: 'video',
    origins: [{ sourceId: 'phone:s21fe', path: 'DCIM/Camera/20240101_000000.mp4' }],
    modifiedAt: '2024-01-01T10:00:00Z',
  });
  done = await seed(alice, {
    origins: [{ sourceId: 'phone:s21fe', path: 'DCIM/Camera/done.jpg' }],
    modifiedAt: '2026-01-01T10:00:00Z',
    processed: true,
  });
  laptopOnly = await seed(alice, {
    origins: [{ sourceId: 'laptop:s21fe', path: 'Camera/laptop.jpg' }],
    modifiedAt: '2026-02-01T10:00:00Z',
  });
  failed = await seed(alice, {
    origins: [{ sourceId: 'phone:s21fe', path: 'DCIM/broken.jpg' }],
    modifiedAt: '2023-01-01T10:00:00Z',
    error: 'not an image',
  });
  bobs = await seed(bob, {
    origins: [{ sourceId: 'phone:s21fe', path: 'DCIM/Camera/bob.jpg' }],
    modifiedAt: '2026-11-23T10:00:00Z',
  });
});

afterAll(async () => {
  await harness?.close();
});

describe('GET /v1/processing/pending', () => {
  it("lists the caller's unprocessed files from one source, newest first, with every path there", async () => {
    const response = await pending(alice, 'source=phone:s21fe');
    expect(response.status).toBe(200);
    const body = response.body as PendingOriginalsResponse;
    expect(body.items.map((item) => item.assetId)).toEqual([newest.id, twoPaths.id, oldest.id, failed.id]);
    expect(body.total).toBe(4);
    expect(body.totalBytes).toBe(4000);
    expect(body.nextCursor).toBeNull();
    const shared = body.items.find((item) => item.assetId === twoPaths.id)!;
    expect(shared.paths.sort()).toEqual(['Download/IMG_1.jpg', 'Pictures/Telegram/IMG_1.jpg']);
    expect(shared.sha256).toBe(twoPaths.sha256);
    expect(body.items[0]).toMatchObject({ kind: 'photo', sizeBytes: 1000, localAt: expect.any(String) });
    expect(body.items[2]!.kind).toBe('video');
  });

  it('pages with a cursor, totals only on the first page', async () => {
    const first = (await pending(alice, 'source=phone:s21fe&limit=3')).body as PendingOriginalsResponse;
    expect(first.items).toHaveLength(3);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = (await pending(alice, `source=phone:s21fe&limit=3&cursor=${first.nextCursor}`))
      .body as PendingOriginalsResponse;
    expect(second.items.map((item) => item.assetId)).toEqual([failed.id]);
    expect(second.total).toBeNull();
    expect(second.nextCursor).toBeNull();
  });

  it('keeps sources and users apart', async () => {
    const laptop = (await pending(alice, 'source=laptop:s21fe')).body as PendingOriginalsResponse;
    expect(laptop.items.map((item) => item.assetId).sort()).toEqual([laptopOnly.id, twoPaths.id].sort());
    expect(laptop.items.find((item) => item.assetId === twoPaths.id)!.paths).toEqual(['backup/IMG_1.jpg']);
    const ofBob = (await pending(bob, 'source=phone:s21fe')).body as PendingOriginalsResponse;
    expect(ofBob.items.map((item) => item.assetId)).toEqual([bobs.id]);
  });

  it('rejects a bad source or cursor and needs a sign-in', async () => {
    expect((await pending(alice, 'source=nope')).status).toBe(400);
    expect((await pending(alice, 'source=phone:s21fe&cursor=bad')).status).toBe(400);
    expect((await api().get('/v1/processing/pending?source=phone:s21fe')).status).toBe(401);
  });

  it('marks tiles that are still waiting', async () => {
    const response = await api().get('/v1/timeline/2026-11').set(bearer(alice.accessToken));
    const items = (response.body as { items: AssetTile[] }).items;
    expect(items.find((item) => item.id === newest.id)).toMatchObject({ pending: true, thumb: null });
    const january = await api().get('/v1/timeline/2026-01').set(bearer(alice.accessToken));
    expect((january.body as { items: AssetTile[] }).items[0]).toMatchObject({ id: done.id, pending: false });
  });
});

describe('POST /v1/processing/status', () => {
  it("reports done and errors for the caller's files only", async () => {
    const response = await status(alice, [newest.id, done.id, failed.id, bobs.id, newId()]);
    expect(response.status).toBe(200);
    const items = (response.body as ProcessingStatusResponse).items;
    expect(items).toHaveLength(3);
    expect(items.find((item) => item.id === newest.id)).toEqual({ id: newest.id, done: false, error: null });
    expect(items.find((item) => item.id === done.id)).toEqual({ id: done.id, done: true, error: null });
    expect(items.find((item) => item.id === failed.id)).toEqual({
      id: failed.id,
      done: false,
      error: 'not an image',
    });
  });

  it('validates the ids', async () => {
    expect((await status(alice, [])).status).toBe(400);
    expect((await status(alice, ['not-a-uuid'])).status).toBe(400);
    expect(
      (
        await status(
          alice,
          Array.from({ length: 1001 }, () => newId()),
        )
      ).status,
    ).toBe(400);
  });
});

describe('waiting for streaming versions', () => {
  it('lists processed videos without streams, and reports done once they have one', async () => {
    const video = await seed(alice, {
      kind: 'video',
      origins: [{ sourceId: 'phone:s21fe', path: 'DCIM/Camera/clip.mp4' }],
      modifiedAt: '2026-03-01T10:00:00Z',
      processed: true,
    });
    const listed = (await pending(alice, 'source=phone:s21fe&for=streams')).body as PendingOriginalsResponse;
    // Only processed videos: the unprocessed one (oldest) waits for processing first.
    expect(listed.items.map((item) => item.assetId)).toEqual([video.id]);
    const before = await api()
      .post('/v1/processing/status')
      .set(bearer(alice.accessToken))
      .send({ ids: [video.id], for: 'streams' });
    expect((before.body as ProcessingStatusResponse).items).toEqual([
      { id: video.id, done: false, error: null },
    ]);

    await withUser(harness.ctx.db, alice.userId, (tx) =>
      tx.derivative.create({
        data: {
          id: newId(),
          userId: alice.userId,
          assetId: video.id,
          variant: 'hls-360',
          s3Key: `users/${alice.userId}/streams/${video.sha256}/360p.mp4`,
          mimeType: 'video/mp4',
          width: 640,
          height: 360,
          sizeBytes: 1,
        },
      }),
    );
    const after = await api()
      .post('/v1/processing/status')
      .set(bearer(alice.accessToken))
      .send({ ids: [video.id], for: 'streams' });
    expect((after.body as ProcessingStatusResponse).items[0]!.done).toBe(true);
    const relisted = (await pending(alice, 'source=phone:s21fe&for=streams'))
      .body as PendingOriginalsResponse;
    expect(relisted.items).toHaveLength(0);
    expect((await pending(alice, 'source=phone:s21fe&for=everything')).status).toBe(400);
  });
});
