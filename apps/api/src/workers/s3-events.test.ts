import { createHash, randomBytes } from 'node:crypto';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { withUser } from '../db';
import { env } from '../env';
import { handleS3Record } from './s3-events';

let harness: Harness;
let user: SignedInUser;

const event = (key: string) => ({
  eventName: 'ObjectCreated:Put',
  s3: {
    bucket: { name: env().S3_BUCKET },
    object: { key: encodeURIComponent(key).replace(/%2F/g, '/').replace(/%20/g, '+') },
  },
});

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  user = await signUp(harness, 'drop@example.com');
});

describe('files dropped directly into S3', () => {
  it('are hashed, stored under their content key, indexed and removed from the inbox', async () => {
    const content = randomBytes(5000);
    const sha256 = createHash('sha256').update(content).digest('hex');
    const key = `users/${user.userId}/inbox/Old phone/IMG 2019.jpg`;
    await harness.ctx.s3.send(new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: key, Body: content }));

    await handleS3Record({ ...harness.ctx, jobs: harness.jobs }, event(key));

    const asset = await withUser(harness.ctx.db, user.userId, (tx) =>
      tx.asset.findUniqueOrThrow({
        where: { userId_sha256: { userId: user.userId, sha256 } },
        include: { origins: true, entries: { include: { folder: true } } },
      }),
    );
    expect(asset.status).toBe('verified');
    expect(asset.s3Key).toBe(`users/${user.userId}/originals/${sha256.slice(0, 2)}/${sha256}.jpg`);
    expect(asset.origins[0]).toMatchObject({
      sourceId: 's3-direct:inbox',
      originalPath: 'Old phone/IMG 2019.jpg',
    });
    expect(asset.entries[0]!.folder.name).toBe('Old phone');
    expect(harness.jobs.ingested).toEqual([{ userId: user.userId, assetId: asset.id }]);
    const copy = await harness.ctx.s3.send(
      new HeadObjectCommand({ Bucket: env().S3_BUCKET, Key: asset.s3Key, ChecksumMode: 'ENABLED' }),
    );
    expect(copy.ChecksumSHA256).toBe(Buffer.from(sha256, 'hex').toString('base64'));
    await expect(
      harness.ctx.s3.send(new HeadObjectCommand({ Bucket: env().S3_BUCKET, Key: key })),
    ).rejects.toThrow();
  });

  it('only records another location when the content is already stored', async () => {
    const content = randomBytes(3000);
    const first = `users/${user.userId}/inbox/a.jpg`;
    const second = `users/${user.userId}/inbox/copy/a.jpg`;
    for (const key of [first, second]) {
      await harness.ctx.s3.send(new PutObjectCommand({ Bucket: env().S3_BUCKET, Key: key, Body: content }));
      await handleS3Record({ ...harness.ctx, jobs: harness.jobs }, event(key));
    }
    const counts = await withUser(harness.ctx.db, user.userId, async (tx) => ({
      assets: await tx.asset.count(),
      origins: await tx.assetOrigin.count(),
    }));
    expect(counts).toEqual({ assets: 1, origins: 2 });
    const owner = await harness.ctx.db.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(owner.storageUsedBytes).toBe(3000n);
  });

  it('ignores thumbnails, other buckets and keys outside a known user', async () => {
    const ctx = { ...harness.ctx, jobs: harness.jobs };
    await handleS3Record(ctx, event(`users/${user.userId}/thumbs/${'a'.repeat(64)}/sm.webp`));
    await handleS3Record(ctx, event('users/_verify/inbox/x.txt'));
    await handleS3Record(ctx, {
      ...event(`users/${user.userId}/inbox/x.jpg`),
      s3: { bucket: { name: 'other' }, object: { key: 'x' } },
    });
    expect(harness.jobs.ingested).toEqual([]);
  });
});
