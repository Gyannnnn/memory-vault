import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssetDetail } from '@memory-vault/shared';
import { bearer, createHarness, signUp, type Harness, type SignedInUser } from '../../test/helpers';
import { newId, withUser } from '../db';
import { motionKey, originalKey, streamKey } from '../storage/keys';
import { putFile } from '../storage/put-file';
import type { StreamDetails } from '../workers/transcode';
import { recordOrigin } from './folders';

let harness: Harness;
let alice: SignedInUser;
let bob: SignedInUser;
let video: string;
let noStream: string;
const bytes = Buffer.from(Array.from({ length: 4096 }, (_, index) => index % 251));

const playlistFor = (short: number): StreamDetails => ({
  playlist: [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-MAP:URI="${short}p.mp4",BYTERANGE="100@0"`,
    '#EXTINF:4.000000,',
    '#EXT-X-BYTERANGE:3996@100',
    `${short}p.mp4`,
    '#EXT-X-ENDLIST',
    '',
  ].join('\n'),
  fileName: `${short}p.mp4`,
  bandwidth: short * 2000,
  averageBandwidth: short * 1800,
  codecs: 'avc1.64001f,mp4a.40.2',
  frameRate: 30,
  durationSeconds: 4,
});

async function seedVideo(user: SignedInUser, streams: number[]): Promise<string> {
  const id = newId();
  const sha256 = createHash('sha256').update(id).digest('hex');
  await withUser(harness.ctx.db, user.userId, async (tx) => {
    await tx.asset.create({
      data: {
        id,
        userId: user.userId,
        sha256,
        sizeBytes: 5000n,
        mimeType: 'video/mp4',
        kind: 'video',
        extension: 'mp4',
        originalName: 'Holi 2026.mp4',
        s3Key: originalKey(user.userId, sha256, 'mp4'),
        status: 'verified',
        verifiedAt: new Date(),
        width: 1920,
        height: 1080,
        durationMs: 4000,
        processedAt: new Date(),
      },
    });
    await recordOrigin(tx, user.userId, id, { sourceId: 'phone:s21fe', path: 'DCIM/Camera/Holi 2026.mp4' });
    for (const short of streams) {
      await tx.derivative.create({
        data: {
          id: newId(),
          userId: user.userId,
          assetId: id,
          variant: `hls-${short}`,
          s3Key: streamKey(user.userId, sha256, short),
          mimeType: 'video/mp4',
          width: Math.round((short * 16) / 9),
          height: short,
          sizeBytes: bytes.length,
          details: { ...playlistFor(short) },
        },
      });
    }
  });
  for (const short of streams)
    await harness.ctx.s3.send(
      new PutObjectCommand({
        Bucket: harness.ctx.env.S3_BUCKET,
        Key: streamKey(user.userId, sha256, short),
        Body: bytes,
        ContentType: 'video/mp4',
      }),
    );
  return id;
}

const get = (user: SignedInUser | null, path: string) => {
  const call = request(harness.app).get(path);
  return user ? call.set(bearer(user.accessToken)) : call;
};

beforeAll(async () => {
  harness = await createHarness();
  await harness.reset();
  alice = await signUp(harness, 'alice@example.com');
  bob = await signUp(harness, 'bob@example.com');
  video = await seedVideo(alice, [720, 360]);
  noStream = await seedVideo(alice, []);
});

afterAll(async () => {
  await harness?.close();
});

describe('HLS playlists', () => {
  it('lists the renditions smallest first, each relative to the master', async () => {
    const response = await get(alice, `/v1/assets/${video}/stream.m3u8`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/vnd\.apple\.mpegurl/);
    expect(response.text).toBe(
      [
        '#EXTM3U',
        '#EXT-X-VERSION:7',
        '#EXT-X-INDEPENDENT-SEGMENTS',
        '#EXT-X-STREAM-INF:BANDWIDTH=720000,AVERAGE-BANDWIDTH=648000,RESOLUTION=640x360,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=30.000',
        'stream/360.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=1440000,AVERAGE-BANDWIDTH=1296000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",FRAME-RATE=30.000',
        'stream/720.m3u8',
        '',
      ].join('\n'),
    );
  });

  it('points each rendition at a presigned link the player can read by range', async () => {
    const response = await get(alice, `/v1/assets/${video}/stream/720.m3u8`);
    expect(response.status).toBe(200);
    const lines = response.text.split('\n');
    const url = lines[lines.indexOf('#EXT-X-BYTERANGE:3996@100') + 1]!;
    expect(url).toMatch(/^http.*\/streams\/[0-9a-f]{64}\/720p\.mp4\?.*X-Amz-Signature=/);
    expect(response.text).toContain(`#EXT-X-MAP:URI="${url}",BYTERANGE="100@0"`);
    expect(response.text).not.toContain('\n720p.mp4');
    const ranged = await fetch(url, { headers: { range: 'bytes=100-109' } });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(bytes.subarray(100, 110));
  });

  it("is only for the owner, and 404s where there's no stream", async () => {
    expect((await get(bob, `/v1/assets/${video}/stream.m3u8`)).status).toBe(404);
    expect((await get(bob, `/v1/assets/${video}/stream/720.m3u8`)).status).toBe(404);
    expect((await get(null, `/v1/assets/${video}/stream.m3u8`)).status).toBe(401);
    expect((await get(alice, `/v1/assets/${video}/stream/1080.m3u8`)).status).toBe(404);
    expect((await get(alice, `/v1/assets/${noStream}/stream.m3u8`)).status).toBe(404);
    expect((await get(alice, `/v1/assets/${video}/stream/abc.m3u8`)).status).toBe(400);
  });

  it('tells the viewer about streams and gives a download link under the original name', async () => {
    const detail = (await get(alice, `/v1/assets/${video}`)).body as AssetDetail;
    expect(detail.stream).toEqual({ qualities: [360, 720] });
    expect(decodeURIComponent(detail.downloadUrl)).toContain(
      `attachment; filename="Holi 2026.mp4"; filename*=UTF-8''Holi%202026.mp4`,
    );
    expect(((await get(alice, `/v1/assets/${noStream}`)).body as AssetDetail).stream).toBeNull();
  });
});

