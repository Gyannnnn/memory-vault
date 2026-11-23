import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { withUser } from '../db';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;
let aliceAsset: { uploadId: string; assetId: string; sha256: string };
let pendingUploadId: string;

const api = () => request(harness.app);
const sha256Hex = (data: Buffer) => createHash('sha256').update(data).digest('hex');

async function upload(user: SignedInUser, content: Buffer, path: string) {
  const created = await api()
    .post('/v1/uploads')
    .set(bearer(user.accessToken))
    .send({
      sha256: sha256Hex(content),
      size: content.length,
      mimeType: 'image/jpeg',
      origin: { sourceId: 'laptop:test', path },
    });
  return created.body as {
    mode: string;
    uploadId: string;
    assetId: string;
    request: { url: string; headers: Record<string, string> };
  };
}

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  const content = randomBytes(4096);
  const created = await upload(alice, content, 'private/photo.jpg');
  await fetch(created.request.url, { method: 'PUT', headers: created.request.headers, body: content });
  await api().post(`/v1/uploads/${created.uploadId}/complete`).set(bearer(alice.accessToken)).send({});
  aliceAsset = { uploadId: created.uploadId, assetId: created.assetId, sha256: sha256Hex(content) };
  pendingUploadId = (await upload(alice, randomBytes(20 * 1024 * 1024), 'big.mp4')).uploadId;
});
afterAll(async () => {
  await harness.close();
});
beforeEach(() => undefined);

describe("no user can reach another user's files", () => {
  it('hides existence from dedup checks', async () => {
    const check = await api()
      .post('/v1/uploads/check')
      .set(bearer(bob.accessToken))
      .send({ items: [{ sha256: aliceAsset.sha256, size: 4096 }] });
    expect(check.body.existing).toEqual([]);
  });

  it('gives the same content its own copy under the other user', async () => {
    const created = await api()
      .post('/v1/uploads')
      .set(bearer(bob.accessToken))
      .send({
        sha256: aliceAsset.sha256,
        size: 4096,
        mimeType: 'image/jpeg',
        origin: { sourceId: 'laptop:bob', path: 'x.jpg' },
      });
    expect(created.body.mode).toBe('single');
    expect(created.body.assetId).not.toBe(aliceAsset.assetId);
    expect(new URL(created.body.request.url).pathname).toContain(`/users/${bob.userId}/`);
  });

  it("refuses to presign, list, complete or abort another user's upload", async () => {
    const sha = Buffer.alloc(32).toString('base64');
    const presign = await api()
      .post(`/v1/uploads/${pendingUploadId}/parts`)
      .set(bearer(bob.accessToken))
      .send({ parts: [{ partNumber: 1, sha256: sha }] });
    expect(presign.status).toBe(404);
    expect(
      (await api().get(`/v1/uploads/${pendingUploadId}/parts`).set(bearer(bob.accessToken))).status,
    ).toBe(404);
    expect(
      (await api().post(`/v1/uploads/${aliceAsset.uploadId}/complete`).set(bearer(bob.accessToken)).send({}))
        .status,
    ).toBe(404);
    expect((await api().delete(`/v1/uploads/${pendingUploadId}`).set(bearer(bob.accessToken))).status).toBe(
      404,
    );
  });

  it('does not list, verify or attach origins to the other user’s assets', async () => {
    const list = await api().get('/v1/assets').set(bearer(bob.accessToken));
    expect(list.body.items).toEqual([]);
    const verify = await api()
      .post('/v1/assets/verify')
      .set(bearer(bob.accessToken))
      .send({ sha256s: [aliceAsset.sha256] });
    expect(verify.body.results).toEqual([{ sha256: aliceAsset.sha256, status: 'unknown' }]);
    const origins = await api()
      .post('/v1/assets/origins')
      .set(bearer(bob.accessToken))
      .send({ items: [{ sha256: aliceAsset.sha256, sourceId: 'laptop:bob', path: 'steal.jpg' }] });
    expect(origins.body).toEqual({ recorded: 0, unknown: [aliceAsset.sha256] });
    const aliceList = await api().get('/v1/assets').set(bearer(alice.accessToken));
    expect(aliceList.body.items).toHaveLength(1);
  });

  it('row-level security hides rows even from raw queries by the app role', async () => {
    const asBob = await withUser(
      harness.ctx.db,
      bob.userId,
      (tx) =>
        tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assets WHERE user_id = ${alice.userId}::uuid`,
    );
    expect(asBob[0]!.n).toBe(0n);
    const noContext = await harness.ctx.db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assets`;
    expect(noContext[0]!.n).toBe(0n);
    const asAlice = await withUser(
      harness.ctx.db,
      alice.userId,
      (tx) => tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM assets`,
    );
    expect(asAlice[0]!.n).toBeGreaterThan(0n);
  });

  it('row-level security blocks writing rows that belong to someone else', async () => {
    await expect(
      withUser(harness.ctx.db, bob.userId, (tx) =>
        tx.folder.create({
          data: { id: crypto.randomUUID(), userId: alice.userId, parentId: null, name: 'planted' },
        }),
      ),
    ).rejects.toThrow();
  });
});
