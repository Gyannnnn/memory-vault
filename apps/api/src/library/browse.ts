import type {
  AssetDetail,
  AssetPage,
  assetSearchQuery,
  AssetTile,
  FacetsResponse,
  FolderListing,
  MapPointsResponse,
  MediaKind,
  OnThisDayResponse,
  TimelineResponse,
} from '@memory-vault/shared';
import type { z } from 'zod';
import type { AppContext } from '../context';
import { Prisma, withUser, type Tx } from '../db';
import { notFound } from '../http/errors';
import { MediaUrlSigner } from './media-urls';

type SearchInput = z.output<typeof assetSearchQuery>;

interface TileRow {
  id: string;
  kind: MediaKind;
  name: string;
  width: number | null;
  height: number | null;
  local_at: string;
  duration_ms: number | null;
  is_motion_photo: boolean;
  sha256: string;
  has_thumb: boolean;
  pending: boolean;
}

const MEDIA = Prisma.sql`a.kind IN ('photo', 'video', 'raw')`;
const TILE_COLUMNS = Prisma.sql`
  a.id, a.kind::text AS kind, a.original_name AS name, a.width, a.height,
  to_char(a.local_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS local_at,
  a.duration_ms, a.is_motion_photo, a.sha256, a.processed_at IS NULL AS pending,
  EXISTS (SELECT 1 FROM derivatives d WHERE d.asset_id = a.id AND d.variant = 'sm') AS has_thumb`;

export const visible = (userId: string) =>
  Prisma.sql`a.user_id = ${userId}::uuid AND a.status = 'verified' AND a.deleted_at IS NULL`;

