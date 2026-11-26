import { z } from 'zod';
import { sourceIdSchema } from '../sources';

export const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex SHA-256');
export const sha256Base64Schema = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, 'expected a base64 SHA-256');

const MiB = 1024 * 1024;
export const MAX_FILE_BYTES = 5 * 1024 ** 4;
export const SINGLE_PUT_MAX_BYTES = 16 * MiB;
const MIN_PART_BYTES = 16 * MiB;
const MAX_PARTS = 9000;

/** How a file of `size` bytes is split for upload. Both client and server use this. */
export function uploadPlan(
  size: number,
): { mode: 'single' } | { mode: 'multipart'; partSize: number; partCount: number } {
  if (size <= SINGLE_PUT_MAX_BYTES) return { mode: 'single' };
  const partSize = Math.max(MIN_PART_BYTES, Math.ceil(size / MAX_PARTS / MiB) * MiB);
  return { mode: 'multipart', partSize, partCount: Math.ceil(size / partSize) };
}

export const originSchema = z.object({
  sourceId: sourceIdSchema,
  path: z.string().min(1).max(4096),
  modifiedAt: z.iso.datetime().optional(),
  localPath: z.string().max(4096).optional(),
});
export type Origin = z.infer<typeof originSchema>;

export const checkUploadsRequest = z.object({
  items: z
    .array(z.object({ sha256: sha256HexSchema, size: z.number().int().nonnegative() }))
    .min(1)
    .max(1000),
});
export const checkUploadsResponse = z.object({
  /** Already stored (including what is in Trash): don't upload, just record where it was found. */
  existing: z.array(sha256HexSchema),
  /** The part of `existing` that is in Trash. */
  trashed: z.array(sha256HexSchema).default([]),
  /** Deleted for good by the owner: not stored, and not uploaded again unless asked. */
  deleted: z.array(z.object({ sha256: sha256HexSchema, purgedAt: z.string() })).default([]),
});

export const recordOriginsRequest = z.object({
  items: z
    .array(originSchema.extend({ sha256: sha256HexSchema }))
    .min(1)
    .max(500),
});
export const recordOriginsResponse = z.object({ recorded: z.number(), unknown: z.array(sha256HexSchema) });

export const createUploadRequest = z.object({
  sha256: sha256HexSchema,
  size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
  mimeType: z.string().min(1).max(255),
  origin: originSchema,
});

export const signedRequestSchema = z.object({
  url: z.url(),
  headers: z.record(z.string(), z.string()),
});

export const createUploadResponse = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('exists'), assetId: z.uuid() }),
  z.object({
    mode: z.literal('single'),
    uploadId: z.uuid(),
    assetId: z.uuid(),
    request: signedRequestSchema,
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    mode: z.literal('multipart'),
    uploadId: z.uuid(),
    assetId: z.uuid(),
    partSize: z.number().int().positive(),
    partCount: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  }),
]);

export const presignPartsRequest = z.object({
  parts: z
    .array(z.object({ partNumber: z.number().int().min(1).max(10_000), sha256: sha256Base64Schema }))
    .min(1)
    .max(100),
});
export const presignPartsResponse = z.object({
  parts: z.array(z.object({ partNumber: z.number().int() }).extend(signedRequestSchema.shape)),
});

export const uploadedPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  etag: z.string().min(1).max(200),
  sha256: sha256Base64Schema,
});
export const listPartsResponse = z.object({
  parts: z.array(uploadedPartSchema.extend({ size: z.number().int().nonnegative() })),
});

export const completeUploadRequest = z.object({
  parts: z.array(uploadedPartSchema).max(10_000).optional(),
});
export const completeUploadResponse = z.object({
  assetId: z.uuid(),
  sha256: sha256HexSchema,
  s3ChecksumSha256: z.string(),
});

export const verifyAssetsRequest = z.object({ sha256s: z.array(sha256HexSchema).min(1).max(500) });
export const verifyAssetsResponse = z.object({
  results: z.array(
    z.object({
      sha256: sha256HexSchema,
      /** `trashed`: in Trash, still stored; `deleted`: deleted for good by the owner. */
      status: z.enum(['verified', 'missing', 'mismatch', 'unknown', 'trashed', 'deleted']),
      detail: z.string().optional(),
    }),
  ),
});

export type CheckUploadsRequest = z.infer<typeof checkUploadsRequest>;
export type CheckUploadsResponse = z.infer<typeof checkUploadsResponse>;
export type RecordOriginsRequest = z.infer<typeof recordOriginsRequest>;
export type CreateUploadRequest = z.infer<typeof createUploadRequest>;
export type CreateUploadResponse = z.infer<typeof createUploadResponse>;
export type PresignPartsResponse = z.infer<typeof presignPartsResponse>;
export type UploadedPart = z.infer<typeof uploadedPartSchema>;
export type ListPartsResponse = z.infer<typeof listPartsResponse>;
export type CompleteUploadResponse = z.infer<typeof completeUploadResponse>;
export type VerifyAssetsResponse = z.infer<typeof verifyAssetsResponse>;