describe('motion photos', () => {
  it('give the viewer a link to their clip; other photos get none', async () => {
    const made: Record<string, string> = {};
    for (const withClip of [true, false]) {
      const id = newId();
      const sha256 = createHash('sha256').update(id).digest('hex');
      await withUser(harness.ctx.db, alice.userId, async (tx) => {
        await tx.asset.create({
          data: {
            id,
            userId: alice.userId,
            sha256,
            sizeBytes: 100n,
            mimeType: 'image/jpeg',
            kind: 'photo',
            extension: 'jpg',
            originalName: 'motion.jpg',
            s3Key: originalKey(alice.userId, sha256, 'jpg'),
            status: 'verified',
            verifiedAt: new Date(),
            processedAt: new Date(),
            isMotionPhoto: withClip,
          },
        });
        if (withClip)
          await tx.derivative.create({
            data: {
              id: newId(),
              userId: alice.userId,
              assetId: id,
              variant: 'motion',
              s3Key: motionKey(alice.userId, sha256),
              mimeType: 'video/mp4',
              width: 960,
              height: 720,
              sizeBytes: 1,
            },
          });
      });
      made[String(withClip)] = id;
    }
    const clip = (await get(alice, `/v1/assets/${made.true}`)).body as AssetDetail;
    expect(clip.motionUrl).toMatch(/\/streams\/[0-9a-f]{64}\/motion\.mp4\?.*X-Amz-Signature=/);
    expect(((await get(alice, `/v1/assets/${made.false}`)).body as AssetDetail).motionUrl).toBeNull();
    expect((await get(bob, `/v1/assets/${made.true}`)).status).toBe(404);
  });
});

describe('putFile', () => {
  it('uploads small files whole and large ones in checked parts', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'put-file-'));
    try {
      for (const [name, size] of [
        ['small.bin', 3000],
        ['large.bin', 11 * 1024 * 1024 + 7],
      ] as const) {
        const content = Buffer.alloc(size, name);
        const path = join(directory, name);
        writeFileSync(path, content);
        const key = `test/put-file/${name}`;
        const written = await putFile(
          harness.ctx,
          { key, path, contentType: 'application/octet-stream' },
          { singleMaxBytes: 5 * 1024 * 1024, partBytes: 5 * 1024 * 1024 },
        );
        expect(written).toBe(size);
        const object = await harness.ctx.s3.send(
          new GetObjectCommand({ Bucket: harness.ctx.env.S3_BUCKET, Key: key }),
        );
        const stored = Buffer.from(await object.Body!.transformToByteArray());
        expect(createHash('sha256').update(stored).digest('hex')).toBe(
          createHash('sha256').update(content).digest('hex'),
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
