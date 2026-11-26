import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AlbumSummary,
  PublicShare,
  SharedAsset,
  SharedPage,
  ShareLinkSummary,
} from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { recordOrigin } from '../library/folders';
import { originalKey, thumbKey } from '../storage/keys';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;

const api = () => request(harness.app);
const as = (user: SignedInUser) => ({
  get: (path: string) => api().get(path).set(bearer(user.accessToken)),
  post: (path: string, body?: object) => api().post(path).set(bearer(user.accessToken)).send(body),
  delete: (path: string) => api().delete(path).set(bearer(user.accessToken)),
});
const visitor = (token: string, session?: string) => ({
  get: (path = '') => {
    const call = api().get(`/v1/public/shares/${token}${path}`);
    return session ? call.set('x-share-session', session) : call;
  },
  post: (path: string, body?: object) => {
    const call = api().post(`/v1/public/shares/${token}${path}`);
    return (session ? call.set('x-share-session', session) : call).send(body);
  },
});

/** A processed photo with previews, found at `path` on the laptop. */
async function seed(user: SignedInUser, path: string, day: string): Promise<string> {
  const id = newId();
  const sha256 = createHash('sha256').update(id).digest('hex');
  await withUser(harness.ctx.db, user.userId, async (tx) => {
    await tx.asset.create({
      data: {
        id,
        userId: user.userId,
        sha256,
        sizeBytes: 1000n,
        mimeType: 'image/jpeg',
        kind: 'photo',
        extension: 'jpg',
        originalName: path.split('/').at(-1)!,
        s3Key: originalKey(user.userId, sha256, 'jpg'),
        status: 'verified',
        verifiedAt: new Date(),
        takenAt: new Date(`${day}T10:00:00Z`),
        takenAtOffsetMinutes: 0,
        width: 4000,
        height: 3000,
        gpsLatitude: 15.5,
        gpsLongitude: 73.8,
        processedAt: new Date(),
      },
    });
    for (const variant of ['sm', 'md', 'lg'])
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
          sizeBytes: 100,
        },
      });
    await recordOrigin(tx, user.userId, id, { sourceId: 'laptop:test', path });
  });
  return id;
}

const folderId = (user: SignedInUser, name: string) =>
  withUser(harness.ctx.db, user.userId, (tx) => tx.folder.findFirstOrThrow({ where: { name } })).then(
    (folder) => folder.id,
  );

let day1: string;
let day2: string;
let other: string;
let trashed: string;
let bobs: string;
let album: AlbumSummary;

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  day1 = await seed(alice, 'Trip/Day1/beach.jpg', '2025-12-20');
  day2 = await seed(alice, 'Trip/Day2/hills.jpg', '2025-12-21');
  other = await seed(alice, 'Other/private.jpg', '2025-12-22');
  trashed = await seed(alice, 'Trip/Day1/blurry.jpg', '2025-12-20');
  await withUser(harness.ctx.db, alice.userId, (tx) =>
    tx.asset.update({ where: { id: trashed }, data: { deletedAt: new Date() } }),
  );
  bobs = await seed(bob, 'Bob/bob.jpg', '2025-12-23');
  album = (await as(alice).post('/v1/albums', { name: 'Goa', assetIds: [day1, day2, trashed] }))
    .body as AlbumSummary;
});

afterAll(() => harness.close());

const share = async (user: SignedInUser, body: object) => {
  const response = await as(user).post('/v1/shares', body);
  return { status: response.status, link: response.body as ShareLinkSummary };
};

