import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListPartsCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import {
  extensionOf,
  fileNameOf,
  mediaKindOf,
  uploadPlan,
  type CompleteUploadResponse,
  type CreateUploadRequest,
  type CreateUploadResponse,
  type ListPartsResponse,
  type Origin,
  type UploadedPart,
  type VerifyAssetsResponse,
} from '@memory-vault/shared';
import type { AppContext } from '../context';
import { newId, withUser, type Tx } from '../db';
import type { UploadSession } from '../generated/prisma/client';
import { badRequest, conflict, HttpError, notFound } from '../http/errors';
import { recordOrigin } from '../library/folders';
import { encodeMetadataValue, originalKey } from '../storage/keys';
import { Presigner } from '../storage/presign';
import type { Jobs } from '../workers/queues';

const UPLOAD_TTL_MS = 6 * 24 * 60 * 60 * 1000;
const URL_TTL_SECONDS = 30 * 60;

type UploadContext = Pick<AppContext, 'db' | 's3' | 'env'> & { jobs?: Jobs | undefined };
type StoredOrigin = Origin;

export const hexToBase64 = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

/** S3's checksum for a multipart object: SHA-256 over the concatenated part digests, plus "-<parts>". */
export function compositeChecksum(partChecksums: string[]): string {
  const digest = createHash('sha256');
  for (const checksum of partChecksums) digest.update(Buffer.from(checksum, 'base64'));
  return `${digest.digest('base64')}-${partChecksums.length}`;
}

export class UploadService {
  private readonly presigner: Presigner;

  constructor(private readonly ctx: UploadContext) {
    this.presigner = new Presigner(ctx.s3, ctx.env);
  }

  private get bucket(): string {
    return this.ctx.env.S3_BUCKET;
  }

  async check(userId: string, sha256s: string[]): Promise<string[]> {
    const assets = await withUser(this.ctx.db, userId, (tx) =>
      tx.asset.findMany({
        where: { userId, sha256: { in: sha256s }, status: 'verified' },
        select: { sha256: true },
      }),
    );
    return assets.map((asset) => asset.sha256);
  }

