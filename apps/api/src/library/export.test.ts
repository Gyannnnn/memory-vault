import { createHash } from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportPageResponse, type ExportPage } from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { originalKey } from '../storage/keys';
import { recordOrigin } from './folders';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;
const bodies = new Map<string, Buffer>();

async function seed(user: SignedInUser, origins: { sourceId: string; path: string }[], body: string) {
  const id = newId();
  const data = Buffer.from(body);
  const sha256 = createHash('sha256').update(data).digest('hex');
  await harness.ctx.s3.send(
    new PutObjectCommand({
      Bucket: harness.ctx.env.S3_BUCKET,
      Key: originalKey(user.userId, sha256, 'jpg'),
      Body: data,
    }),
  );
  await withUser(harness.ctx.db, user.userId, async (tx) => {
    await tx.asset.create({
      data: {
        id,
        userId: user.userId,
        sha256,
        sizeBytes: BigInt(data.length),
        mimeType: 'image/jpeg',
        kind: 'photo',
        extension: 'jpg',
        originalName: origins[0]!.path.split('/').at(-1)!,
        originalModifiedAt: new Date('2026-11-22T03:54:44Z'),
        takenAt: new Date('2026-11-22T03:54:40Z'),
        s3Key: originalKey(user.userId, sha256, 'jpg'),
        status: 'verified',
        verifiedAt: new Date(),
        processedAt: new Date(),
        cameraMake: 'samsung',
        cameraModel: 'SM-G990B2',
        gpsLatitude: 21.47,
        gpsLongitude: 83.87,
      },
    });
    for (const origin of origins)
      await recordOrigin(tx, user.userId, id, { ...origin, modifiedAt: '2026-11-22T03:54:44.000Z' });
  });
  bodies.set(id, data);
  return id;
}

const page = (user: SignedInUser, query: string) =>
  request(harness.app).get(`/v1/export?${query}`).set(bearer(user.accessToken));

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  await seed(alice, [{ sourceId: 'phone:s21fe', path: 'DCIM/Camera/a.jpg' }], 'first photo');
  await seed(
    alice,
    [
      { sourceId: 'laptop:s21fe', path: 'Camera/b.jpg' },
      { sourceId: 'phone:s21fe', path: 'Download/b.jpg' },
    ],
    'second photo',
  );
  await seed(alice, [{ sourceId: 'web:browser', path: 'Trip/c.jpg' }], 'third photo');
  await seed(bob, [{ sourceId: 'phone:s21fe', path: 'DCIM/bob.jpg' }], "bob's photo");
});

afterAll(async () => {
  await harness?.close();
});

describe('GET /v1/export', () => {
  it('lists the whole library in pages, with every origin and a working link to each original', async () => {
    const first = (await page(alice, 'limit=2')).body as ExportPage;
    expect(first).toMatchObject({
      total: 3,
      totalBytes: 'first photo'.length + 'second photo'.length + 'third photo'.length,
    });
    expect(first.items).toHaveLength(2);
    const second = (await page(alice, `limit=2&cursor=${first.nextCursor}`)).body as ExportPage;
    expect(second.total).toBeNull();
    expect(second.nextCursor).toBeNull();
    // Exactly what the CLI's API client accepts.
    expect(() => exportPageResponse.parse(first)).not.toThrow();
    expect(() => exportPageResponse.parse(second)).not.toThrow();
    const items = [...first.items, ...second.items];
    expect(items.map((item) => item.id)).toEqual([...items.map((item) => item.id)].sort());
    const shared = items.find((item) => item.origins.length === 2)!;
    expect(shared.origins).toEqual([
      { sourceId: 'laptop:s21fe', path: 'Camera/b.jpg', modifiedAt: '2026-11-22T03:54:44.000Z' },
      { sourceId: 'phone:s21fe', path: 'Download/b.jpg', modifiedAt: '2026-11-22T03:54:44.000Z' },
    ]);
    expect(shared).toMatchObject({
      kind: 'photo',
      camera: 'samsung SM-G990B2',
      takenAt: '2026-11-22T03:54:40.000Z',
      modifiedAt: '2026-11-22T03:54:44.000Z',
      location: { latitude: 21.47, longitude: 83.87, place: null },
    });
    for (const item of items) {
      const response = await fetch(item.url);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(bodies.get(item.id));
    }
  });

  it("never includes another user's files", async () => {
    const ofBob = (await page(bob, 'limit=100')).body as ExportPage;
    expect(ofBob.total).toBe(1);
    expect(ofBob.items[0]!.origins[0]!.path).toBe('DCIM/bob.jpg');
    expect((await page(alice, 'cursor=nope')).status).toBe(400);
    expect((await request(harness.app).get('/v1/export')).status).toBe(401);
  });
});
