import type { ExportPage, MediaKind } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { Prisma, withUser } from '../db';
import { visible } from './browse';
import { MediaUrlSigner } from './media-urls';

interface ExportRow {
  id: string;
  sha256: string;
  size_bytes: bigint;
  kind: MediaKind;
  mime_type: string;
  original_name: string;
  original_modified_at: Date | null;
  taken_at: Date | null;
  local_at: string;
  gps_latitude: number | null;
  gps_longitude: number | null;
  place: string | null;
  camera: string | null;
  s3_key: string;
  origins: { sourceId: string; path: string; modifiedAt: string | null }[];
}

/** The whole library for `vault export`: metadata, every origin, and a link to each original. */
export class ExportService {
  private readonly urls: MediaUrlSigner;

  constructor(private readonly ctx: Pick<AppContext, 'db' | 's3' | 'env'>) {
    this.urls = new MediaUrlSigner(ctx);
  }

  page(userId: string, cursor: string | undefined, limit: number): Promise<ExportPage> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await tx.$queryRaw<ExportRow[]>`
        SELECT a.id, a.sha256, a.size_bytes, a.kind::text AS kind, a.mime_type, a.original_name,
               a.original_modified_at, a.taken_at,
               to_char(a.local_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS local_at,
               a.gps_latitude, a.gps_longitude,
               nullif(concat_ws(', ', p.name, p.admin1_name, p.country_name), '') AS place,
               nullif(concat_ws(' ', a.camera_make, a.camera_model), '') AS camera,
               a.s3_key,
               coalesce((
                 SELECT json_agg(json_build_object('sourceId', o.source_id, 'path', o.original_path,
                                                   'modifiedAt', o.original_modified_at)
                                 ORDER BY o.source_id, o.original_path)
                 FROM asset_origins o WHERE o.asset_id = a.id
               ), '[]'::json) AS origins
        FROM assets a LEFT JOIN places p ON p.id = a.place_id
        WHERE ${visible(userId)} ${cursor ? Prisma.sql`AND a.id > ${cursor}::uuid` : Prisma.empty}
        ORDER BY a.id
        LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const totals = cursor
        ? null
        : (
            await tx.$queryRaw<{ count: number; bytes: bigint | null }[]>`
              SELECT count(*)::int AS count, sum(a.size_bytes)::bigint AS bytes FROM assets a WHERE ${visible(userId)}`
          )[0];
      const toIso = (value: string | null) => (value ? new Date(value).toISOString() : null);
      return {
        total: totals ? totals.count : null,
        totalBytes: totals ? Number(totals.bytes ?? 0) : null,
        items: await Promise.all(
          page.map(async (row) => ({
            id: row.id,
            sha256: row.sha256,
            sizeBytes: Number(row.size_bytes),
            kind: row.kind,
            mimeType: row.mime_type,
            originalName: row.original_name,
            modifiedAt: row.original_modified_at?.toISOString() ?? null,
            takenAt: row.taken_at?.toISOString() ?? null,
            localAt: row.local_at,
            location:
              row.gps_latitude !== null && row.gps_longitude !== null
                ? { latitude: row.gps_latitude, longitude: row.gps_longitude, place: row.place }
                : null,
            camera: row.camera,
            origins: row.origins.map((origin) => ({ ...origin, modifiedAt: toIso(origin.modifiedAt) })),
            url: await this.urls.object(row.s3_key),
          })),
        ),
        nextCursor: rows.length > limit ? page.at(-1)!.id : null,
      };
    });
  }
}
