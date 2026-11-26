import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DuplicatesResponse } from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { originalKey } from '../storage/keys';
import { recordOrigin } from './folders';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;

const as = (user: SignedInUser) => ({
  get: (path: string) => request(harness.app).get(path).set(bearer(user.accessToken)),
  post: (path: string, body: object) =>
    request(harness.app).post(path).set(bearer(user.accessToken)).send(body),
});

async function seed(
  user: SignedInUser,
  input: {
    name: string;
    phash: string;
    width: number;
    height: number;
    size: number;
    day: string;
    kind?: 'photo' | 'video';
    durationMs?: number;
  },
): Promise<string> {
  const id = newId();
  const sha256 = createHash('sha256').update(id).digest('hex');
  await withUser(harness.ctx.db, user.userId, async (tx) => {
    await tx.asset.create({
      data: {
        id,
        userId: user.userId,
        sha256,
        sizeBytes: BigInt(input.size),
        mimeType: input.kind === 'video' ? 'video/mp4' : 'image/jpeg',
        kind: input.kind ?? 'photo',
        extension: input.kind === 'video' ? 'mp4' : 'jpg',
        originalName: input.name,
        s3Key: originalKey(user.userId, sha256, 'jpg'),
        status: 'verified',
        verifiedAt: new Date(),
        takenAt: new Date(`${input.day}T10:00:00Z`),
        takenAtOffsetMinutes: 0,
        width: input.width,
        height: input.height,
        durationMs: input.durationMs ?? null,
        phash: input.phash,
        processedAt: new Date(),
      },
    });
    await recordOrigin(tx, user.userId, id, { sourceId: 'phone:s21fe', path: `DCIM/Camera/${input.name}` });
  });
  return id;
}

let camera: string;
let whatsapp: string;

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  camera = await seed(alice, {
    name: 'IMG_1.jpg',
    phash: 'f0f0f0f0aaaa5555',
    width: 4000,
    height: 3000,
    size: 3_000_000,
    day: '2025-12-20',
  });
  whatsapp = await seed(alice, {
    name: 'IMG-WA0001.jpg',
    phash: 'f0f0f0f0aaaa5557',
    width: 1600,
    height: 1200,
    size: 300_000,
    day: '2025-12-20',
  });
  await seed(alice, {
    name: 'other.jpg',
    phash: '0123456789abcdef',
    width: 4000,
    height: 3000,
    size: 2_000_000,
    day: '2025-12-21',
  });
  const trashed = await seed(alice, {
    name: 'copy.jpg',
    phash: 'f0f0f0f0aaaa5554',
    width: 4000,
    height: 3000,
    size: 2_900_000,
    day: '2025-12-20',
  });
  await withUser(harness.ctx.db, alice.userId, (tx) =>
    tx.asset.update({ where: { id: trashed }, data: { deletedAt: new Date() } }),
  );
  await seed(alice, {
    name: 'clip.mp4',
    phash: '1111222233334444',
    width: 1920,
    height: 1080,
    size: 50_000_000,
    day: '2025-12-22',
    kind: 'video',
    durationMs: 12_000,
  });
  await seed(alice, {
    name: 'long.mp4',
    phash: '1111222233334444',
    width: 1920,
    height: 1080,
    size: 90_000_000,
    day: '2025-12-22',
    kind: 'video',
    durationMs: 40_000,
  });
  await seed(bob, {
    name: 'bob.jpg',
    phash: 'f0f0f0f0aaaa5555',
    width: 4000,
    height: 3000,
    size: 3_000_000,
    day: '2025-12-20',
  });
});

afterAll(() => harness.close());

describe('near-duplicates', () => {
  it('groups the caller’s look-alikes, best copy first, leaving out Trash and other people', async () => {
    const response = (await as(alice).get('/v1/duplicates')).body as DuplicatesResponse;
    expect(response.totalGroups).toBe(1);
    const [group] = response.groups;
    expect(group!.members.map((member) => member.id)).toEqual([camera, whatsapp]);
    expect(group!.suggestedKeepId).toBe(camera);
    expect(group!.reclaimableBytes).toBe(300_000);
    expect(response.reclaimableBytes).toBe(300_000);
    expect(group!.members[1]).toMatchObject({
      sizeBytes: 300_000,
      extension: 'jpg',
      folder: 'phone:s21fe/DCIM/Camera',
    });
    expect(((await as(bob).get('/v1/duplicates')).body as DuplicatesResponse).totalGroups).toBe(0);
  });

  it('remembers "not duplicates", for the owner only', async () => {
    expect((await as(bob).post('/v1/duplicates/dismiss', { assetIds: [camera, whatsapp] })).body).toEqual({
      dismissed: 0,
    });
    expect(((await as(alice).get('/v1/duplicates')).body as DuplicatesResponse).totalGroups).toBe(1);
    expect((await as(alice).post('/v1/duplicates/dismiss', { assetIds: [whatsapp, camera] })).body).toEqual({
      dismissed: 1,
    });
    expect(((await as(alice).get('/v1/duplicates')).body as DuplicatesResponse).totalGroups).toBe(0);
    const asBob = await withUser(
      harness.ctx.db,
      bob.userId,
      (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM duplicate_dismissals`,
    );
    expect(asBob[0]!.n).toBe(0n);
  });
});
