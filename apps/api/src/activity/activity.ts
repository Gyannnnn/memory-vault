import type { ActivityGroup, ActivityPage } from '@memory-vault/shared';
import type { AppContext } from '../context';
import type { Prisma } from '../db';
import { ShareService } from '../sharing/shares';

/** Which event types each filter shows. */
const GROUPS: Record<Exclude<ActivityGroup, 'all'>, Prisma.AuditEventWhereInput> = {
  signins: { OR: [{ type: { startsWith: 'auth.' } }, { type: 'user.created' }] },
  sharing: { type: { startsWith: 'share.' } },
  downloads: { OR: [{ type: { startsWith: 'download.' } }, { type: { startsWith: 'export.' } }] },
  deletions: { type: { startsWith: 'asset.' } },
};

function decode(cursor: string): { at: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return at && id && !Number.isNaN(Date.parse(at)) && /^[0-9a-f-]{36}$/.test(id)
    ? { at: new Date(at), id }
    : null;
}

/** The owner's own audit trail: sign-ins, links, downloads, exports, deletions. */
export class ActivityService {
  private readonly shares: ShareService;

  constructor(private readonly ctx: AppContext) {
    this.shares = new ShareService(ctx);
  }

  async page(
    userId: string,
    group: ActivityGroup,
    cursor: string | undefined,
    limit: number,
  ): Promise<ActivityPage> {
    const after = cursor ? decode(cursor) : null;
    const rows = await this.ctx.db.auditEvent.findMany({
      where: {
        userId,
        ...(group === 'all' ? {} : GROUPS[group]),
        ...(after
          ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const shareIds = new Set(
      page
        .map((row) => (row.metadata as { shareId?: unknown } | null)?.shareId)
        .filter((id): id is string => typeof id === 'string'),
    );
    const links: ActivityPage['links'] = {};
    if (shareIds.size > 0) {
      for (const link of await this.shares.list(userId))
        if (shareIds.has(link.id)) links[link.id] = { title: link.title, kind: link.kind };
    }
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        id: row.id,
        type: row.type,
        createdAt: row.createdAt.toISOString(),
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        metadata: (row.metadata ?? {}) as Record<string, unknown>,
      })),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString('base64url')
          : null,
      links,
    };
  }
}
