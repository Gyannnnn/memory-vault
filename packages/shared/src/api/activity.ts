import { z } from 'zod';
import type { ShareKind } from './shares';

export const activityGroups = ['all', 'signins', 'sharing', 'downloads', 'deletions'] as const;
export type ActivityGroup = (typeof activityGroups)[number];

export const activityQuery = z.object({
  group: z.enum(activityGroups).default('all'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface ActivityEvent {
  id: string;
  /** e.g. auth.login, share.opened, asset.purged, download.zip */
  type: string;
  createdAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: Record<string, unknown>;
}

export interface ActivityPage {
  items: ActivityEvent[];
  nextCursor: string | null;
  /** The links that share events on this page refer to. */
  links: Record<string, { title: string | null; kind: ShareKind }>;
}
