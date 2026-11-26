import { z } from 'zod';
import type { AssetTile } from './library';

/** Days an item stays in Trash before it is deleted for good. */
export const TRASH_DAYS = 30;

export const trashRequest = z.object({ ids: z.array(z.uuid()).min(1).max(5000) }).strict();
export type TrashRequest = z.input<typeof trashRequest>;

export const trashPageQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export interface TrashItem extends AssetTile {
  deletedAt: string;
  sizeBytes: number;
  /** When it goes for good: 30 days after it was trashed, or now if "Delete now" was chosen. */
  purgeAt: string;
  /** Why deleting it for good failed last time, if it did. */
  purgeError: string | null;
}

export interface TrashPage {
  items: TrashItem[];
  nextCursor: string | null;
  /** Only on the first page. */
  summary?: {
    count: number;
    bytes: number;
    /** Due to be deleted for good now (past 30 days, or "Delete now"). */
    due: number;
    /** The latest reason a deletion failed, if any is still waiting. */
    problem: string | null;
  };
}
