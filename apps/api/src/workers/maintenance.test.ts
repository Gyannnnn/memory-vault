import { createHash, randomBytes } from 'node:crypto';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { createDb, withUser } from '../db';
import { env } from '../env';
import { runCatalogExport, runIntegrityCheck } from './maintenance';
import { rebuildIndex } from './rebuild';

let harness: Harness;
let user: SignedInUser;
const api = () => request(harness.app);

async function upload(content: Buffer, path: string, sourceId = 'laptop:test') {
  const created = await api()
    .post('/v1/uploads')
    .set(bearer(user.accessToken))
    .send({
      sha256: createHash('sha256').update(content).digest('hex'),
      size: content.length,
      mimeType: 'image/jpeg',
      origin: { sourceId, path, modifiedAt: '2024-05-06T07:08:09.000Z' },
    });
  if (created.body.mode === 'single') {
    await fetch(created.body.request.url, {
      method: 'PUT',
      headers: created.body.request.headers,
      body: content,
    });
    await api().post(`/v1/uploads/${created.body.uploadId}/complete`).set(bearer(user.accessToken)).send({});
  }
  return created.body.assetId as string;
}

const count = (table: 'asset' | 'assetOrigin' | 'fileEntry') =>
  withUser(harness.ctx.db, user.userId, (tx) =>
    table === 'asset'
      ? tx.asset.count()
      : table === 'assetOrigin'
        ? tx.assetOrigin.count()
        : tx.fileEntry.count(),
  );

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  user = await signUp(harness, 'maintenance@example.com');
});

describe('integrity check', () => {
  it('is healthy when database and S3 agree, and flags an object deleted behind its back', async () => {
    const assetId = await upload(randomBytes(500), 'Camera/a.jpg');
    await upload(randomBytes(600), 'Camera/b.jpg');
    const healthy = await runIntegrityCheck(harness.ctx);
    expect(healthy.healthy).toBe(true);

    const asset = await withUser(harness.ctx.db, user.userId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: assetId } }),
    );
    await harness.ctx.s3.send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: asset.s3Key }));
    const broken = await runIntegrityCheck(harness.ctx);
    expect(broken.healthy).toBe(false);
    const mine = broken.users.find((entry) => entry.userId === user.userId)!;
    expect(mine.missingInS3).toEqual([{ assetId, key: asset.s3Key }]);
    const after = await withUser(harness.ctx.db, user.userId, (tx) =>
      tx.asset.findUniqueOrThrow({ where: { id: assetId } }),
    );
    expect(after.status).toBe('missing');
  });
});

describe('rebuild from S3 alone', () => {
  it('restores every asset and every location after the library tables are lost', async () => {
    const photo = randomBytes(700);
    await upload(photo, 'Camera/IMG_1.jpg');
    await upload(photo, 'Trip/IMG_1.jpg');
    await upload(randomBytes(800), 'Camera/IMG_2.jpg', 'phone:test');
    await runCatalogExport(harness.ctx);
    const before = {
      assets: await count('asset'),
      origins: await count('assetOrigin'),
      entries: await count('fileEntry'),
    };
    expect(before).toEqual({ assets: 2, origins: 3, entries: 3 });

    const owner = createDb(env().DATABASE_MIGRATE_URL!);
    await owner.$executeRawUnsafe(
      'TRUNCATE assets, asset_origins, file_entries, folders, derivatives, upload_sessions CASCADE',
    );
    await owner.user.update({ where: { id: user.userId }, data: { storageUsedBytes: 0n } });
    await owner.$disconnect();
    expect(await count('asset')).toBe(0);
    harness.jobs.ingested.length = 0;

    const result = await rebuildIndex({ ...harness.ctx, jobs: harness.jobs }, user.userId, () => undefined);
    expect(result.adopted).toBe(2);
    expect({
      assets: await count('asset'),
      origins: await count('assetOrigin'),
      entries: await count('fileEntry'),
    }).toEqual(before);
    const owner2 = await harness.ctx.db.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(owner2.storageUsedBytes).toBe(1500n);
    expect(harness.jobs.ingested).toHaveLength(2);
  });
});
