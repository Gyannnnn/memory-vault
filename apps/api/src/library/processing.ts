import type {
  MediaKind,
  PendingWork,
  pendingOriginalsQuery,
  PendingOriginalsResponse,
  ProcessingStatusResponse,
} from '@memory-vault/shared';
import type { z } from 'zod';
import type { AppContext } from '../context';
import { Prisma, withUser } from '../db';
import { HttpError } from '../http/errors';
import { decodeCursor, encodeCursor, visible } from './browse';

type PendingInput = z.output<typeof pendingOriginalsQuery>;

interface PendingRow {
  id: string;
  kind: MediaKind;
  size_bytes: bigint;
  sha256: string;
  local_at: string;
  paths: string[];
}

const HAS_STREAM = Prisma.sql`EXISTS (SELECT 1 FROM derivatives d WHERE d.asset_id = a.id AND d.variant LIKE 'hls-%')`;

/** Files still waiting for that work. */
function waiting(work: PendingWork): Prisma.Sql {
  return work === 'streams'
    ? Prisma.sql`a.kind = 'video' AND a.processed_at IS NOT NULL AND NOT ${HAS_STREAM}`
    : Prisma.sql`a.processed_at IS NULL`;
}

/**
 * What the worker still has to process, so an uploader that can still reach the files
 * (a phone over USB, for example) can put local copies where the waiting jobs look for
 * them. Everything runs as the signed-in user, so row-level security applies.
 */
export class ProcessingService {
  constructor(private readonly ctx: Pick<AppContext, 'db'>) {}

  /** Unprocessed files with an origin in `source`, newest first, with every path they have there. */
  pending(userId: string, query: PendingInput): Promise<PendingOriginalsResponse> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    if (query.cursor && !cursor) throw new HttpError(400, 'invalid_cursor', 'The cursor is not valid');
    const where = Prisma.sql`${visible(userId)} AND ${waiting(query.for)}`;
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await tx.$queryRaw<PendingRow[]>`
        SELECT a.id, a.kind::text AS kind, a.size_bytes, a.sha256,
               to_char(a.local_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS') AS local_at,
               array_agg(o.original_path ORDER BY o.created_at, o.original_path) AS paths
        FROM assets a
        JOIN asset_origins o ON o.asset_id = a.id AND o.source_id = ${query.source}
        WHERE ${where}
          ${cursor ? Prisma.sql`AND (a.local_at, a.id) < (${cursor.localAt}::timestamp, ${cursor.id}::uuid)` : Prisma.empty}
        GROUP BY a.id
        ORDER BY a.local_at DESC, a.id DESC
        LIMIT ${query.limit + 1}`;
      const page = rows.slice(0, query.limit);
      const totals = cursor
        ? null
        : (
            await tx.$queryRaw<{ count: number; bytes: bigint | null }[]>`
              SELECT count(*)::int AS count, sum(a.size_bytes)::bigint AS bytes
              FROM assets a
              WHERE ${where}
                AND EXISTS (SELECT 1 FROM asset_origins o WHERE o.asset_id = a.id AND o.source_id = ${query.source})`
          )[0];
      return {
        total: totals ? totals.count : null,
        totalBytes: totals ? Number(totals.bytes ?? 0) : null,
        items: page.map((row) => ({
          assetId: row.id,
          kind: row.kind,
          sizeBytes: Number(row.size_bytes),
          sha256: row.sha256,
          localAt: row.local_at,
          paths: row.paths,
        })),
        nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null,
      };
    });
  }

  /** Whether each of the caller's files is done. Unknown or other users' ids are left out. */
  status(userId: string, ids: string[], work: PendingWork = 'processing'): Promise<ProcessingStatusResponse> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await tx.$queryRaw<{ id: string; done: boolean; error: string | null }[]>`
        SELECT a.id,
               ${work === 'streams' ? HAS_STREAM : Prisma.sql`a.processed_at IS NOT NULL`} AS done,
               ${work === 'streams' ? Prisma.sql`NULL::text` : Prisma.sql`a.processing_error`} AS error
        FROM assets a
        WHERE a.user_id = ${userId}::uuid AND a.id = ANY(${ids}::uuid[])`;
      return { items: rows };
    });
  }
}
