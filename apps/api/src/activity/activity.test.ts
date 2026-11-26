import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActivityPage } from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { recordOrigin } from '../library/folders';
import { originalKey } from '../storage/keys';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;
let photo: string;

const as = (user: SignedInUser) => ({
  get: (path: string) => request(harness.app).get(path).set(bearer(user.accessToken)),
  post: (path: string, body?: object) =>
    request(harness.app).post(path).set(bearer(user.accessToken)).send(body),
});

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  photo = newId();
  const sha256 = createHash('sha256').update(photo).digest('hex');
  await withUser(harness.ctx.db, alice.userId, async (tx) => {
    await tx.asset.create({
      data: {
        id: photo,
        userId: alice.userId,
        sha256,
        sizeBytes: 5000n,
        mimeType: 'image/jpeg',
        kind: 'photo',
        extension: 'jpg',
        originalName: 'beach.jpg',
        s3Key: originalKey(alice.userId, sha256, 'jpg'),
        status: 'verified',
        verifiedAt: new Date(),
        processedAt: new Date(),
      },
    });
    await recordOrigin(tx, alice.userId, photo, { sourceId: 'laptop:test', path: 'Goa/beach.jpg' });
  });
});

afterAll(() => harness.close());

describe('activity', () => {
  it('records downloads, exports, links and deletions, newest first, for the owner only', async () => {
    const original = await as(alice).get(`/v1/assets/${photo}/original`);
    expect(original.status).toBe(302);
    expect(original.headers.location).toContain('response-content-disposition=attachment');
    expect((await as(bob).get(`/v1/assets/${photo}/original`)).status).toBe(404);
    await as(alice).post('/v1/downloads', { assetIds: [photo] });
    await as(alice).get('/v1/export');
    await as(alice).get('/v1/export?cursor=00000000-0000-0000-0000-000000000000');
    const link = (await as(alice).post('/v1/shares', { kind: 'photo', targetId: photo, expiresInDays: 7 }))
      .body as {
      id: string;
    };
    await as(alice).post('/v1/assets/trash', { ids: [photo] });

    const all = (await as(alice).get('/v1/activity')).body as ActivityPage;
    expect(all.items.slice(0, 5).map((event) => event.type)).toEqual([
      'asset.trashed',
      'share.created',
      'export.started',
      'download.zip',
      'download.original',
    ]);
    expect(all.items.find((event) => event.type === 'download.original')?.metadata).toEqual({
      name: 'beach.jpg',
      bytes: 5000,
    });
    // The photo is in Trash now, so the link shows nothing: no title.
    expect(all.links[link.id]).toEqual({ title: null, kind: 'photo' });
    expect(all.items.some((event) => event.type === 'auth.login')).toBe(true);

    const bobs = (await as(bob).get('/v1/activity')).body as ActivityPage;
    expect(
      bobs.items.every((event) => !event.type.startsWith('download') && !event.type.startsWith('share')),
    ).toBe(true);
  });

  it('filters by kind and pages without gaps or repeats', async () => {
    const types = async (group: string) =>
      ((await as(alice).get(`/v1/activity?group=${group}`)).body as ActivityPage).items.map(
        (event) => event.type,
      );
    expect(await types('downloads')).toEqual(['export.started', 'download.zip', 'download.original']);
    expect(await types('sharing')).toEqual(['share.created']);
    expect(await types('deletions')).toEqual(['asset.trashed']);
    expect(
      (await types('signins')).every((type) => type.startsWith('auth.') || type === 'user.created'),
    ).toBe(true);

    const everything = ((await as(alice).get('/v1/activity?limit=200')).body as ActivityPage).items.map(
      (e) => e.id,
    );
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page = (await as(alice).get(`/v1/activity?limit=2${cursor ? `&cursor=${cursor}` : ''}`))
        .body as ActivityPage;
      paged.push(...page.items.map((event) => event.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(paged).toEqual(everything);
  });
});
