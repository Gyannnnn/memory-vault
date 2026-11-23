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

vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

let harness: Harness;
let server: ReturnType<Harness['app']['listen']>;
let baseUrl: string;
let tokens: StoredTokens;

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