describe('making and managing links', () => {
  it('shares only what the owner has, and stores the token only hashed and encrypted', async () => {
    const { status, link } = await share(alice, { kind: 'album', targetId: album.id, expiresInDays: 7 });
    expect(status).toBe(201);
    expect(link).toMatchObject({
      kind: 'album',
      title: 'Goa',
      status: 'active',
      allowDownload: false,
      hasPassword: false,
    });
    expect(link.token).toMatch(/^[\w-]{43}$/);
    const row = await harness.owner.shareLink.findUniqueOrThrow({ where: { id: link.id } });
    expect(row.tokenHash).toBe(createHash('sha256').update(link.token).digest('hex'));
    expect(Buffer.from(row.tokenCiphertext).includes(Buffer.from(link.token))).toBe(false);

    expect((await share(bob, { kind: 'album', targetId: album.id, expiresInDays: 7 })).status).toBe(400);
    expect((await share(bob, { kind: 'photo', targetId: day1, expiresInDays: null })).status).toBe(400);
    expect((await share(alice, { kind: 'photo', targetId: trashed, expiresInDays: null })).status).toBe(400);
  });

  it('lists and revokes for the owner only', async () => {
    const mine = (await as(alice).get('/v1/shares')).body.items as ShareLinkSummary[];
    expect(mine).toHaveLength(1);
    expect((await as(bob).get('/v1/shares')).body.items).toEqual([]);
    expect((await as(bob).delete(`/v1/shares/${mine[0]!.id}`)).status).toBe(404);
  });
});

describe('visiting a link', () => {
  let albumLink: ShareLinkSummary;

  beforeAll(async () => {
    albumLink = (await share(alice, { kind: 'album', targetId: album.id, expiresInDays: 30 })).link;
  });

  it('shows the album’s visible photos without names, places or favourites', async () => {
    const summary = (await visitor(albumLink.token).get()).body as PublicShare;
    expect(summary).toMatchObject({
      status: 'open',
      kind: 'album',
      title: 'Goa',
      total: 2,
      allowDownload: false,
    });
    const page = (await visitor(albumLink.token).get('/items')).body as SharedPage;
    expect(page.items.map((item) => item.id)).toEqual([day2, day1]);
    expect(page.items.every((item) => item.name === '' && item.favorite === false)).toBe(true);

    const detail = (await visitor(albumLink.token).get(`/assets/${day1}`)).body as SharedAsset &
      Record<string, unknown>;
    expect(detail.preview?.lg).toBeTruthy();
    expect(detail.downloadUrl).toBeNull();
    for (const key of ['location', 'exif', 'origins', 'folders', 'camera', 'albums'])
      expect(detail[key]).toBeUndefined();
  });

  it('reaches nothing outside the album: other photos, trashed ones, other users’ photos', async () => {
    for (const id of [other, trashed, bobs]) {
      expect((await visitor(albumLink.token).get(`/assets/${id}`)).status).toBe(404);
      expect((await visitor(albumLink.token).get(`/assets/${id}/stream.m3u8`)).status).toBe(404);
    }
  });

  it('refuses downloads unless the link allows them', async () => {
    expect((await visitor(albumLink.token).post('/downloads', {})).status).toBe(403);
  });

  it('counts a visit once and tells the owner', async () => {
    await visitor(albumLink.token).get();
    const row = await harness.owner.shareLink.findUniqueOrThrow({ where: { id: albumLink.id } });
    expect(row.openCount).toBe(1);
    const opened = await harness.owner.auditEvent.count({
      where: { userId: alice.userId, type: 'share.opened' },
    });
    expect(opened).toBe(1);
  });
});

