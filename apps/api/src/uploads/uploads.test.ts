import { createHash, randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uploadPlan } from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';

let harness: Harness;
let user: SignedInUser;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
  user = await signUp(harness, 'owner@example.com');
});

const api = () => request(harness.app);
const sha256Hex = (data: Buffer) => createHash('sha256').update(data).digest('hex');
const sha256B64 = (data: Buffer) => createHash('sha256').update(data).digest('base64');

async function put(target: { url: string; headers: Record<string, string> }, body: Buffer) {
  return fetch(target.url, { method: 'PUT', headers: target.headers, body });
}

function createUpload(content: Buffer, path: string, token = user.accessToken) {
  return api()
    .post('/v1/uploads')
    .set(bearer(token))
    .send({
      sha256: sha256Hex(content),
      size: content.length,
      mimeType: 'image/jpeg',
      origin: {
        sourceId: 'laptop:test',
        path,
        modifiedAt: '2024-01-02T03:04:05.000Z',
        localPath: `/src/${path}`,
      },
    });
}

async function uploadMultipart(content: Buffer, path: string, options: { stopAfterParts?: number } = {}) {
  const created = await createUpload(content, path);
  expect(created.body.mode).toBe('multipart');
  const { uploadId, partSize, partCount } = created.body as {
    uploadId: string;
    partSize: number;
    partCount: number;
  };
  const parts = Array.from({ length: partCount }, (_, index) => {
    const data = content.subarray(index * partSize, Math.min(content.length, (index + 1) * partSize));
    return { partNumber: index + 1, data, sha256: sha256B64(data) };
  });
  const limit = options.stopAfterParts ?? partCount;
  const signed = await api()
    .post(`/v1/uploads/${uploadId}/parts`)
    .set(bearer(user.accessToken))
    .send({ parts: parts.slice(0, limit).map(({ partNumber, sha256 }) => ({ partNumber, sha256 })) });
  expect(signed.status).toBe(200);
  for (const [index, target] of (
    signed.body.parts as { url: string; headers: Record<string, string> }[]
  ).entries()) {
    const response = await put(target, parts[index]!.data);
    expect(response.status).toBe(200);
  }
  return { uploadId, parts };
}

describe('single-request uploads', () => {
  it('uploads, verifies the SHA-256 in S3 and mirrors the source folder', async () => {
    const content = randomBytes(1024);
    const created = await createUpload(content, 'Trip/IMG_1.jpg');
    expect(created.status).toBe(200);
    expect(created.body.mode).toBe('single');
    expect((await put(created.body.request, content)).status).toBe(200);

    const completed = await api()
      .post(`/v1/uploads/${created.body.uploadId}/complete`)
      .set(bearer(user.accessToken))
      .send({});
    expect(completed.status).toBe(200);
    expect(completed.body.s3ChecksumSha256).toBe(sha256B64(content));

    const asset = await harness.ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${user.userId}, true)`;
      return tx.asset.findFirstOrThrow({
        include: { entries: { include: { folder: true } }, origins: true },
      });
    });
    expect(asset.status).toBe('verified');
    expect(asset.s3Key).toBe(
      `users/${user.userId}/originals/${asset.sha256.slice(0, 2)}/${asset.sha256}.jpg`,
    );
    expect(asset.entries[0]!.folder.name).toBe('Trip');
    expect(asset.origins[0]!.originalPath).toBe('Trip/IMG_1.jpg');
    expect(harness.jobs.ingested).toEqual([
      { userId: user.userId, assetId: asset.id, localPath: '/src/Trip/IMG_1.jpg' },
    ]);
    const owner = await harness.ctx.db.user.findUniqueOrThrow({ where: { id: user.userId } });
    expect(owner.storageUsedBytes).toBe(1024n);
  });

  it('S3 rejects bytes that do not match the signed checksum', async () => {
    const content = randomBytes(1024);
    const created = await createUpload(content, 'a.jpg');
    const tampered = Buffer.from(content);
    tampered[0] = tampered[0]! ^ 0xff;
    expect((await put(created.body.request, tampered)).status).toBe(400);
    const completed = await api()
      .post(`/v1/uploads/${created.body.uploadId}/complete`)
      .set(bearer(user.accessToken))
      .send({});
    expect(completed.status).toBe(422);
  });

  it('deduplicates by SHA-256 and records every location', async () => {
    const content = randomBytes(2048);
    const first = await createUpload(content, 'Camera/IMG_2.jpg');
    await put(first.body.request, content);
    await api().post(`/v1/uploads/${first.body.uploadId}/complete`).set(bearer(user.accessToken)).send({});

    const again = await createUpload(content, 'Koraput/IMG_2.jpg');
    expect(again.body).toEqual({ mode: 'exists', assetId: first.body.assetId });
    const check = await api()
      .post('/v1/uploads/check')
      .set(bearer(user.accessToken))
      .send({
        items: [
          { sha256: sha256Hex(content), size: content.length },
          { sha256: 'f'.repeat(64), size: 1 },
        ],
      });
    expect(check.body.existing).toEqual([sha256Hex(content)]);
    const origins = await api()
      .post('/v1/assets/origins')
      .set(bearer(user.accessToken))
      .send({
        items: [{ sha256: sha256Hex(content), sourceId: 'phone:test', path: 'DCIM/Camera/IMG_2.jpg' }],
      });
    expect(origins.body).toEqual({ recorded: 1, unknown: [] });

    const entries = await harness.ctx.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.user_id', ${user.userId}, true)`;
      return tx.fileEntry.count({ where: { assetId: first.body.assetId } });
    });
    expect(entries).toBe(3);
  });
});

