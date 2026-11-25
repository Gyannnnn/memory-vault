import { z } from 'zod';
import type { MediaUrls } from './library';

export const albumName = z.string().trim().min(1, 'Give the album a name').max(200);

export const createAlbumRequest = z
  .object({ name: albumName, assetIds: z.array(z.uuid()).max(5000).default([]) })
  .strict();
export type CreateAlbumRequest = z.input<typeof createAlbumRequest>;

export const updateAlbumRequest = z
  .object({ name: albumName.optional(), coverAssetId: z.uuid().nullable().optional() })
  .strict()
  .refine((value) => value.name !== undefined || value.coverAssetId !== undefined, 'Nothing to change');
export type UpdateAlbumRequest = z.input<typeof updateAlbumRequest>;

export const albumItemsRequest = z.object({ assetIds: z.array(z.uuid()).min(1).max(5000) }).strict();
export type AlbumItemsRequest = z.input<typeof albumItemsRequest>;

export const favoriteRequest = z
  .object({ ids: z.array(z.uuid()).min(1).max(5000), favorite: z.boolean() })
  .strict();
export type FavoriteRequest = z.input<typeof favoriteRequest>;

export interface AlbumSummary {
  id: string;
  name: string;
  /** Photos and videos in it now (trashed ones don't count). */
  count: number;
  /** The chosen cover, or the newest item. */
  cover: MediaUrls | null;
  createdAt: string;
  updatedAt: string;
}

export interface AlbumList {
  favorites: { count: number; cover: MediaUrls | null };
  albums: AlbumSummary[];
}
