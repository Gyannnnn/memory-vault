import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApiClient, type StoredTokens } from '@memory-vault/api-client';
import { uploadPlan } from '@memory-vault/shared';
import { scanLocalSource } from '../../../cli/src/commands/scan';
import { Manifest } from '../../../cli/src/manifest/manifest';
import { buildReconciliation } from '../../../cli/src/report/reconcile';
import { runUpload } from '../../../cli/src/upload/engine';
import { createHarness, signUp, type Harness } from '../../test/helpers';
import { withUser } from '../db';
import { purgeTrash } from '../library/trash';

vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

let harness: Harness;
let server: ReturnType<Harness['app']['listen']>;
let baseUrl: string;
let tokens: StoredTokens;
let userId: string;

const store = {
  load: () => tokens,
  save: (next: StoredTokens) => {
    tokens = next;
  },
  clear: () => undefined,
};

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  server = harness.app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const user = await signUp(harness, 'e2e@example.com');
  userId = user.userId;
  const me = await harness.ctx.db.user.findUniqueOrThrow({ where: { id: user.userId } });
  tokens = {
    accessToken: user.accessToken,
    accessTokenExpiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    refreshToken: user.refreshToken,
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    sessionId: user.sessionId,
    user: { id: me.id, email: me.email, displayName: me.displayName },
  };
});
afterAll(async () => {
  server.close();
  await harness.close();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vault-e2e-'));
  for (const folder of ['Camera', 'Trip', 'WhatsApp Images']) mkdirSync(join(root, folder));
  const photo = randomBytes(3000);
  const video = randomBytes(40 * 1024 * 1024 + 17);
  writeFileSync(join(root, 'Camera/IMG_1.jpg'), photo);
  writeFileSync(join(root, 'Trip/IMG_1.jpg'), photo);
  writeFileSync(join(root, 'Camera/VID_1.mp4'), video);
  writeFileSync(join(root, 'WhatsApp Images/IMG-20240101-WA0001.jpg'), randomBytes(2000));
  writeFileSync(join(root, 'Camera/.temp-1.mp4'), '');
  return { root, video };
}

const noPhone = () => Promise.reject(new Error('no phone in this test'));

describe('vault scan + upload, end to end', () => {
  it('uploads everything exactly once, resumes a half-done multipart upload and reconciles every file', async () => {
    const { root, video } = fixture();
    const manifest = new Manifest(':memory:');
    const api = createApiClient({ baseUrl, tokens: store });
    const presign = vi.spyOn(api, 'presignParts');
    await scanLocalSource(manifest, 'laptop:e2e', root);

    const plan = uploadPlan(video.length);
    if (plan.mode !== 'multipart') throw new Error('expected multipart');
    const started = await api.createUpload({
      sha256: createHash('sha256').update(video).digest('hex'),
      size: video.length,
      mimeType: 'video/mp4',
      origin: { sourceId: 'laptop:e2e', path: 'Camera/VID_1.mp4' },
    });
    if (started.mode !== 'multipart') throw new Error('expected multipart');
    const first = video.subarray(0, plan.partSize);
    const [target] = (
      await api.presignParts(started.uploadId, [
        { partNumber: 1, sha256: createHash('sha256').update(first).digest('base64') },
      ])
    ).parts;
    await fetch(target!.url, { method: 'PUT', headers: target!.headers, body: first });
    presign.mockClear();

    const options = {
      sourceIds: ['laptop:e2e'],
      apiUrl: baseUrl,
      retryFailed: false,
      parallelParts: 4,
      parallelFiles: 2,
      stagePhoneFile: noPhone,
    };
    const run = await runUpload(manifest, api, options);
    expect(run).toMatchObject({
      uploaded: 2,
      deduplicated: 1,
      failed: 0,
      awaitingReview: 2,
      interrupted: false,
    });
    const resumedParts = presign.mock.calls.flatMap(([, parts]) => parts.map((part) => part.partNumber));
    expect(resumedParts.sort()).toEqual([2, 3]);

    manifest.setDecision('laptop:e2e', 'WhatsApp Images/IMG-20240101-WA0001.jpg', 'approved');
    manifest.setDecision('laptop:e2e', 'Camera/.temp-1.mp4', 'skipped');
    const second = await runUpload(manifest, api, options);
    expect(second).toMatchObject({ uploaded: 1, failed: 0, awaitingReview: 0 });

    const again = await runUpload(manifest, api, options);
    expect(again.uploaded + again.deduplicated + again.failed).toBe(0);

    const report = await buildReconciliation(manifest, ['laptop:e2e'], api);
    const source = report.sources[0]!;
    expect(report.total.invariantHolds).toBe(true);
    expect(source.found.files).toBe(5);
    expect(source.buckets.uploaded.files).toBe(3);
    expect(source.buckets.deduplicated.files).toBe(1);
    expect(source.buckets.skipped.files).toBe(1);
    expect(source.notUploaded.map((row) => row.path)).toEqual(['Camera/.temp-1.mp4']);
    expect(report.verification).toMatchObject({ checked: 3, verified: 3, problems: [] });
    expect(source.safeToDelete?.sort()).toEqual([
      'Camera/IMG_1.jpg',
      'Camera/VID_1.mp4',
      'Trip/IMG_1.jpg',
      'WhatsApp Images/IMG-20240101-WA0001.jpg',
    ]);
  });
});

describe('vault upload and the vault’s Trash', () => {
  const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  const idOf = (content: Buffer) =>
    withUser(harness.ctx.db, userId, (tx) =>
      tx.asset.findFirstOrThrow({ where: { sha256: sha(content) } }),
    ).then((asset) => asset.id);
  const post = (path: string, body: object) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${tokens.accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('reports trashed and deleted content instead of re-adding it, and re-adds it when asked', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vault-trash-'));
    mkdirSync(join(root, 'Camera'));
    const [kept, trashed, deleted] = [randomBytes(2100), randomBytes(2200), randomBytes(2300)];
    writeFileSync(join(root, 'Camera/kept.jpg'), kept);
    writeFileSync(join(root, 'Camera/trashed.jpg'), trashed);
    writeFileSync(join(root, 'Camera/deleted.jpg'), deleted);
    const manifest = new Manifest(':memory:');
    const api = createApiClient({ baseUrl, tokens: store });
    const options = {
      sourceIds: ['laptop:trash'],
      apiUrl: baseUrl,
      retryFailed: false,
      parallelParts: 2,
      parallelFiles: 2,
      stagePhoneFile: noPhone,
    };
    await scanLocalSource(manifest, 'laptop:trash', root);
    expect(await runUpload(manifest, api, options)).toMatchObject({ uploaded: 3, failed: 0 });

    // In the vault: one to Trash, one deleted for good.
    await post('/v1/assets/trash', { ids: [await idOf(trashed), await idOf(deleted)] });
    await post('/v1/trash/delete', { ids: [await idOf(deleted)] });
    expect(await purgeTrash(harness.ctx, { userId })).toEqual({ purged: 1, failed: 0 });

    const report = await buildReconciliation(manifest, ['laptop:trash'], api);
    const source = report.sources[0]!;
    expect(report.verification?.problems).toEqual([]);
    expect(report.total.invariantHolds).toBe(true);
    expect([
      source.buckets.uploaded.files,
      source.buckets.in_trash.files,
      source.buckets.deleted_by_you.files,
    ]).toEqual([1, 1, 1]);
    expect(source.safeToDelete).toEqual(['Camera/kept.jpg']);

    // The same content turns up again in another folder.
    mkdirSync(join(root, 'Copies'));
    writeFileSync(join(root, 'Copies/trashed.jpg'), trashed);
    writeFileSync(join(root, 'Copies/deleted.jpg'), deleted);
    await scanLocalSource(manifest, 'laptop:trash', root);
    // (The first copies stay "uploaded" in the manifest; `vault report --verify` shows them as above.)
    expect(await runUpload(manifest, api, options)).toMatchObject({
      uploaded: 0,
      inTrash: 1,
      deletedByYou: 1,
      failed: 0,
    });
    expect(manifest.files('laptop:trash').find((row) => row.path === 'Copies/deleted.jpg')).toMatchObject({
      status: 'deleted_by_you',
      error: expect.stringContaining('--include-deleted'),
    });

    // Restored in the vault: the next run notices. Asked to: the deleted one comes back.
    await post('/v1/assets/restore', { ids: [await idOf(trashed)] });
    expect(await runUpload(manifest, api, { ...options, includeDeleted: true })).toMatchObject({
      uploaded: 1,
      deduplicated: 1,
      inTrash: 0,
      deletedByYou: 0,
      failed: 0,
    });
    const check = await api.checkUploads([{ sha256: sha(deleted), size: deleted.length }]);
    expect(check).toEqual({ existing: [sha(deleted)], trashed: [], deleted: [] });
  });
});
