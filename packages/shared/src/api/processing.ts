import { z } from 'zod';
import { mediaKinds } from '../media-kinds';
import { sourceIdSchema } from '../sources';
import { sha256HexSchema } from './uploads';

/**
 * Files the worker hasn't processed yet, as recorded in one source. The uploader can
 * place local copies where the waiting jobs look for them, so the worker doesn't have
 * to download the originals from S3.
 */
/** What the files are waiting for: first processing (previews, details), or streaming versions of videos. */
export const pendingWorkSchema = z.enum(['processing', 'streams']);
export type PendingWork = z.infer<typeof pendingWorkSchema>;

export const pendingOriginalsQuery = z.object({
  source: sourceIdSchema,
  for: pendingWorkSchema.default('processing'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
});
export interface PendingOriginalsQuery {
  source: string;
  for?: PendingWork;
  cursor?: string;
  limit?: number;
}

export const pendingOriginal = z.object({
  assetId: z.uuid(),
  kind: z.enum(mediaKinds),
  sizeBytes: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
  /** Wall-clock capture time, ISO without zone. */
  localAt: z.string(),
  /** Every path this file has in the source; the same content can sit in several folders. */
  paths: z.array(z.string()).min(1),
});
export type PendingOriginal = z.infer<typeof pendingOriginal>;

export const pendingOriginalsResponse = z.object({
  /** Totals for the whole source; only on the first page. */
  total: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  items: z.array(pendingOriginal),
  nextCursor: z.string().nullable(),
});
export type PendingOriginalsResponse = z.infer<typeof pendingOriginalsResponse>;

export const processingStatusRequest = z.object({
  ids: z.array(z.uuid()).min(1).max(1000),
  for: pendingWorkSchema.default('processing'),
});

export const processingStatusResponse = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      /** Processed: previews and details are in place. */
      done: z.boolean(),
      /** The last processing error, if the worker failed on it (it retries a few times). */
      error: z.string().nullable(),
    }),
  ),
});
export type ProcessingStatusResponse = z.infer<typeof processingStatusResponse>;