  async recordOrigins(
    userId: string,
    items: (Origin & { sha256: string })[],
  ): Promise<{ recorded: number; unknown: string[] }> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const assets = await tx.asset.findMany({
        where: { userId, sha256: { in: [...new Set(items.map((item) => item.sha256))] }, status: 'verified' },
        select: { id: true, sha256: true },
      });
      const bySha = new Map(assets.map((asset) => [asset.sha256, asset.id]));
      const unknown: string[] = [];
      let recorded = 0;
      for (const item of items) {
        const assetId = bySha.get(item.sha256);
        if (!assetId) {
          unknown.push(item.sha256);
          continue;
        }
        await recordOrigin(tx, userId, assetId, item);
        recorded += 1;
      }
      return { recorded, unknown };
    });
  }

  private metadata(input: CreateUploadRequest): Record<string, string> {
    return {
      'x-amz-meta-sha256': input.sha256,
      'x-amz-meta-source': encodeMetadataValue(input.origin.sourceId, 100),
      'x-amz-meta-original-path': encodeMetadataValue(input.origin.path, 1200),
      ...(input.origin.modifiedAt ? { 'x-amz-meta-original-mtime': input.origin.modifiedAt } : {}),
    };
  }

  private async presignSingle(session: Pick<UploadSession, 's3Key'>, input: CreateUploadRequest) {
    return this.presigner.put({
      key: session.s3Key,
      headers: {
        'content-type': input.mimeType,
        'x-amz-checksum-sha256': hexToBase64(input.sha256),
        'x-amz-storage-class': 'INTELLIGENT_TIERING',
        ...this.metadata(input),
      },
      expiresInSeconds: URL_TTL_SECONDS,
    });
  }

  async create(userId: string, input: CreateUploadRequest): Promise<CreateUploadResponse> {
    const plan = uploadPlan(input.size);
    const prepared = await withUser(this.ctx.db, userId, async (tx) => {
      const existing = await tx.asset.findUnique({
        where: { userId_sha256: { userId, sha256: input.sha256 } },
      });
      if (existing?.status === 'verified') {
        await recordOrigin(tx, userId, existing.id, input.origin);
        return { kind: 'exists' as const, assetId: existing.id };
      }
      if (existing && existing.sizeBytes !== BigInt(input.size)) {
        throw conflict('A different size was declared for this content earlier');
      }
      const active = existing
        ? await tx.uploadSession.findFirst({
            where: { assetId: existing.id, status: 'uploading', expiresAt: { gt: new Date() } },
            orderBy: { createdAt: 'desc' },
          })
        : null;
      if (active) return { kind: 'resume' as const, session: active };

      await this.assertQuota(tx, userId, input.size);
      const extension = extensionOf(input.origin.path);
      const assetId = existing?.id ?? newId();
      const s3Key = originalKey(userId, input.sha256, extension);
      if (!existing) {
        await tx.asset.create({
          data: {
            id: assetId,
            userId,
            sha256: input.sha256,
            sizeBytes: BigInt(input.size),
            mimeType: input.mimeType,
            kind: mediaKindOf(input.origin.path),
            extension,
            originalName: fileNameOf(input.origin.path),
            originalModifiedAt: input.origin.modifiedAt ? new Date(input.origin.modifiedAt) : null,
            s3Key,
          },
        });
      }
      const session = await tx.uploadSession.create({
        data: {
          id: newId(),
          userId,
          assetId,
          sha256: input.sha256,
          sizeBytes: BigInt(input.size),
          s3Key,
          partSizeBytes: plan.mode === 'multipart' ? plan.partSize : null,
          partCount: plan.mode === 'multipart' ? plan.partCount : 1,
          origin: { ...input.origin, mimeType: input.mimeType },
          expiresAt: new Date(Date.now() + UPLOAD_TTL_MS),
        },
      });
      return { kind: 'new' as const, session };
    });

    if (prepared.kind === 'exists') return { mode: 'exists', assetId: prepared.assetId };
    let session = prepared.session;

    if (session.partSizeBytes === null) {
      return {
        mode: 'single',
        uploadId: session.id,
        assetId: session.assetId,
        request: await this.presignSingle(session, input),
        expiresAt: session.expiresAt.toISOString(),
      };
    }

    if (!session.s3UploadId) {
      const created = await this.ctx.s3.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: session.s3Key,
          ContentType: input.mimeType,
          StorageClass: 'INTELLIGENT_TIERING',
          ChecksumAlgorithm: 'SHA256',
          Metadata: Object.fromEntries(
            Object.entries(this.metadata(input)).map(([name, value]) => [
              name.replace('x-amz-meta-', ''),
              value,
            ]),
          ),
        }),
      );
      session = await withUser(this.ctx.db, userId, (tx) =>
        tx.uploadSession.update({
          where: { id: session.id },
          data: { s3UploadId: created.UploadId ?? null },
        }),
      );
    }
    return {
      mode: 'multipart',
      uploadId: session.id,
      assetId: session.assetId,
      partSize: session.partSizeBytes!,
      partCount: session.partCount,
      expiresAt: session.expiresAt.toISOString(),
    };
  }

  private async assertQuota(tx: Tx, userId: string, size: number): Promise<void> {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId } });
    const reserved = await tx.uploadSession.aggregate({
      where: { userId, status: 'uploading', expiresAt: { gt: new Date() } },
      _sum: { sizeBytes: true },
    });
    const needed = user.storageUsedBytes + (reserved._sum.sizeBytes ?? 0n) + BigInt(size);
    if (needed > user.storageQuotaBytes) {
      throw new HttpError(413, 'quota_exceeded', 'This upload would exceed your storage quota');
    }
  }

  private async activeSession(userId: string, uploadId: string): Promise<UploadSession> {
    const session = await withUser(this.ctx.db, userId, (tx) =>
      tx.uploadSession.findUnique({ where: { id: uploadId } }),
    );
    if (!session) throw notFound('Upload not found');
    if (session.status !== 'uploading') throw conflict(`Upload is ${session.status}`);
    return session;
  }

  async presignParts(userId: string, uploadId: string, parts: { partNumber: number; sha256: string }[]) {
    const session = await this.activeSession(userId, uploadId);
    if (!session.s3UploadId) throw badRequest('This upload is not a multipart upload');
    for (const part of parts) {
      if (part.partNumber > session.partCount)
        throw badRequest(`Part ${part.partNumber} is beyond the last part`);
    }
    return Promise.all(
      parts.map(async (part) => ({
        partNumber: part.partNumber,
        ...(await this.presigner.put({
          key: session.s3Key,
          query: { partNumber: String(part.partNumber), uploadId: session.s3UploadId! },
          headers: { 'x-amz-checksum-sha256': part.sha256 },
          expiresInSeconds: URL_TTL_SECONDS,
        })),
      })),
    );
  }

  async listParts(userId: string, uploadId: string): Promise<ListPartsResponse['parts']> {
    const session = await this.activeSession(userId, uploadId);
    if (!session.s3UploadId) return [];
    const parts: ListPartsResponse['parts'] = [];
    let marker: string | undefined;
    for (;;) {
      const page = await this.ctx.s3.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: session.s3Key,
          UploadId: session.s3UploadId,
          MaxParts: 1000,
          ...(marker ? { PartNumberMarker: marker } : {}),
        }),
      );
      for (const part of page.Parts ?? []) {
        if (!part.PartNumber || !part.ETag || !part.ChecksumSHA256) continue;
        parts.push({
          partNumber: part.PartNumber,
          etag: part.ETag,
          sha256: part.ChecksumSHA256,
          size: part.Size ?? 0,
        });
      }
      if (!page.IsTruncated) return parts;
      marker = page.NextPartNumberMarker;
    }
  }

  private async head(key: string): Promise<HeadObjectCommandOutput | null> {
    try {
      return await this.ctx.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
    } catch (error) {
      const name = (error as { name?: string }).name;
      if (name === 'NotFound' || name === 'NoSuchKey') return null;
      throw error;
    }
  }

  async complete(userId: string, uploadId: string, parts?: UploadedPart[]): Promise<CompleteUploadResponse> {
    const session = await this.activeSession(userId, uploadId);
    let expectedChecksum = hexToBase64(session.sha256);

    if (session.s3UploadId) {
      if (!parts || parts.length !== session.partCount) {
        throw badRequest(`Expected ${session.partCount} parts, got ${parts?.length ?? 0}`);
      }
      const ordered = [...parts].sort((a, b) => a.partNumber - b.partNumber);
      if (ordered.some((part, index) => part.partNumber !== index + 1))
        throw badRequest('Parts must be numbered 1..N');
      expectedChecksum = compositeChecksum(ordered.map((part) => part.sha256));
      try {
        await this.ctx.s3.send(
          new CompleteMultipartUploadCommand({
            Bucket: this.bucket,
            Key: session.s3Key,
            UploadId: session.s3UploadId,
            MultipartUpload: {
              Parts: ordered.map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
                ChecksumSHA256: part.sha256,
              })),
            },
          }),
        );
      } catch (error) {
        // A retry after a lost response finds the upload already completed.
        if ((error as { name?: string }).name !== 'NoSuchUpload') throw error;
      }
    }

    const head = await this.head(session.s3Key);
    const problems: string[] = [];
    if (!head) problems.push('object not found in S3');
    else {
      if (BigInt(head.ContentLength ?? -1) !== session.sizeBytes)
        problems.push(`size is ${head.ContentLength}`);
      if (head.ChecksumSHA256 !== expectedChecksum)
        problems.push(`checksum is ${head.ChecksumSHA256 ?? 'missing'}`);
    }
    if (problems.length > 0) {
      await withUser(this.ctx.db, userId, (tx) =>
        tx.uploadSession.update({ where: { id: session.id }, data: { status: 'failed' } }),
      );
      throw new HttpError(422, 'verification_failed', `Upload did not verify: ${problems.join('; ')}`);
    }

    const origin = session.origin as unknown as StoredOrigin;
    const now = new Date();
    await withUser(this.ctx.db, userId, async (tx) => {
      const asset = await tx.asset.findUniqueOrThrow({ where: { id: session.assetId } });
      await tx.asset.update({
        where: { id: asset.id },
        data: {
          status: 'verified',
          verifiedAt: now,
          lastSeenInS3At: now,
          s3ChecksumSha256: head!.ChecksumSHA256 ?? null,
          s3VersionId: head!.VersionId ?? null,
          storageClass: head!.StorageClass ?? 'INTELLIGENT_TIERING',
        },
      });
      await tx.uploadSession.update({
        where: { id: session.id },
        data: { status: 'completed', completedAt: now },
      });
      if (asset.status !== 'verified') {
        await tx.user.update({
          where: { id: userId },
          data: { storageUsedBytes: { increment: asset.sizeBytes } },
        });
      }
      await recordOrigin(tx, userId, asset.id, origin);
    });
    await this.ctx.jobs?.ingest({
      userId,
      assetId: session.assetId,
      ...(origin.localPath ? { localPath: origin.localPath } : {}),
    });
    return { assetId: session.assetId, sha256: session.sha256, s3ChecksumSha256: head!.ChecksumSHA256! };
  }

  async abort(userId: string, uploadId: string): Promise<void> {
    const session = await this.activeSession(userId, uploadId);
    if (session.s3UploadId) {
      await this.ctx.s3
        .send(
          new AbortMultipartUploadCommand({
            Bucket: this.bucket,
            Key: session.s3Key,
            UploadId: session.s3UploadId,
          }),
        )
        .catch((error: unknown) => {
          if ((error as { name?: string }).name !== 'NoSuchUpload') throw error;
        });
    }
    await withUser(this.ctx.db, userId, (tx) =>
      tx.uploadSession.update({ where: { id: session.id }, data: { status: 'aborted' } }),
    );
  }

  /** Checks objects in S3 right now: they exist, with the recorded size and checksum. */
  async verify(userId: string, sha256s: string[]): Promise<VerifyAssetsResponse['results']> {
    const assets = await withUser(this.ctx.db, userId, (tx) =>
      tx.asset.findMany({ where: { userId, sha256: { in: sha256s } } }),
    );
    const bySha = new Map(assets.map((asset) => [asset.sha256, asset]));
    const results: VerifyAssetsResponse['results'] = [];
    const seen: string[] = [];
    let index = 0;
    const lane = async () => {
      while (index < sha256s.length) {
        const sha256 = sha256s[index++]!;
        const asset = bySha.get(sha256);
        if (!asset || asset.status !== 'verified') {
          results.push({ sha256, status: 'unknown' });
          continue;
        }
        const head = await this.head(asset.s3Key);
        if (!head) results.push({ sha256, status: 'missing' });
        else if (
          BigInt(head.ContentLength ?? -1) !== asset.sizeBytes ||
          head.ChecksumSHA256 !== asset.s3ChecksumSha256
        ) {
          results.push({
            sha256,
            status: 'mismatch',
            detail: `size ${head.ContentLength}, checksum ${head.ChecksumSHA256}`,
          });
        } else {
          results.push({ sha256, status: 'verified' });
          seen.push(asset.id);
        }
      }
    };
    await Promise.all(Array.from({ length: 16 }, lane));
    if (seen.length > 0) {
      await withUser(this.ctx.db, userId, (tx) =>
        tx.asset.updateMany({ where: { id: { in: seen } }, data: { lastSeenInS3At: new Date() } }),
      );
    }
    return results;
  }
}
