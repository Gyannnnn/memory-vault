import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { TRASH_DAYS, type TrashPage } from '@memory-vault/shared';
import type { RequestMeta } from '../auth/audit';
import { audit } from '../auth/audit';
import type { AppContext } from '../context';
import { Prisma, withUser } from '../db';
import { BrowseService, TILE_COLUMNS, visible, type TileRow } from './browse';

/** In Trash and due to go for good: past the 30 days, or "Delete now" was chosen. */
const DUE = Prisma.sql`a.deleted_at IS NOT NULL
  AND (a.deleted_at <= now() - ${TRASH_DAYS}::int * interval '1 day' OR a.purge_requested_at IS NOT NULL)`;

const IN_TRASH = (userId: string) =>
  Prisma.sql`a.user_id = ${userId}::uuid AND a.status = 'verified' AND a.deleted_at IS NOT NULL`;

const DAY_MS = 86_400_000;

export const STORAGE_PERMISSION_MISSING =
  'Storage permission missing: follow docs/setup/phase-2-aws-setup.md, then run pnpm aws:verify';

function encode(row: { deleted_at: Date; id: string }): string {
  return Buffer.from(`${row.deleted_at.toISOString()}|${row.id}`).toString('base64url');
}

function decode(cursor: string): { deletedAt: string; id: string } | null {
  const [deletedAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return deletedAt && id && !Number.isNaN(Date.parse(deletedAt)) && /^[0-9a-f-]{36}$/.test(id)
    ? { deletedAt, id }
    : null;
}

/**
 * Moving to Trash and back. Nothing here deletes a file: that is `purgeTrash`, 30 days
 * later or when the owner chooses "Delete now".
 */
export class TrashService {
  private readonly browse: BrowseService;

  constructor(private readonly ctx: AppContext) {
    this.browse = new BrowseService(ctx);
  }

  async trash(userId: string, ids: string[], meta?: RequestMeta): Promise<{ trashed: number }> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const trashed = await tx.$executeRaw`
        UPDATE assets a SET deleted_at = now(), purge_requested_at = NULL, purge_error = NULL
        WHERE ${visible(userId)} AND a.id = ANY(${ids}::uuid[])`;
      if (trashed > 0) await audit(tx, { userId, type: 'asset.trashed', meta, metadata: { count: trashed } });
      return { trashed };
    });
  }

  async restore(userId: string, ids: string[], meta?: RequestMeta): Promise<{ restored: number }> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const restored = await tx.$executeRaw`
        UPDATE assets a SET deleted_at = NULL, purge_requested_at = NULL, purge_error = NULL
        WHERE ${IN_TRASH(userId)} AND a.id = ANY(${ids}::uuid[])`;
      if (restored > 0)
        await audit(tx, { userId, type: 'asset.restored', meta, metadata: { count: restored } });
      return { restored };
    });
  }

  /** "Delete now": marks the items and asks the worker to delete them for good. */
  async requestPurge(userId: string, ids: string[], meta?: RequestMeta): Promise<{ requested: number }> {
    const requested = await withUser(this.ctx.db, userId, async (tx) => {
      const count = await tx.$executeRaw`
        UPDATE assets a SET purge_requested_at = now(), purge_error = NULL
        WHERE ${IN_TRASH(userId)} AND a.id = ANY(${ids}::uuid[])`;
      if (count > 0) await audit(tx, { userId, type: 'asset.purge_requested', meta, metadata: { count } });
      return count;
    });
    if (requested > 0) await this.ctx.jobs?.purge(userId);
    return { requested };
  }

  list(userId: string, cursor: string | undefined, limit: number): Promise<TrashPage> {
    const after = cursor ? decode(cursor) : null;
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await tx.$queryRaw<
        (TileRow & {
          deleted_at: Date;
          purge_requested_at: Date | null;
          purge_error: string | null;
          size_bytes: bigint;
        })[]
      >`
        SELECT ${TILE_COLUMNS}, a.deleted_at, a.purge_requested_at, a.purge_error, a.size_bytes
        FROM assets a
        WHERE ${IN_TRASH(userId)}
          ${after ? Prisma.sql`AND (a.deleted_at, a.id) < (${after.deletedAt}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ORDER BY a.deleted_at DESC, a.id DESC
        LIMIT ${limit + 1}`;
      const page = rows.slice(0, limit);
      const tiles = await this.browse.toTiles(userId, page);
      const summary = after
        ? undefined
        : await tx.$queryRaw<{ count: number; bytes: bigint | null; due: number; problem: string | null }[]>`
            SELECT count(*)::int AS count, sum(a.size_bytes)::bigint AS bytes,
                   (count(*) FILTER (WHERE ${DUE}))::int AS due,
                   (SELECT a2.purge_error FROM assets a2
                     WHERE a2.user_id = ${userId}::uuid AND a2.deleted_at IS NOT NULL AND a2.purge_error IS NOT NULL
                     ORDER BY a2.deleted_at DESC LIMIT 1) AS problem
            FROM assets a WHERE ${IN_TRASH(userId)}`;
      return {
        items: tiles.map((tile, index) => {
          const row = page[index]!;
          return {
            ...tile,
            deletedAt: row.deleted_at.toISOString(),
            sizeBytes: Number(row.size_bytes),
            purgeAt: (
              row.purge_requested_at ?? new Date(row.deleted_at.getTime() + TRASH_DAYS * DAY_MS)
            ).toISOString(),
            purgeError: row.purge_error,
          };
        }),
        nextCursor: rows.length > limit ? encode(page.at(-1)!) : null,
        ...(summary
          ? {
              summary: {
                count: summary[0]!.count,
                bytes: Number(summary[0]!.bytes ?? 0n),
                due: summary[0]!.due,
                problem: summary[0]!.problem,
              },
            }
          : {}),
      };
    });
  }
}

export interface PurgeSummary {
  purged: number;
  failed: number;
}

const isAccessDenied = (error: unknown) => {
  const value = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    value.name === 'AccessDenied' || value.Code === 'AccessDenied' || value.$metadata?.httpStatusCode === 403
  );
};

/**
 * Deletes for good whatever is due in Trash. Per item: the original and every derivative
 * get an S3 delete marker (the versions stay, protected by Object Lock, until the bucket's
 * expire-old-versions rule removes them 30 days later), then its rows go and a record of
 * the content is kept so a later upload doesn't silently bring it back. If S3 refuses, the
 * item stays in Trash with the reason, and nothing of it is deleted.
 */
export async function purgeTrash(
  ctx: Pick<AppContext, 'db' | 's3' | 'env' | 'logger'>,
  options: { userId?: string; limit?: number } = {},
): Promise<PurgeSummary> {
  const users = options.userId
    ? [{ id: options.userId }]
    : await ctx.db.user.findMany({ where: { status: { not: 'deleted' } }, select: { id: true } });
  const summary: PurgeSummary = { purged: 0, failed: 0 };

  for (const user of users) {
    const due = await withUser(
      ctx.db,
      user.id,
      (tx) =>
        tx.$queryRaw<
          {
            id: string;
            sha256: string;
            s3_key: string;
            original_name: string;
            size_bytes: bigint;
            deleted_at: Date;
          }[]
        >`
        SELECT a.id, a.sha256, a.s3_key, a.original_name, a.size_bytes, a.deleted_at
        FROM assets a WHERE a.user_id = ${user.id}::uuid AND ${DUE}
        ORDER BY a.deleted_at, a.id LIMIT ${options.limit ?? 5000}`,
    );
    for (const asset of due) {
      const derivatives = await withUser(ctx.db, user.id, (tx) =>
        tx.derivative.findMany({ where: { assetId: asset.id }, select: { s3Key: true } }),
      );
      try {
        // The original first: if that is refused, the item keeps its previews too.
        for (const Key of [asset.s3_key, ...new Set(derivatives.map((derivative) => derivative.s3Key))]) {
          await ctx.s3.send(new DeleteObjectCommand({ Bucket: ctx.env.S3_BUCKET, Key }));
        }
      } catch (error) {
        const denied = isAccessDenied(error);
        const reason = denied ? STORAGE_PERMISSION_MISSING : String((error as Error).message).slice(0, 300);
        await withUser(ctx.db, user.id, (tx) =>
          tx.asset.update({ where: { id: asset.id }, data: { purgeError: reason } }),
        );
        summary.failed += 1;
        ctx.logger.warn({ assetId: asset.id, err: error }, 'trash purge: S3 refused a delete');
        // Every other item would be refused the same way; try again on the next run.
        if (denied) break;
        continue;
      }
      await withUser(ctx.db, user.id, async (tx) => {
        await tx.fileEntry.deleteMany({ where: { assetId: asset.id } });
        await tx.asset.delete({ where: { id: asset.id } });
        await tx.deletedContent.upsert({
          where: { userId_sha256: { userId: user.id, sha256: asset.sha256 } },
          create: {
            userId: user.id,
            sha256: asset.sha256,
            originalName: asset.original_name,
            sizeBytes: asset.size_bytes,
            trashedAt: asset.deleted_at,
          },
          update: {
            originalName: asset.original_name,
            sizeBytes: asset.size_bytes,
            trashedAt: asset.deleted_at,
            purgedAt: new Date(),
          },
        });
        await audit(tx, {
          userId: user.id,
          type: 'asset.purged',
          metadata: { name: asset.original_name, sha256: asset.sha256, sizeBytes: Number(asset.size_bytes) },
        });
      });
      summary.purged += 1;
    }
  }
  if (summary.purged || summary.failed) ctx.logger.info(summary, 'trash purge');
  return summary;
}