describe('folder links', () => {
  it('can walk down the shared folder but never out of it', async () => {
    const trip = await folderId(alice, 'Trip');
    const day1Folder = await folderId(alice, 'Day1');
    const otherFolder = await folderId(alice, 'Other');
    const link = (
      await share(alice, { kind: 'folder', targetId: trip, expiresInDays: null, allowDownload: true })
    ).link;
    const top = (await visitor(link.token).get('/items')).body as SharedPage;
    expect(top.folders?.map((folder) => [folder.name, folder.fileCount])).toEqual([
      ['Day1', 1],
      ['Day2', 1],
    ]);
    expect(top.items).toEqual([]);
    expect(top.path?.map((part) => part.name)).toEqual(['Trip']);

    const inside = (await visitor(link.token).get(`/items?folder=${day1Folder}`)).body as SharedPage;
    expect(inside.items.map((item) => item.name)).toEqual(['beach.jpg']);
    expect(inside.path?.map((part) => part.name)).toEqual(['Trip', 'Day1']);

    const outside = await visitor(link.token).get(`/items?folder=${otherFolder}`);
    expect(outside.status).toBe(404);
    expect((await visitor(link.token).get(`/assets/${other}`)).status).toBe(404);

    // Downloads allowed: the original's link, and a zip of the whole folder, only for this link.
    expect(((await visitor(link.token).get(`/assets/${day1}`)).body as SharedAsset).downloadUrl).toBeTruthy();
    const zip = await visitor(link.token).post('/downloads', {});
    expect(zip.status).toBe(201);
    expect(zip.body).toMatchObject({ fileName: 'Trip.zip', fileCount: 2 });
    expect((await as(alice).get(`/v1/downloads/${zip.body.id}`)).status).toBe(404);
    const subset = await visitor(link.token).post('/downloads', { assetIds: [day2, other] });
    expect(subset.body).toMatchObject({ fileCount: 1 });
  });
});

describe('passwords, expiry and revoking', () => {
  it('needs the password, limits guesses, and ties the session to the link', async () => {
    const link = (
      await share(alice, { kind: 'photo', targetId: day1, expiresInDays: 1, password: 'sunset beach' })
    ).link;
    expect(link.hasPassword).toBe(true);
    expect((await visitor(link.token).get()).body).toEqual({ status: 'locked' });
    expect((await visitor(link.token).get('/items')).status).toBe(401);
    expect((await visitor(link.token).post('/unlock', { password: 'wrong' })).status).toBe(401);

    const { session } = (await visitor(link.token).post('/unlock', { password: 'sunset beach' })).body as {
      session: string;
    };
    expect((await visitor(link.token, session).get()).body).toMatchObject({ status: 'open', kind: 'photo' });
    expect(
      ((await visitor(link.token, session).get('/items')).body as SharedPage).items.map((i) => i.id),
    ).toEqual([day1]);

    // The session opens this link only.
    const another = (
      await share(alice, { kind: 'photo', targetId: day2, expiresInDays: 1, password: 'sunset beach' })
    ).link;
    expect((await visitor(another.token, session).get('/items')).status).toBe(401);
    expect((await visitor(link.token, `${session}x`).get('/items')).status).toBe(401);

    for (let attempt = 0; attempt < 9; attempt += 1)
      await visitor(link.token).post('/unlock', { password: 'nope' });
    expect((await visitor(link.token).post('/unlock', { password: 'sunset beach' })).status).toBe(429);
    const failures = await harness.owner.auditEvent.count({
      where: { userId: alice.userId, type: 'share.unlock_failed' },
    });
    expect(failures).toBe(9);
  });

  it('gives the same answer for expired, revoked and unknown links', async () => {
    const expired = (await share(alice, { kind: 'photo', targetId: day2, expiresInDays: 1 })).link;
    await harness.owner.shareLink.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const revoked = (await share(alice, { kind: 'photo', targetId: day2, expiresInDays: 1 })).link;
    expect((await as(alice).delete(`/v1/shares/${revoked.id}`)).status).toBe(204);

    const answers = await Promise.all(
      [expired.token, revoked.token, 'x'.repeat(43)].map(async (token) => {
        const response = await visitor(token).get();
        return [response.status, response.body];
      }),
    );
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]![0]).toBe(404);

    const listed = (await as(alice).get('/v1/shares')).body.items as ShareLinkSummary[];
    expect(listed.find((item) => item.id === expired.id)?.status).toBe('expired');
    expect(listed.find((item) => item.id === revoked.id)?.status).toBe('revoked');
    const audit = await harness.owner.auditEvent.findMany({
      where: { userId: alice.userId, type: { in: ['share.created', 'share.revoked'] } },
    });
    expect(audit.filter((event) => event.type === 'share.revoked')).toHaveLength(1);
  });
});
