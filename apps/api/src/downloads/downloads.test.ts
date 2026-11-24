import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DownloadSummary } from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { recordOrigin } from '../library/folders';
import { originalKey } from '../storage/keys';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;
const files = new Map<string, Buffer>();
const ids: Record<string, string> = {};

async function seed(
  user: SignedInUser,
  path: string,
  data: Buffer,
  recordedSize = data.length,
): Promise<string> {
  const id = newId();
  const sha256 = createHash('sha256').update(data).update(path).digest('hex');
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
        sizeBytes: BigInt(recordedSize),
        mimeType: 'image/jpeg',
        kind: 'photo',
        extension: 'jpg',
        originalName: path.split('/').at(-1)!,
        originalModifiedAt: new Date('2026-11-22T03:54:44Z'),
        s3Key: originalKey(user.userId, sha256, 'jpg'),
        status: 'verified',
        verifiedAt: new Date(),
        processedAt: new Date(),
      },
    });
    await recordOrigin(tx, user.userId, id, { sourceId: 'phone:s21fe', path });
  });
  files.set(id, data);
  return id;
}

function unzip(zip: Buffer): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'download-test-'));
  try {
    writeFileSync(join(directory, 'd.zip'), zip);
    const script =
      'import hashlib, json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint(json.dumps({i.filename: hashlib.sha256(z.read(i)).hexdigest() for i in z.infolist()}))';
    return JSON.parse(execFileSync('python3', ['-c', script, join(directory, 'd.zip')]).toString()) as Record<
      string,
      string
    >;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const sha = (id: string) => createHash('sha256').update(files.get(id)!).digest('hex');
const create = (user: SignedInUser, body: object) =>
  request(harness.app).post('/v1/downloads').set(bearer(user.accessToken)).send(body);
const fetchZip = (user: SignedInUser, id: string) =>
  request(harness.app)
    .get(`/v1/downloads/${id}`)
    .set(bearer(user.accessToken))
    .buffer(true)
    .parse((response, done) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => done(null, Buffer.concat(chunks)));
      response.on('error', (error) => done(error, null));
    });

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  ids.a = await seed(alice, 'DCIM/Camera/IMG.jpg', Buffer.alloc(3000, 'a'));
  ids.b = await seed(alice, 'DCIM/Camera/Sub/b.jpg', Buffer.alloc(1200, 'b'));
  ids.c = await seed(alice, 'Pictures/IMG.jpg', Buffer.alloc(800, 'c'));
  ids.short = await seed(alice, 'Broken/short.jpg', Buffer.alloc(500, 'x'), 900);
  ids.bobs = await seed(bob, 'DCIM/Camera/bob.jpg', Buffer.alloc(100, 'z'));
});

afterAll(async () => {
  await harness?.close();
});

describe('zip downloads', () => {
  it('zips chosen files under their original names, without clashes, at the announced size', async () => {
    const created = await create(alice, { assetIds: [ids.a, ids.c] });
    expect(created.status).toBe(201);
    const summary = created.body as DownloadSummary;
    expect(summary).toMatchObject({
      fileCount: 2,
      fileName: expect.stringMatching(/^Memory Vault .* \(2 files\)\.zip$/),
    });
    const response = await fetchZip(alice, summary.id);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(Number(response.headers['content-length'])).toBe(summary.totalBytes);
    expect(response.headers['content-disposition']).toContain('attachment; filename="Memory Vault');
    const zip = response.body as Buffer;
    expect(zip.length).toBe(summary.totalBytes);
    expect(unzip(zip)).toEqual({ 'IMG.jpg': sha(ids.a!), 'IMG (2).jpg': sha(ids.c!) });
  });

  it('zips a folder with everything under it, keeping its structure', async () => {
    const [dcim] = await harness.owner.$queryRaw<{ id: string }[]>`
      SELECT id FROM folders WHERE user_id = ${alice.userId}::uuid AND name = 'DCIM'`;
    const summary = (await create(alice, { folderId: dcim!.id })).body as DownloadSummary;
    expect(summary).toMatchObject({ fileName: 'DCIM.zip', fileCount: 2 });
    const zip = (await fetchZip(alice, summary.id)).body as Buffer;
    expect(unzip(zip)).toEqual({ 'Camera/IMG.jpg': sha(ids.a!), 'Camera/Sub/b.jpg': sha(ids.b!) });
  });

  it("never includes another user's files and keeps each download to its owner", async () => {
    expect((await create(alice, { assetIds: [ids.bobs] })).status).toBe(404);
    const mixed = (await create(alice, { assetIds: [ids.a, ids.bobs] })).body as DownloadSummary;
    expect(mixed.fileCount).toBe(1);
    expect((await fetchZip(bob, mixed.id)).status).toBe(404);
    expect((await fetchZip(alice, 'f'.repeat(32))).status).toBe(404);
    expect((await create(alice, { assetIds: [] })).status).toBe(400);
    expect((await create(alice, { folderId: 'nope' })).status).toBe(400);
    expect((await create(alice, { assetIds: [ids.a], folderId: ids.a })).status).toBe(400);
    expect(
      (
        await request(harness.app)
          .post('/v1/downloads')
          .send({ assetIds: [ids.a] })
      ).status,
    ).toBe(401);
  });

  it('cuts the download off instead of saving a broken zip when a file is shorter than recorded', async () => {
    const summary = (await create(alice, { assetIds: [ids.short] })).body as DownloadSummary;
    await expect(fetchZip(alice, summary.id)).rejects.toThrow();
  });
});