/** Keyset cursor over (local_at, id), newest first. */
export function encodeCursor(row: { local_at: string; id: string }): string {
  return Buffer.from(`${row.local_at}|${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { localAt: string; id: string } | null {
  const [localAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return localAt && id && /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(localAt) && /^[0-9a-f-]{36}$/.test(id)
    ? { localAt, id }
    : null;
}

/** "kora 2025" → "kora:* & 2025:*": every word must match the start of a word. */
export function prefixQuery(text: string): string | null {
  const words = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 8);
  return words.length ? words.map((word) => `${word}:*`).join(' & ') : null;
}

const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export class BrowseService {
  private readonly urls: MediaUrlSigner;

  constructor(private readonly ctx: AppContext) {
    this.urls = new MediaUrlSigner(ctx);
  }

  private async toTiles(userId: string, rows: TileRow[]): Promise<AssetTile[]> {
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        width: row.width,
        height: row.height,
        localAt: row.local_at,
        durationMs: row.duration_ms,
        isMotionPhoto: row.is_motion_photo,
        thumb: row.has_thumb ? await this.urls.thumbs(userId, row.sha256) : null,
        pending: row.pending,
      })),
    );
  }

  private tileRows(tx: Tx, where: Prisma.Sql, limit?: number): Promise<TileRow[]> {
    return tx.$queryRaw<TileRow[]>`
      SELECT ${TILE_COLUMNS} FROM assets a
      WHERE ${where}
      ORDER BY a.local_at DESC, a.id DESC
      ${limit ? Prisma.sql`LIMIT ${limit}` : Prisma.empty}`;
  }

  /** Photos and videos per month, newest first: enough to lay out the whole timeline. */
  timeline(userId: string): Promise<TimelineResponse> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await tx.$queryRaw<{ month: string; count: number; days: [number, number][] }[]>`
        WITH per_day AS (
          SELECT a.local_at::date AS day, count(*)::int AS count,
                 sum(least(greatest(coalesce(a.width::float8 / nullif(a.height, 0), 1), 0.5), 2.5))::float8 AS aspect_sum
          FROM assets a
          WHERE ${visible(userId)} AND ${MEDIA}
          GROUP BY 1
        )
        SELECT to_char(day, 'YYYY-MM') AS month, sum(count)::int AS count,
               json_agg(json_build_array(count, round(aspect_sum::numeric, 3)) ORDER BY day DESC) AS days
        FROM per_day GROUP BY 1 ORDER BY 1 DESC`;
      const [pending] = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM assets a
        WHERE ${visible(userId)} AND ${MEDIA} AND a.processed_at IS NULL`;
      return {
        total: rows.reduce((sum, row) => sum + row.count, 0),
        pending: pending?.count ?? 0,
        buckets: rows.map((row) => ({
          month: row.month,
          count: row.count,
          days: row.days.map(([count, aspectSum]) => [count, Number(aspectSum)]),
        })),
      };
    });
  }

  /** Every photo and video of one month (wall-clock time), newest first. */
  month(userId: string, month: string): Promise<AssetTile[]> {
    const start = `${month}-01`;
    const [year, monthNumber] = month.split('-').map(Number) as [number, number];
    const end =
      monthNumber === 12 ? `${year + 1}-01-01` : `${year}-${String(monthNumber + 1).padStart(2, '0')}-01`;
    return withUser(this.ctx.db, userId, async (tx) =>
      this.toTiles(
        userId,
        await this.tileRows(
          tx,
          Prisma.sql`${visible(userId)} AND ${MEDIA}
            AND a.local_at >= ${start}::timestamp AND a.local_at < ${end}::timestamp`,
        ),
      ),
    );
  }

  private searchConditions(userId: string, query: SearchInput): Prisma.Sql {
    const conditions: Prisma.Sql[] = [visible(userId)];
    if (query.kind?.length) conditions.push(Prisma.sql`a.kind::text = ANY(${query.kind}::text[])`);
    if (query.q) {
      const tsquery = prefixQuery(query.q);
      conditions.push(
        tsquery
          ? Prisma.sql`(a.search_tsv @@ to_tsquery('simple', ${tsquery}) OR a.original_name ILIKE ${likePattern(query.q)})`
          : Prisma.sql`a.original_name ILIKE ${likePattern(query.q)}`,
      );
    }
    if (query.from) conditions.push(Prisma.sql`a.local_at >= ${query.from}::timestamp`);
    if (query.to) conditions.push(Prisma.sql`a.local_at < ${addDays(query.to, 1)}::timestamp`);
    if (query.camera) conditions.push(Prisma.sql`a.camera_model = ${query.camera}`);
    if (query.place) conditions.push(Prisma.sql`a.place_id = ANY(${query.place}::int[])`);
    if (query.source) {
      conditions.push(Prisma.sql`EXISTS (
        SELECT 1 FROM asset_origins o WHERE o.asset_id = a.id
          AND (o.source_id = ${query.source} OR o.source_id LIKE ${`${query.source}:%`}))`);
    }
    if (query.bbox) {
      const [west, south, east, north] = query.bbox;
      conditions.push(Prisma.sql`a.gps_latitude BETWEEN ${south} AND ${north}`);
      conditions.push(
        west <= east
          ? Prisma.sql`a.gps_longitude BETWEEN ${west} AND ${east}`
          : Prisma.sql`(a.gps_longitude >= ${west} OR a.gps_longitude <= ${east})`,
      );
    }
    return Prisma.join(conditions, ' AND ');
  }

  /** Filtered, newest first, in pages. The first page also carries the total. */
  search(userId: string, query: SearchInput): Promise<AssetPage> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const where = this.searchConditions(userId, query);
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await this.tileRows(
        tx,
        cursor
          ? Prisma.sql`${where} AND (a.local_at, a.id) < (${cursor.localAt}::timestamp, ${cursor.id}::uuid)`
          : where,
        query.limit + 1,
      );
      const page = rows.slice(0, query.limit);
      const total = cursor
        ? undefined
        : (
            await tx.$queryRaw<
              { count: number }[]
            >`SELECT count(*)::int AS count FROM assets a WHERE ${where}`
          )[0]!.count;
      return {
        items: await this.toTiles(userId, page),
        nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null,
        ...(total === undefined ? {} : { total }),
      };
    });
  }

  facets(userId: string): Promise<FacetsResponse> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const where = visible(userId);
      const years = await tx.$queryRaw<{ year: number; count: number }[]>`
        SELECT extract(year FROM a.local_at)::int AS year, count(*)::int AS count
        FROM assets a WHERE ${where} AND ${MEDIA} GROUP BY 1 ORDER BY 1 DESC`;
      const cameras = await tx.$queryRaw<{ name: string; count: number }[]>`
        SELECT a.camera_model AS name, count(*)::int AS count
        FROM assets a WHERE ${where} AND a.camera_model IS NOT NULL
        GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 30`;
      const places = await tx.$queryRaw<
        {
          id: number;
          ids: number[];
          name: string;
          admin1: string | null;
          country: string | null;
          count: number;
        }[]
      >`
        SELECT min(p.id) AS id, array_agg(DISTINCT p.id) AS ids, p.name,
               p.admin1_name AS admin1, p.country_name AS country, count(*)::int AS count
        FROM assets a JOIN places p ON p.id = a.place_id
        WHERE ${where}
        GROUP BY p.name, p.admin1_name, p.country_name
        ORDER BY count(*) DESC, p.name LIMIT 50`;
      const sources = await tx.$queryRaw<{ id: string; count: number }[]>`
        SELECT o.source_id AS id, count(DISTINCT o.asset_id)::int AS count
        FROM asset_origins o JOIN assets a ON a.id = o.asset_id
        WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`;
      const kinds = await tx.$queryRaw<{ kind: MediaKind; count: number }[]>`
        SELECT a.kind::text AS kind, count(*)::int AS count FROM assets a WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`;
      return { years, cameras, places, sources, kinds };
    });
  }

  detail(userId: string, assetId: string): Promise<AssetDetail> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const [row] = await this.tileRows(tx, Prisma.sql`${visible(userId)} AND a.id = ${assetId}::uuid`, 1);
      if (!row) throw notFound('Photo not found');
      // One query at a time: a transaction's connection must not run two at once.
      const asset = await tx.asset.findUniqueOrThrow({ where: { id: assetId } });
      const place = asset.placeId ? await tx.place.findUnique({ where: { id: asset.placeId } }) : null;
      const origins = await tx.assetOrigin.findMany({ where: { assetId }, orderBy: { sourceId: 'asc' } });
      const derivatives = await tx.derivative.findMany({ where: { assetId }, select: { variant: true } });
      const entries = await tx.fileEntry.findMany({
        where: { assetId, deletedAt: null },
        select: { folderId: true, name: true },
      });
      const folderPaths = await this.folderPaths(
        tx,
        entries.map((entry) => entry.folderId),
      );
      const [tile] = await this.toTiles(userId, [row]);
      const variants = new Set(derivatives.map((derivative) => derivative.variant));
      const exif = (asset.exif ?? {}) as Record<string, string | number | boolean>;
      const { takenAtSource, readFrom: _readFrom, ...shownExif } = exif;
      return {
        ...tile!,
        sizeBytes: Number(asset.sizeBytes),
        mimeType: asset.mimeType,
        extension: asset.extension,
        takenAt: asset.takenAt?.toISOString() ?? null,
        takenAtOffsetMinutes: asset.takenAtOffsetMinutes,
        takenAtSource: typeof takenAtSource === 'string' ? takenAtSource : 'unknown',
        camera: { make: asset.cameraMake, model: asset.cameraModel, lens: asset.lensModel },
        exif: shownExif,
        location:
          asset.gpsLatitude !== null && asset.gpsLongitude !== null
            ? {
                latitude: asset.gpsLatitude,
                longitude: asset.gpsLongitude,
                altitude: asset.gpsAltitude,
                place: place
                  ? { id: place.id, name: place.name, admin1: place.admin1Name, country: place.countryName }
                  : null,
              }
            : null,
        origins: origins.map((origin) => ({
          sourceId: origin.sourceId,
          path: origin.originalPath,
          modifiedAt: origin.originalModifiedAt?.toISOString() ?? null,
        })),
        folders: entries.map((entry) => ({
          folderId: entry.folderId,
          path: [folderPaths.get(entry.folderId), entry.name].filter(Boolean).join('/'),
        })),
        preview:
          variants.has('lg') && variants.has('md')
            ? {
                lg: await this.urls.derivative(userId, asset.sha256, 'lg'),
                md: await this.urls.derivative(userId, asset.sha256, 'md'),
              }
            : null,
        originalUrl: await this.urls.original(asset),
        processing: { done: asset.processedAt !== null, error: asset.processingError },
      };
    });
  }

  /** "Phone · s21fe/DCIM/Camera" for each folder id (the unnamed root left out). */
  private async folderPaths(tx: Tx, folderIds: string[]): Promise<Map<string, string>> {
    if (folderIds.length === 0) return new Map();
    const rows = await tx.$queryRaw<{ leaf: string; path: string }[]>`
      WITH RECURSIVE chain AS (
        SELECT f.id, f.parent_id, f.name, 0 AS depth, f.id AS leaf
        FROM folders f WHERE f.id = ANY(${folderIds}::uuid[])
        UNION ALL
        SELECT parent.id, parent.parent_id, parent.name, chain.depth + 1, chain.leaf
        FROM folders parent JOIN chain ON parent.id = chain.parent_id
      )
      SELECT leaf, string_agg(name, '/' ORDER BY depth DESC) AS path
      FROM chain WHERE name <> '' GROUP BY leaf`;
    return new Map(rows.map((row) => [row.leaf, row.path]));
  }

  folder(
    userId: string,
    folderId: string | null,
    cursor: string | undefined,
    limit: number,
  ): Promise<FolderListing> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const folder = folderId
        ? await tx.folder.findFirst({ where: { id: folderId, userId, deletedAt: null } })
        : await tx.folder.findFirst({ where: { userId, parentId: null, name: '' } });
      if (!folder) {
        if (folderId) throw notFound('Folder not found');
        return {
          folder: { id: '', name: '', path: [] },
          folders: [],
          files: [],
          nextCursor: null,
          fileTotal: 0,
        };
      }
      const path = await tx.$queryRaw<{ id: string; name: string }[]>`
        WITH RECURSIVE chain AS (
          SELECT f.id, f.parent_id, f.name, 0 AS depth FROM folders f WHERE f.id = ${folder.id}::uuid
          UNION ALL
          SELECT parent.id, parent.parent_id, parent.name, chain.depth + 1
          FROM folders parent JOIN chain ON parent.id = chain.parent_id
        )
        SELECT id, name FROM chain WHERE name <> '' ORDER BY depth DESC`;
      const children = await tx.$queryRaw<
        { id: string; name: string; folder_count: number; file_count: number; cover_sha256: string | null }[]
      >`
        SELECT f.id, f.name,
          (SELECT count(*) FROM folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL)::int AS folder_count,
          (SELECT count(*) FROM file_entries e WHERE e.folder_id = f.id AND e.deleted_at IS NULL)::int AS file_count,
          cover.sha256 AS cover_sha256
        FROM folders f
        LEFT JOIN LATERAL (
          SELECT a.sha256 FROM file_entries e
          JOIN assets a ON a.id = e.asset_id AND ${visible(userId)} AND ${MEDIA}
          WHERE e.folder_id = f.id AND e.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM derivatives d WHERE d.asset_id = a.id AND d.variant = 'sm')
          ORDER BY a.local_at DESC LIMIT 1
        ) cover ON true
        WHERE f.parent_id = ${folder.id}::uuid AND f.deleted_at IS NULL
        ORDER BY lower(f.name), f.name`;
      const fileWhere = Prisma.sql`e.folder_id = ${folder.id}::uuid AND e.deleted_at IS NULL AND ${visible(userId)}`;
      const files = await tx.$queryRaw<
        (TileRow & { entry_id: string; entry_name: string; size_bytes: bigint })[]
      >`
        SELECT e.id AS entry_id, e.name AS entry_name, a.size_bytes, ${TILE_COLUMNS}
        FROM file_entries e JOIN assets a ON a.id = e.asset_id
        WHERE ${fileWhere} ${cursor ? Prisma.sql`AND e.name > ${cursor}` : Prisma.empty}
        ORDER BY e.name LIMIT ${limit + 1}`;
      const page = files.slice(0, limit);
      const [total] = await tx.$queryRaw<{ count: number }[]>`
        SELECT count(*)::int AS count FROM file_entries e JOIN assets a ON a.id = e.asset_id WHERE ${fileWhere}`;
      const tiles = await this.toTiles(userId, page);
      return {
        folder: { id: folder.id, name: folder.name, path },
        folders: await Promise.all(
          children.map(async (child) => ({
            id: child.id,
            name: child.name,
            folderCount: child.folder_count,
            fileCount: child.file_count,
            cover: child.cover_sha256 ? await this.urls.thumbs(userId, child.cover_sha256) : null,
          })),
        ),
        files: page.map((file, index) => ({
          entryId: file.entry_id,
          name: file.entry_name,
          sizeBytes: Number(file.size_bytes),
          asset: tiles[index]!,
        })),
        nextCursor: files.length > limit ? page.at(-1)!.entry_name : null,
        fileTotal: total?.count ?? 0,
      };
    });
  }

  mapPoints(userId: string): Promise<MapPointsResponse> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; lat: number; lng: number; video: number }[]>`
        SELECT a.id, a.gps_latitude AS lat, a.gps_longitude AS lng, (a.kind = 'video')::int AS video
        FROM assets a
        WHERE ${visible(userId)} AND ${MEDIA} AND a.gps_latitude IS NOT NULL AND a.gps_longitude IS NOT NULL`;
      return { points: rows.map((row) => [row.id, row.lat, row.lng, row.video]) };
    });
  }

  /** Photos taken on this calendar day in earlier years, with trustworthy dates and previews. */
  onThisDay(userId: string, date: string): Promise<OnThisDayResponse> {
    const [year, month, day] = date.split('-').map(Number) as [number, number, number];
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await this.tileRows(
        tx,
        Prisma.sql`${visible(userId)} AND ${MEDIA} AND a.taken_at IS NOT NULL
          AND coalesce(a.exif->>'takenAtSource', '') <> 'file-modified'
          AND extract(month FROM a.local_at) = ${month} AND extract(day FROM a.local_at) = ${day}
          AND a.local_at < ${`${year}-01-01`}::timestamp
          AND EXISTS (SELECT 1 FROM derivatives d WHERE d.asset_id = a.id AND d.variant = 'sm')`,
      );
      const byYear = new Map<number, TileRow[]>();
      for (const row of rows) {
        const rowYear = Number(row.local_at.slice(0, 4));
        byYear.set(rowYear, [...(byYear.get(rowYear) ?? []), row]);
      }
      return {
        groups: await Promise.all(
          [...byYear.entries()].map(async ([groupYear, groupRows]) => ({
            year: groupYear,
            yearsAgo: year - groupYear,
            total: groupRows.length,
            items: await this.toTiles(userId, groupRows.slice(0, 40)),
          })),
        ),
      };
    });
  }
}
