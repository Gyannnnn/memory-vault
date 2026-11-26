import type { DuplicateGroup, DuplicateMember, DuplicatesResponse } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { withUser } from '../db';
import { BrowseService, TILE_COLUMNS, visible, type TileRow } from './browse';
import { findGroups, pairKey } from './near-duplicates';

interface Candidate {
  id: string;
  phash: string;
  kind: 'photo' | 'raw' | 'video';
  duration_ms: number | null;
  size_bytes: bigint;
  width: number | null;
  height: number | null;
  local_at: Date | null;
}

/** Best copy first: most pixels, then the biggest file. */
const better = (a: Candidate, b: Candidate) =>
  (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0) ||
  Number(b.size_bytes - a.size_bytes) ||
  a.id.localeCompare(b.id);

const newest = (group: Candidate[]) => Math.max(...group.map((item) => item.local_at?.getTime() ?? 0));
const reclaimable = (group: Candidate[]) =>
  group.slice(1).reduce((sum, item) => sum + Number(item.size_bytes), 0);

/**
 * Photos (and videos) that look the same, from their perceptual hashes. Groups are worked out
 * on request, newest first; nothing is decided here: the owner keeps what they choose and
 * moves the rest to Trash themselves.
 */
export class DuplicateService {
  private readonly browse: BrowseService;

  constructor(private readonly ctx: AppContext) {
    this.browse = new BrowseService(ctx);
  }

  list(userId: string, offset: number, limit: number): Promise<DuplicatesResponse> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const candidates = await tx.$queryRaw<Candidate[]>`
        SELECT a.id, a.phash, a.kind::text AS kind, a.duration_ms, a.size_bytes, a.width, a.height, a.local_at
        FROM assets a
        WHERE ${visible(userId)} AND a.kind IN ('photo', 'raw', 'video') AND a.phash ~ '^[0-9a-f]{16}$'`;
      const dismissals = await tx.duplicateDismissal.findMany({ select: { assetA: true, assetB: true } });
      const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
      // Best copies first: each group forms around the best of its look-alikes.
      const groups = findGroups(
        [...candidates].sort(better).map((candidate) => ({
          id: candidate.id,
          hash: candidate.phash,
          kind: candidate.kind,
          durationMs: candidate.duration_ms,
        })),
        new Set(dismissals.map((pair) => pairKey(pair.assetA, pair.assetB))),
      )
        .map((ids) => ids.map((id) => byId.get(id)!).sort(better))
        .sort((a, b) => newest(b) - newest(a));

      const page = groups.slice(offset, offset + limit);
      const ids = page.flat().map((item) => item.id);
      const rows = ids.length
        ? await tx.$queryRaw<(TileRow & { size_bytes: bigint; extension: string; origin: string | null })[]>`
            SELECT ${TILE_COLUMNS}, a.size_bytes, a.extension,
              (SELECT o.source_id || '/' || o.original_path FROM asset_origins o
                WHERE o.asset_id = a.id ORDER BY o.created_at, o.id LIMIT 1) AS origin
            FROM assets a WHERE a.id = ANY(${ids}::uuid[])`
        : [];
      const tiles = await this.browse.toTiles(userId, rows);
      const members = new Map<string, DuplicateMember>(
        rows.map((row, index) => {
          const origin = row.origin;
          return [
            row.id,
            {
              ...tiles[index]!,
              sizeBytes: Number(row.size_bytes),
              extension: row.extension,
              folder: origin && origin.includes('/') ? origin.slice(0, origin.lastIndexOf('/')) : origin,
            },
          ];
        }),
      );
      return {
        groups: page.map((group): DuplicateGroup => ({
          id: group[0]!.id,
          members: group.map((item) => members.get(item.id)!),
          suggestedKeepId: group[0]!.id,
          reclaimableBytes: reclaimable(group),
        })),
        totalGroups: groups.length,
        reclaimableBytes: groups.reduce((sum, group) => sum + reclaimable(group), 0),
      };
    });
  }

  /** "Not duplicates": every pair among these stops being grouped. Only the caller's visible photos count. */
  dismiss(userId: string, assetIds: string[]): Promise<{ dismissed: number }> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const owned = (
        await tx.$queryRaw<{ id: string }[]>`
          SELECT a.id FROM assets a WHERE ${visible(userId)} AND a.id = ANY(${assetIds}::uuid[])`
      )
        .map((row) => row.id)
        .sort();
      const pairs = owned.flatMap((a, index) =>
        owned.slice(index + 1).map((b) => ({ userId, assetA: a, assetB: b })),
      );
      const { count } = await tx.duplicateDismissal.createMany({ data: pairs, skipDuplicates: true });
      return { dismissed: count };
    });
  }
}
