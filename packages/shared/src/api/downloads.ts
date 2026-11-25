import { z } from 'zod';

/** A zip of chosen files, an album, or a folder with everything under it. */
export const createDownloadRequest = z.union([
  z.object({ assetIds: z.array(z.uuid()).min(1).max(5000) }).strict(),
  z.object({ folderId: z.uuid() }).strict(),
  z.object({ albumId: z.uuid() }).strict(),
]);
export type CreateDownloadRequest = z.infer<typeof createDownloadRequest>;

export interface DownloadSummary {
  /** Fetch GET /v1/downloads/:id within the hour to receive the zip. */
  id: string;
  fileName: string;
  fileCount: number;
  /** Exact size of the zip. */
  totalBytes: number;
}
