import { z } from 'zod';
import type { AssetTile, MediaUrls } from './library';

export const shareKinds = ['photo', 'album', 'folder'] as const;
export type ShareKind = (typeof shareKinds)[number];

export const shareExpiryDays = [1, 7, 30] as const;

export const createShareRequest = z
  .object({
    kind: z.enum(shareKinds),
    targetId: z.uuid(),
    /** 1, 7 or 30 days; null never expires. */
    expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).nullable(),
    allowDownload: z.boolean().default(false),
    password: z.string().min(4, 'Use at least 4 characters').max(200).optional(),
  })
  .strict();
export type CreateShareRequest = z.input<typeof createShareRequest>;

export const shareListQuery = z.object({ targetId: z.uuid().optional() });

export type ShareStatus = 'active' | 'expired' | 'revoked';

/** A link, as its owner sees it. */
export interface ShareLinkSummary {
  id: string;
  kind: ShareKind;
  targetId: string;
  /** The album's or folder's name, or the photo's file name; null if it's gone. */
  title: string | null;
  cover: MediaUrls | null;
  /** Goes after /s/ in the link. */
  token: string;
  allowDownload: boolean;
  hasPassword: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ShareStatus;
  openCount: number;
  lastOpenedAt: string | null;
  createdAt: string;
}

export const unlockShareRequest = z.object({ password: z.string().min(1).max(200) }).strict();

/** What a visitor sees first: a password prompt, or what is shared. */
export type PublicShare =
  | { status: 'locked' }
  | {
      status: 'open';
      kind: ShareKind;
      /** Album or folder name; empty for a single photo. */
      title: string;
      ownerName: string;
      allowDownload: boolean;
      expiresAt: string | null;
      /** Photos and videos it shows. */
      total: number;
    };

export interface SharedFolder {
  id: string;
  name: string;
  fileCount: number;
  folderCount: number;
  cover: MediaUrls | null;
}

export interface SharedPage {
  /** Newest first. File names are left out unless downloads are allowed. */
  items: AssetTile[];
  nextCursor: string | null;
  /** Folder links: the folders inside the one shown, and the way back up to the shared one. */
  folders?: SharedFolder[];
  path?: { id: string; name: string }[];
}

export const sharedPageQuery = z.object({
  cursor: z.string().max(200).optional(),
  folder: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** One shared photo or video: enough to show it, nothing about where or how it was taken. */
export interface SharedAsset extends AssetTile {
  preview: { lg: string; md: string } | null;
  mimeType: string;
  stream: { qualities: number[] } | null;
  motionUrl: string | null;
  /** Only when downloads are allowed. */
  downloadUrl: string | null;
}

export const sharedDownloadRequest = z
  .object({ assetIds: z.array(z.uuid()).min(1).max(5000).optional() })
  .strict();
