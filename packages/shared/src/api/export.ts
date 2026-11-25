import { z } from 'zod';
import { mediaKinds } from '../media-kinds';
import { sha256HexSchema } from './uploads';

/** Everything in the library, a page at a time, for `vault export`. */
export const exportPageQuery = z.object({
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export const exportItem = z.object({
  id: z.uuid(),
  sha256: sha256HexSchema,
  sizeBytes: z.number().int().nonnegative(),
  kind: z.enum(mediaKinds),
  mimeType: z.string(),
  originalName: z.string(),
  /** The file's own modification time, when it was known. */
  modifiedAt: z.string().nullable(),
  takenAt: z.string().nullable(),
  /** Wall-clock capture time, ISO without zone. */
  localAt: z.string(),
  location: z
    .object({ latitude: z.number(), longitude: z.number(), place: z.string().nullable() })
    .nullable(),
  camera: z.string().nullable(),
  /** Every place the file was found, e.g. phone:s21fe → DCIM/Camera/IMG_1.jpg. */
  origins: z.array(z.object({ sourceId: z.string(), path: z.string(), modifiedAt: z.string().nullable() })),
  /** Presigned download, valid for at least two hours. */
  url: z.url(),
});
export type ExportItem = z.infer<typeof exportItem>;

export const exportPageResponse = z.object({
  /** On the first page only. */
  total: z.number().int().nonnegative().nullable(),
  totalBytes: z.number().int().nonnegative().nullable(),
  items: z.array(exportItem),
  nextCursor: z.uuid().nullable(),
});
export type ExportPage = z.infer<typeof exportPageResponse>;
