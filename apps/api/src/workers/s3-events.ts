import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { DeleteMessageCommand, ReceiveMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { extensionOf, fileNameOf, mediaKindOf, mimeTypeOf } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { newId, withUser } from '../db';
import { recordOrigin } from '../library/folders';
import { decodeMetadataValue, encodeMetadataValue, originalKey, parseKey } from '../storage/keys';
import type { Jobs } from './queues';

type EventContext = Pick<AppContext, 'db' | 's3' | 'env' | 'logger'> & { jobs: Jobs };

interface S3EventRecord {
  eventName?: string;
  s3?: { bucket?: { name?: string }; object?: { key?: string; size?: number } };
}

const COPY_PART_BYTES = 1024 ** 3;
const SINGLE_COPY_LIMIT = 5 * 1024 ** 3;
const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

async function activeUser(ctx: EventContext, userId: string): Promise<boolean> {
  const user = await ctx.db.user.findUnique({ where: { id: userId }, select: { status: true } });
  return user?.status === 'active';
}

async function hashObject(ctx: EventContext, key: string): Promise<{ sha256: string; size: number }> {
  const object = await ctx.s3.send(new GetObjectCommand({ Bucket: ctx.env.S3_BUCKET, Key: key }));
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of object.Body as Readable) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

async function copyInto(
  ctx: EventContext,
  from: string,
  to: string,
  size: number,
  metadata: Record<string, string>,
) {
  const Bucket = ctx.env.S3_BUCKET;
  const CopySource = `${Bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
  const common = {
    Bucket,
    Key: to,
    StorageClass: 'INTELLIGENT_TIERING' as const,
    ContentType: mimeTypeOf(from),
  };
  if (size <= SINGLE_COPY_LIMIT) {
    await ctx.s3.send(
      new CopyObjectCommand({
        ...common,
        CopySource,
        ChecksumAlgorithm: 'SHA256',
        MetadataDirective: 'REPLACE',
        Metadata: metadata,
      }),
    );
    return;
  }
  const { UploadId } = await ctx.s3.send(
    new CreateMultipartUploadCommand({ ...common, ChecksumAlgorithm: 'SHA256', Metadata: metadata }),
  );
  const parts = [];
  for (let start = 0, partNumber = 1; start < size; start += COPY_PART_BYTES, partNumber += 1) {
    const end = Math.min(size, start + COPY_PART_BYTES) - 1;
    const result = await ctx.s3.send(
      new UploadPartCopyCommand({
        Bucket,
        Key: to,
        UploadId,
        PartNumber: partNumber,
        CopySource,
        CopySourceRange: `bytes=${start}-${end}`,
      }),
    );
    parts.push({
      PartNumber: partNumber,
      ETag: result.CopyPartResult?.ETag,
      ChecksumSHA256: result.CopyPartResult?.ChecksumSHA256,
    });
  }
  await ctx.s3.send(
    new CompleteMultipartUploadCommand({ Bucket, Key: to, UploadId, MultipartUpload: { Parts: parts } }),
  );
}

/** A file dropped into users/{id}/inbox/: hash it, store it under its content key, index it, remove the drop. */
async function adoptInboxObject(ctx: EventContext, userId: string, key: string, name: string): Promise<void> {
  const { sha256, size } = await hashObject(ctx, key);
  const origin = { sourceId: 's3-direct:inbox', path: name };
  const existing = await withUser(ctx.db, userId, (tx) =>
    tx.asset.findUnique({ where: { userId_sha256: { userId, sha256 } } }),
  );
  if (existing?.status === 'verified') {
    await withUser(ctx.db, userId, (tx) => recordOrigin(tx, userId, existing.id, origin));
  } else {
    const destination = originalKey(userId, sha256, extensionOf(name));
    await copyInto(ctx, key, destination, size, {
      sha256,
      source: encodeMetadataValue(origin.sourceId, 100),
      'original-path': encodeMetadataValue(name, 1200),
    });
    const head = await ctx.s3.send(
      new HeadObjectCommand({ Bucket: ctx.env.S3_BUCKET, Key: destination, ChecksumMode: 'ENABLED' }),
    );
    if (Number(head.ContentLength) !== size) throw new Error(`copy of ${key} has the wrong size`);
    if (size <= SINGLE_COPY_LIMIT && head.ChecksumSHA256 !== hexToBase64(sha256)) {
      throw new Error(`copy of ${key} does not match its SHA-256`);
    }
    const assetId = existing?.id ?? newId();
    await withUser(ctx.db, userId, async (tx) => {
      const data = {
        status: 'verified' as const,
        verifiedAt: new Date(),
        lastSeenInS3At: new Date(),
        s3Key: destination,
        s3ChecksumSha256: head.ChecksumSHA256 ?? null,
        s3VersionId: head.VersionId ?? null,
      };
      if (existing) await tx.asset.update({ where: { id: assetId }, data });
      else {
        await tx.asset.create({
          data: {
            id: assetId,
            userId,
            sha256,
            sizeBytes: BigInt(size),
            mimeType: mimeTypeOf(name),
            kind: mediaKindOf(name),
            extension: extensionOf(name),
            originalName: fileNameOf(name),
            ...data,
          },
        });
      }
      await tx.user.update({
        where: { id: userId },
        data: { storageUsedBytes: { increment: BigInt(size) } },
      });
      await recordOrigin(tx, userId, assetId, origin);
    });
    await ctx.jobs.ingest({ userId, assetId });
  }
  await ctx.s3.send(new DeleteObjectCommand({ Bucket: ctx.env.S3_BUCKET, Key: key }));
  ctx.logger.info({ userId, key, sha256 }, 'indexed a file dropped into the inbox');
}

/** An original nobody recorded (e.g. after restoring an old database): index it from its own metadata. */
export async function adoptOriginal(
  ctx: EventContext,
  userId: string,
  key: string,
  sha256: string,
): Promise<void> {
  const known = await withUser(ctx.db, userId, (tx) =>
    tx.asset.findUnique({ where: { userId_sha256: { userId, sha256 } } }),
  );
  if (known?.status === 'verified') {
    await withUser(ctx.db, userId, (tx) =>
      tx.asset.update({ where: { id: known.id }, data: { lastSeenInS3At: new Date() } }),
    );
    return;
  }
  if (known) return;
  const head = await ctx.s3.send(
    new HeadObjectCommand({ Bucket: ctx.env.S3_BUCKET, Key: key, ChecksumMode: 'ENABLED' }),
  );
  if (head.Metadata?.sha256 !== sha256) {
    ctx.logger.warn(
      { key },
      'original without matching sha256 metadata; leaving it for the integrity report',
    );
    return;
  }
  const path = decodeMetadataValue(head.Metadata['original-path']) ?? fileNameOf(key);
  const sourceId = decodeMetadataValue(head.Metadata.source) ?? 's3-direct:recovered';
  const assetId = newId();
  await withUser(ctx.db, userId, async (tx) => {
    await tx.asset.create({
      data: {
        id: assetId,
        userId,
        sha256,
        sizeBytes: BigInt(head.ContentLength ?? 0),
        mimeType: head.ContentType ?? mimeTypeOf(path),
        kind: mediaKindOf(path),
        extension: extensionOf(key),
        originalName: fileNameOf(path),
        originalModifiedAt: head.Metadata?.['original-mtime']
          ? new Date(head.Metadata['original-mtime'])
          : null,
        s3Key: key,
        s3ChecksumSha256: head.ChecksumSHA256 ?? null,
        s3VersionId: head.VersionId ?? null,
        status: 'verified',
        verifiedAt: new Date(),
        lastSeenInS3At: new Date(),
      },
    });
    await tx.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { increment: BigInt(head.ContentLength ?? 0) } },
    });
    await recordOrigin(tx, userId, assetId, { sourceId, path });
  });
  await ctx.jobs.ingest({ userId, assetId });
  ctx.logger.info({ userId, key }, 'adopted an unrecorded original from its metadata');
}

export async function handleS3Record(ctx: EventContext, record: S3EventRecord): Promise<void> {
  if (!record.eventName?.startsWith('ObjectCreated') || record.s3?.bucket?.name !== ctx.env.S3_BUCKET) return;
  const rawKey = record.s3.object?.key;
  if (!rawKey) return;
  const key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  const parsed = parseKey(key);
  if (!parsed || parsed.kind === 'thumb' || !(await activeUser(ctx, parsed.userId))) return;
  if (parsed.kind === 'inbox') await adoptInboxObject(ctx, parsed.userId, key, parsed.name);
  else await adoptOriginal(ctx, parsed.userId, key, parsed.sha256);
}

export async function consumeS3Events(ctx: EventContext, sqs: SQSClient, signal: AbortSignal): Promise<void> {
  const QueueUrl = ctx.env.SQS_S3_EVENTS_QUEUE_URL;
  if (!QueueUrl) return;
  while (!signal.aborted) {
    const { Messages = [] } = await sqs
      .send(new ReceiveMessageCommand({ QueueUrl, WaitTimeSeconds: 20, MaxNumberOfMessages: 10 }), {
        abortSignal: signal,
      })
      .catch((error: unknown) => {
        if (!signal.aborted) ctx.logger.error({ err: error }, 'could not read S3 events');
        return { Messages: [] };
      });
    for (const message of Messages) {
      try {
        const body = JSON.parse(message.Body ?? '{}') as { Records?: S3EventRecord[]; Event?: string };
        for (const record of body.Records ?? []) await handleS3Record(ctx, record);
        await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle }));
      } catch (error) {
        ctx.logger.error({ err: error, messageId: message.MessageId }, 'S3 event failed; it will be retried');
      }
    }
  }
}