describe('multipart uploads', () => {
  const size = 20 * 1024 * 1024 + 123;

  it('plans parts deterministically', () => {
    expect(uploadPlan(16 * 1024 * 1024)).toEqual({ mode: 'single' });
    expect(uploadPlan(size)).toEqual({ mode: 'multipart', partSize: 16 * 1024 * 1024, partCount: 2 });
    const huge = uploadPlan(500 * 1024 ** 3);
    expect(huge.mode === 'multipart' && huge.partCount <= 9000).toBe(true);
  });

  it('resumes after an interruption and verifies the composite checksum', async () => {
    const content = randomBytes(size);
    const { uploadId, parts } = await uploadMultipart(content, 'Videos/clip.mp4', { stopAfterParts: 1 });

    const resumed = await createUpload(content, 'Videos/clip.mp4');
    expect(resumed.body.uploadId).toBe(uploadId);
    const listed = await api().get(`/v1/uploads/${uploadId}/parts`).set(bearer(user.accessToken));
    expect(listed.body.parts.map((part: { partNumber: number }) => part.partNumber)).toEqual([1]);
    expect(listed.body.parts[0].sha256).toBe(parts[0]!.sha256);

    const rest = await api()
      .post(`/v1/uploads/${uploadId}/parts`)
      .set(bearer(user.accessToken))
      .send({ parts: [{ partNumber: 2, sha256: parts[1]!.sha256 }] });
    expect((await put(rest.body.parts[0], parts[1]!.data)).status).toBe(200);

    const all = await api().get(`/v1/uploads/${uploadId}/parts`).set(bearer(user.accessToken));
    const completed = await api()
      .post(`/v1/uploads/${uploadId}/complete`)
      .set(bearer(user.accessToken))
      .send({
        parts: all.body.parts.map(({ partNumber, etag, sha256 }: Record<string, unknown>) => ({
          partNumber,
          etag,
          sha256,
        })),
      });
    expect(completed.status).toBe(200);
    expect(completed.body.s3ChecksumSha256).toMatch(/-2$/);
  });

  it('rejects a corrupted part', async () => {
    const content = randomBytes(size);
    const created = await createUpload(content, 'bad.mp4');
    const part = content.subarray(0, created.body.partSize as number);
    const signed = await api()
      .post(`/v1/uploads/${created.body.uploadId}/parts`)
      .set(bearer(user.accessToken))
      .send({ parts: [{ partNumber: 1, sha256: sha256B64(part) }] });
    const corrupted = Buffer.from(part);
    corrupted[100] = corrupted[100]! ^ 0x01;
    expect((await put(signed.body.parts[0], corrupted)).status).toBe(400);
  });

  it('refuses to complete with parts that do not match what was uploaded', async () => {
    const content = randomBytes(size);
    const { uploadId, parts } = await uploadMultipart(content, 'mismatch.mp4');
    const listed = await api().get(`/v1/uploads/${uploadId}/parts`).set(bearer(user.accessToken));
    const lying = listed.body.parts.map(({ partNumber, etag }: Record<string, unknown>) => ({
      partNumber,
      etag,
      sha256: parts[0]!.sha256,
    }));
    const completed = await api()
      .post(`/v1/uploads/${uploadId}/complete`)
      .set(bearer(user.accessToken))
      .send({ parts: lying });
    expect(completed.status).not.toBe(200);
  });
});
