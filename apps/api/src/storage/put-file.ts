import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  UploadPartCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import type { AppContext } from '../context';

const MiB = 1024 * 1024;
const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('base64');

async function withRetries<T>(attempts: number, task: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

/**
 * Uploads a file the worker made (e.g. a video rendition) with a SHA-256 checksum S3 checks.
 * Large files go up in parts, each retried on its own, so a flaky line costs one part, not the file.
 */
export async function putFile(
  ctx: Pick<AppContext, 's3' | 'env'>,
  input: { key: string; path: string; contentType: string; cacheControl?: string },
  sizes: { singleMaxBytes: number; partBytes: number } = { singleMaxBytes: 64 * MiB, partBytes: 16 * MiB },
): Promise<number> {
  const size = statSync(input.path).size;
  const common = {
    Bucket: ctx.env.S3_BUCKET,
    Key: input.key,
    ContentType: input.contentType,
    CacheControl: input.cacheControl ?? 'private, max-age=31536000, immutable',
    StorageClass: 'INTELLIGENT_TIERING' as const,
  };
  if (size <= sizes.singleMaxBytes) {
    const body = await readFile(input.path);
    await withRetries(3, () =>
      ctx.s3.send(new PutObjectCommand({ ...common, Body: body, ChecksumSHA256: sha256(body) })),
    );
    return size;
  }

  const { UploadId } = await ctx.s3.send(
    new CreateMultipartUploadCommand({ ...common, ChecksumAlgorithm: 'SHA256' }),
  );
  const handle = await open(input.path);
  try {
    const parts: CompletedPart[] = [];
    for (let number = 1, offset = 0; offset < size; number += 1, offset += sizes.partBytes) {
      const buffer = Buffer.alloc(Math.min(sizes.partBytes, size - offset));
      await handle.read(buffer, 0, buffer.length, offset);
      const checksum = sha256(buffer);
      const { ETag } = await withRetries(3, () =>
        ctx.s3.send(
          new UploadPartCommand({
            Bucket: ctx.env.S3_BUCKET,
            Key: input.key,
            UploadId,
            PartNumber: number,
            Body: buffer,
            ChecksumSHA256: checksum,
          }),
        ),
      );
      parts.push({ PartNumber: number, ETag, ChecksumSHA256: checksum });
    }
    await ctx.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: ctx.env.S3_BUCKET,
        Key: input.key,
        UploadId,
        MultipartUpload: { Parts: parts },
      }),
    );
    return size;
  } catch (error) {
    await ctx.s3
      .send(new AbortMultipartUploadCommand({ Bucket: ctx.env.S3_BUCKET, Key: input.key, UploadId }))
      .catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}
