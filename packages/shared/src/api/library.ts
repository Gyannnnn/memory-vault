import { z } from 'zod';
import { mediaKinds, type MediaKind } from '../media-kinds';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');
const csvOf = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(z.enum(values)).max(20));

export const browsableKinds = ['photo', 'video', 'raw'] as const satisfies readonly MediaKind[];

/** Filters shared by search, the map side panel and any filtered grid. */
export const assetSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  kind: csvOf(mediaKinds).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  camera: z.string().trim().max(200).optional(),
  /** One or more place ids (places with the same name are grouped in facets). */
  place: z
    .string()
    .transform((value) => value.split(',').filter(Boolean).map(Number))
    .pipe(z.array(z.number().int().positive()).min(1).max(50))
    .optional(),
  source: z
    .string()
    .regex(/^[a-z0-9-]+(:[\w.-]+)?$/i)
    .max(100)
    .optional(),
  /** west,south,east,north in degrees */
  bbox: z
    .string()
    .transform((value) => value.split(',').map(Number))
    .pipe(
      z.tuple([
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
        z.number().min(-180).max(180),
        z.number().min(-90).max(90),
      ]),
    )
    .optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(120),
});
/** The query string a client sends to GET /v1/assets (validated by `assetSearchQuery`). */
export interface AssetSearchQuery {
  q?: string;
  /** Comma-separated kinds, e.g. "photo,video". */
  kind?: string;
  /** YYYY-MM-DD, inclusive. */
  from?: string;
  to?: string;
  camera?: string;
  /** Comma-separated place ids. */
  place?: string;
  source?: string;
  /** "west,south,east,north" */
  bbox?: string;
  cursor?: string;
  limit?: number;
}

export const timelineMonthParam = month;
export const onThisDayQuery = z.object({ date: isoDate });

export interface MediaUrls {
  /** 400 px WebP */
  sm: string;
  /** 1080 px WebP */
  md: string;
}

/** What a grid needs to draw one item. */
export interface AssetTile {
  id: string;
  kind: MediaKind;
  name: string;
  width: number | null;
  height: number | null;
  /** Wall-clock capture time, ISO without zone, e.g. 2025-01-01T09:30:00 */
  localAt: string;
  durationMs: number | null;
  isMotionPhoto: boolean;
  thumb: MediaUrls | null;
}

export interface TimelineBucket {
  month: string;
  count: number;
  /**
   * Per day, newest first: [photos, sum of their width/height ratios (each clamped to 0.5–2.5)].
   * Enough to estimate the month's height before loading it.
   */
  days: [number, number][];
}

export interface TimelineResponse {
  total: number;
  /** Photos and videos not processed yet: no preview, and dated by their file time for now. */
  pending: number;
  buckets: TimelineBucket[];
}

export interface AssetPage {
  items: AssetTile[];
  nextCursor: string | null;
  /** Only on the first page. */
  total?: number;
}

export interface PlaceSummary {
  id: number;
  name: string;
  admin1: string | null;
  country: string | null;
}

export interface AssetDetail extends AssetTile {
  sizeBytes: number;
  mimeType: string;
  extension: string;
  takenAt: string | null;
  takenAtOffsetMinutes: number | null;
  /** Where the capture time came from: exif, exif-local, file-name, file-modified or unknown. */
  takenAtSource: string;
  camera: { make: string | null; model: string | null; lens: string | null };
  exif: Record<string, string | number | boolean>;
  location: {
    latitude: number;
    longitude: number;
    altitude: number | null;
    place: PlaceSummary | null;
  } | null;
  origins: { sourceId: string; path: string; modifiedAt: string | null }[];
  folders: { folderId: string; path: string }[];
  preview: { lg: string; md: string } | null;
  /** Presigned, shown inline; for video playback and opening the original. */
  originalUrl: string;
  processing: { done: boolean; error: string | null };
}

export interface FolderSummary {
  id: string;
  name: string;
  folderCount: number;
  fileCount: number;
  cover: MediaUrls | null;
}

export interface FolderFile {
  entryId: string;
  name: string;
  asset: AssetTile;
  sizeBytes: number;
}

export interface FolderListing {
  folder: { id: string; name: string; path: { id: string; name: string }[] };
  folders: FolderSummary[];
  files: FolderFile[];
  nextCursor: string | null;
  fileTotal: number;
}

export interface MapPointsResponse {
  /** [id, latitude, longitude, isVideo (1/0)] */
  points: [string, number, number, number][];
}

export interface FacetsResponse {
  years: { year: number; count: number }[];
  cameras: { name: string; count: number }[];
  /** Grouped by name, state and country; `ids` are every place with that name. */
  places: (PlaceSummary & { ids: number[]; count: number })[];
  sources: { id: string; count: number }[];
  kinds: { kind: MediaKind; count: number }[];
}

export interface OnThisDayResponse {
  groups: { year: number; yearsAgo: number; total: number; items: AssetTile[] }[];
}
