import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { awsEnv } from '../env';
import { createS3Client } from './aws';
import { Presigner } from './presign';

const envFile = join(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const sha256 = (data: Buffer, encoding: 'hex' | 'base64') =>
  createHash('sha256').update(data).digest(encoding);

/** Runs against the real bucket, under test/ (expired after a day by the lifecycle rule). */
describe('real S3 behaves like the test gateway', () => {
  const config = awsEnv();
  const s3 = createS3Client(config);
  const presigner = new Presigner(s3, config);
  const prefix = `test/live-${randomUUID()}`;

  it('accepts a presigned PUT only with the signed SHA-256', async () => {
    const body = randomBytes(2048);
    const signed = await presigner.put({
      key: `${prefix}/single.bin`,
      headers: {
        'content-type': 'application/octet-stream',
        'x-amz-checksum-sha256': sha256(body, 'base64'),
        'x-amz-storage-class': 'INTELLIGENT_TIERING',
        'x-amz-meta-sha256': sha256(body, 'hex'),
      },
      expiresInSeconds: 300,
    });
    const tampered = Buffer.from(body);
    tampered[0] = tampered[0]! ^ 1;
    expect((await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: tampered })).status).toBe(
      400,
    );
    expect((await fetch(signed.url, { method: 'PUT', headers: signed.headers, body })).status).toBe(200);
    const head = await s3.send(
      new HeadObjectCommand({
        Bucket: config.S3_BUCKET,
        Key: `${prefix}/single.bin`,
        ChecksumMode: 'ENABLED',
      }),
    );
    expect(head.ChecksumSHA256).toBe(sha256(body, 'base64'));
    expect(head.StorageClass).toBe('INTELLIGENT_TIERING');
    expect(head.Metadata?.sha256).toBe(sha256(body, 'hex'));
  });

  it('builds the composite checksum we expect for multipart uploads', async () => {
    const key = `${prefix}/multi.bin`;
    const parts = [randomBytes(5 * 1024 * 1024), randomBytes(1000)];
    const { UploadId } = await s3.send(
      new CreateMultipartUploadCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        ChecksumAlgorithm: 'SHA256',
        StorageClass: 'INTELLIGENT_TIERING',
      }),
    );
    const uploaded = [];
    for (const [index, data] of parts.entries()) {
      const signed = await presigner.put({
        key,
        query: { partNumber: String(index + 1), uploadId: UploadId! },
        headers: { 'x-amz-checksum-sha256': sha256(data, 'base64') },
        expiresInSeconds: 300,
      });
      const response = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: data });
      expect(response.status).toBe(200);
      uploaded.push({
        PartNumber: index + 1,
        ETag: response.headers.get('etag')!,
        ChecksumSHA256: sha256(data, 'base64'),
      });
    }
    await s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: config.S3_BUCKET,
        Key: key,
        UploadId,
        MultipartUpload: { Parts: uploaded },
      }),
    );
    const composite = createHash('sha256');
    for (const part of uploaded) composite.update(Buffer.from(part.ChecksumSHA256, 'base64'));
    const head = await s3.send(
      new HeadObjectCommand({ Bucket: config.S3_BUCKET, Key: key, ChecksumMode: 'ENABLED' }),
    );
    expect(head.ChecksumSHA256).toBe(`${composite.digest('base64')}-2`);
  });
});
