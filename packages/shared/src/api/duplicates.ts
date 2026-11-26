import { z } from 'zod';
import type { AssetTile } from './library';

export interface DuplicateMember extends AssetTile {
  sizeBytes: number;
  extension: string;
  /** Where it was found first, e.g. "Phone · s21fe/DCIM/Camera". */
  folder: string | null;
}

export interface DuplicateGroup {
  /** The suggested keeper's id; stable while the group is the same. */
  id: string;
  /** Best first. */
  members: DuplicateMember[];
  /** Largest resolution, then the biggest file. Only a suggestion. */
  suggestedKeepId: string;
  /** What the others take up. */
  reclaimableBytes: number;
}

export interface DuplicatesResponse {
  groups: DuplicateGroup[];
  totalGroups: number;
  /** Across every group, keeping each suggested copy. */
  reclaimableBytes: number;
}

export const duplicatesQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** "Not duplicates": these photos are never grouped with each other again. */
export const dismissDuplicatesRequest = z.object({ assetIds: z.array(z.uuid()).min(2).max(50) }).strict();
