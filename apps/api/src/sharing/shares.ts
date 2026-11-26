import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type {
  AssetTile,
  CreateDownloadRequest,
  DownloadSummary,
  MediaUrls,
  PublicShare,
  SharedAsset,
  SharedFolder,
  SharedPage,
  ShareKind,
  ShareLinkSummary,
  ShareStatus,
} from '@memory-vault/shared';
import type { ShareLink } from '../generated/prisma/client';
import { audit, type RequestMeta } from '../auth/audit';
import { consume } from '../auth/rate-limits';
import { decrypt, encrypt, hashSecret, randomToken, sha256Hex, verifySecret } from '../auth/secrets';
import type { AppContext } from '../context';
import { DownloadService } from '../downloads/service';
import { newId, Prisma, withUser, type Tx } from '../db';
import { badRequest, HttpError, notFound, unauthorized } from '../http/errors';
import { motionKey } from '../storage/keys';
import {
  BrowseService,
  decodeCursor,
  encodeCursor,
  streamQualities,
  TILE_COLUMNS,
  visible,
  type TileRow,
} from '../library/browse';
import { MediaUrlSigner } from '../library/media-urls';
import { StreamService } from '../library/streams';

const DAY_MS = 86_400_000;
const SESSION_MS = 12 * 60 * 60 * 1000;

/** The same answer for unknown, expired and revoked links: nothing to learn from it. */
const unavailable = () => new HttpError(404, 'not_available', 'This link isn’t available');

const statusOf = (share: Pick<ShareLink, 'revokedAt' | 'expiresAt'>, now = Date.now()): ShareStatus =>
  share.revokedAt ? 'revoked' : share.expiresAt && share.expiresAt.getTime() <= now ? 'expired' : 'active';

/**
 * Share links. The owner makes, lists and revokes them; anyone with the link (and its
 * password, if it has one) can see exactly what it covers, read with the owner's
 * row-level security context, and nothing else: no places, camera details or folder paths,
 * no file names unless downloads are allowed, never anything in Trash.
 */
export class ShareService {
  private readonly browse: BrowseService;
  private readonly urls: MediaUrlSigner;
  private readonly streams: StreamService;
  private readonly downloads: DownloadService;
  private readonly sessionKey: Buffer;

  constructor(private readonly ctx: AppContext) {
    this.browse = new BrowseService(ctx);
    this.urls = new MediaUrlSigner(ctx);
    this.streams = new StreamService(ctx);
    this.downloads = new DownloadService(ctx);
    this.sessionKey = Buffer.from(
      hkdfSync('sha256', Buffer.from(ctx.env.DATA_ENCRYPTION_KEY, 'base64'), '', 'share-session', 32),
    );
  }

  /* ------------------------------------------------------------------ owner */

  async create(
    userId: string,
    input: {
      kind: ShareKind;
      targetId: string;
      expiresInDays: number | null;
      allowDownload: boolean;
      password?: string | undefined;
    },
    meta?: RequestMeta,
  ): Promise<ShareLinkSummary> {
    const target = await withUser(this.ctx.db, userId, (tx) =>
      this.target(tx, userId, input.kind, input.targetId),
    );
    if (!target) throw badRequest('There is nothing to share there');
    const token = randomToken();
    const id = newId();
    await this.ctx.db.shareLink.create({
      data: {
        id,
        userId,
        tokenHash: sha256Hex(token),
        tokenCiphertext: new Uint8Array(encrypt(Buffer.from(token), this.ctx.env.DATA_ENCRYPTION_KEY)),
        kind: input.kind,
        targetId: input.targetId,
        allowDownload: input.allowDownload,
        passwordHash: input.password ? await hashSecret(input.password) : null,
        expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * DAY_MS) : null,
      },
    });
    await audit(this.ctx.db, {
      userId,
      type: 'share.created',
      meta,
      metadata: {
        shareId: id,
        kind: input.kind,
        title: target.title,
        allowDownload: input.allowDownload,
        password: Boolean(input.password),
        expiresInDays: input.expiresInDays,
      },
    });
    const [summary] = await this.list(userId, { id });
    return summary!;
  }

  async list(
    userId: string,
    filter: { targetId?: string | undefined; id?: string } = {},
  ): Promise<ShareLinkSummary[]> {
    const rows = await this.ctx.db.shareLink.findMany({
      where: {
        userId,
        ...(filter.targetId ? { targetId: filter.targetId } : {}),
        ...(filter.id ? { id: filter.id } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return withUser(this.ctx.db, userId, async (tx) => {
      const summaries: ShareLinkSummary[] = [];
      for (const row of rows) {
        const target = await this.target(tx, userId, row.kind, row.targetId);
        summaries.push({
          id: row.id,
          kind: row.kind,
          targetId: row.targetId,
          title: target?.title ?? null,
          cover: target?.cover ?? null,
          token: decrypt(row.tokenCiphertext, this.ctx.env.DATA_ENCRYPTION_KEY).toString(),
          allowDownload: row.allowDownload,
          hasPassword: row.passwordHash !== null,
          expiresAt: row.expiresAt?.toISOString() ?? null,
          revokedAt: row.revokedAt?.toISOString() ?? null,
          status: statusOf(row),
          openCount: row.openCount,
          lastOpenedAt: row.lastOpenedAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
        });
      }
      return summaries;
    });
  }

  async revoke(userId: string, id: string, meta?: RequestMeta): Promise<void> {
    const { count } = await this.ctx.db.shareLink.updateMany({
      where: { id, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) {
      const exists = await this.ctx.db.shareLink.findFirst({ where: { id, userId }, select: { id: true } });
      if (!exists) throw notFound('Link not found');
      return;
    }
    await audit(this.ctx.db, { userId, type: 'share.revoked', meta, metadata: { shareId: id } });
  }

  /** What a link points at, if it's still there: its name and a cover. */
  private async target(
    tx: Tx,
    userId: string,
    kind: ShareKind,
    targetId: string,
  ): Promise<{ title: string; cover: MediaUrls | null } | null> {
    const coverOf = async (sha256: string | null | undefined) =>
      sha256 ? this.urls.thumbs(userId, sha256) : null;
    if (kind === 'photo') {
      const [row] = await tx.$queryRaw<{ name: string; sha256: string; has_thumb: boolean }[]>`
        SELECT a.original_name AS name, a.sha256,
          EXISTS (SELECT 1 FROM derivatives d WHERE d.asset_id = a.id AND d.variant = 'sm') AS has_thumb
        FROM assets a WHERE ${visible(userId)} AND a.id = ${targetId}::uuid`;
      return row ? { title: row.name, cover: row.has_thumb ? await coverOf(row.sha256) : null } : null;
    }
    const scope = this.scope(userId, kind, targetId);
    const [cover] = await tx.$queryRaw<{ sha256: string }[]>`
      SELECT a.sha256 FROM assets a
      WHERE ${visible(userId)} AND ${scope}
        AND EXISTS (SELECT 1 FROM derivatives d WHERE d.asset_id = a.id AND d.variant = 'sm')
      ORDER BY a.local_at DESC LIMIT 1`;
    if (kind === 'album') {
      const album = await tx.album.findFirst({ where: { id: targetId, userId }, select: { name: true } });
      return album ? { title: album.name, cover: await coverOf(cover?.sha256) } : null;
    }
    const folder = await tx.folder.findFirst({
      where: { id: targetId, userId, deletedAt: null },
      select: { name: true },
    });
    return folder ? { title: folder.name || 'Folders', cover: await coverOf(cover?.sha256) } : null;
  }

  /** Assets (alias a) the link covers. */
  private scope(userId: string, kind: ShareKind, targetId: string): Prisma.Sql {
    if (kind === 'photo') return Prisma.sql`a.id = ${targetId}::uuid`;
    if (kind === 'album')
      return Prisma.sql`EXISTS (SELECT 1 FROM album_items ai WHERE ai.asset_id = a.id AND ai.album_id = ${targetId}::uuid)`;
    return Prisma.sql`EXISTS (
      SELECT 1 FROM file_entries e WHERE e.asset_id = a.id AND e.deleted_at IS NULL AND e.folder_id IN (
        WITH RECURSIVE tree AS (
          SELECT f.id FROM folders f
          WHERE f.id = ${targetId}::uuid AND f.user_id = ${userId}::uuid AND f.deleted_at IS NULL
          UNION ALL
          SELECT c.id FROM folders c JOIN tree ON c.parent_id = tree.id WHERE c.deleted_at IS NULL
        ) SELECT id FROM tree))`;
  }

  /* ---------------------------------------------------------------- visitor */

  /** The live link for this token, or "isn't available". */
  private async resolve(token: string, ip: string | undefined): Promise<ShareLink> {
    await consume(this.ctx.limits.shareByIp, ip ?? 'unknown');
    if (!/^[\w-]{20,100}$/.test(token)) throw unavailable();
    const share = await this.ctx.db.shareLink.findUnique({ where: { tokenHash: sha256Hex(token) } });
    if (!share || statusOf(share) !== 'active') throw unavailable();
    const owner = await this.ctx.db.user.findUnique({
      where: { id: share.userId },
      select: { status: true },
    });
    if (!owner || owner.status === 'deleted') throw unavailable();
    return share;
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.sessionKey).update(payload).digest('base64url');
  }

  /** Ties a session to the link and its current password, so changing either ends it. */
  private passwordTag(share: ShareLink): string {
    return sha256Hex(share.passwordHash ?? '').slice(0, 16);
  }

  private sessionValid(share: ShareLink, session: string | undefined): boolean {
    if (!share.passwordHash) return true;
    const [id, expires, tag, signature] = (session ?? '').split('.');
    if (!id || !expires || !tag || !signature) return false;
    const expected = Buffer.from(this.sign(`${id}.${expires}.${tag}`));
    const given = Buffer.from(signature);
    return (
      expected.length === given.length &&
      timingSafeEqual(expected, given) &&
      id === share.id &&
      tag === this.passwordTag(share) &&
      Number(expires) > Date.now()
    );
  }

  /** The link, unlocked: or "password needed". */
  private async open(token: string, session: string | undefined, meta: RequestMeta): Promise<ShareLink> {
    const share = await this.resolve(token, meta.ip);
    if (!this.sessionValid(share, session)) throw unauthorized('This link needs its password');
    return share;
  }

  async summary(token: string, session: string | undefined, meta: RequestMeta): Promise<PublicShare> {
    const share = await this.resolve(token, meta.ip);
    if (!this.sessionValid(share, session)) return { status: 'locked' };
    const owner = await this.ctx.db.user.findUniqueOrThrow({
      where: { id: share.userId },
      select: { displayName: true },
    });
    const { title, total } = await withUser(this.ctx.db, share.userId, async (tx) => {
      const target = await this.target(tx, share.userId, share.kind, share.targetId);
      if (!target) throw unavailable();
      const [count] = await tx.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM assets a
        WHERE ${visible(share.userId)} AND ${this.scope(share.userId, share.kind, share.targetId)}`;
      return { title: share.kind === 'photo' ? '' : target.title, total: count?.n ?? 0 };
    });
    await this.recordOpen(share, meta);
    return {
      status: 'open',
      kind: share.kind,
      title,
      ownerName: owner.displayName,
      allowDownload: share.allowDownload,
      expiresAt: share.expiresAt?.toISOString() ?? null,
      total,
    };
  }

  /** Counts a visit and tells the owner, at most once an hour per visitor. */
  private async recordOpen(share: ShareLink, meta: RequestMeta): Promise<void> {
    const key = `share-open:${share.id}:${sha256Hex(`${meta.ip ?? ''}|${meta.userAgent ?? ''}`).slice(0, 24)}`;
    const first = await this.ctx.redis.set(key, '1', 'EX', 3600, 'NX');
    if (first !== 'OK') return;
    await this.ctx.db.shareLink.update({
      where: { id: share.id },
      data: { openCount: { increment: 1 }, lastOpenedAt: new Date() },
    });
    await audit(this.ctx.db, {
      userId: share.userId,
      type: 'share.opened',
      meta,
      metadata: { shareId: share.id, kind: share.kind },
    });
  }

  async unlock(token: string, password: string, meta: RequestMeta): Promise<{ session: string }> {
    const share = await this.resolve(token, meta.ip);
    if (!share.passwordHash) return { session: '' };
    const limitKey = `${share.id}:${meta.ip ?? 'unknown'}`;
    await consume(this.ctx.limits.shareUnlock, limitKey);
    if (!(await verifySecret(share.passwordHash, password))) {
      await audit(this.ctx.db, {
        userId: share.userId,
        type: 'share.unlock_failed',
        meta,
        metadata: { shareId: share.id },
      });
      throw unauthorized('That password isn’t right');
    }
    const expires = Date.now() + SESSION_MS;
    const payload = `${share.id}.${expires}.${this.passwordTag(share)}`;
    return { session: `${payload}.${this.sign(payload)}` };
  }

  private publicTiles(share: ShareLink, tiles: AssetTile[]): AssetTile[] {
    return tiles.map((tile) => ({ ...tile, favorite: false, name: share.allowDownload ? tile.name : '' }));
  }

  async page(
    token: string,
    session: string | undefined,
    query: { cursor?: string | undefined; folder?: string | undefined; limit: number },
    meta: RequestMeta,
  ): Promise<SharedPage> {
    const share = await this.open(token, session, meta);
    const owner = share.userId;
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    return withUser(this.ctx.db, owner, async (tx) => {
      let where = Prisma.sql`${visible(owner)} AND ${this.scope(owner, share.kind, share.targetId)}`;
      let folders: SharedFolder[] | undefined;
      let path: { id: string; name: string }[] | undefined;
      if (share.kind === 'folder') {
        const folderId = query.folder ?? share.targetId;
        // The way from the shared folder down to this one; empty if it's outside the share.
        path = await tx.$queryRaw<{ id: string; name: string }[]>`
          WITH RECURSIVE chain AS (
            SELECT f.id, f.parent_id, f.name, 0 AS depth FROM folders f
            WHERE f.id = ${folderId}::uuid AND f.user_id = ${owner}::uuid AND f.deleted_at IS NULL
            UNION ALL
            SELECT parent.id, parent.parent_id, parent.name, chain.depth + 1
            FROM folders parent JOIN chain ON parent.id = chain.parent_id
            WHERE chain.id <> ${share.targetId}::uuid
          )
          SELECT id, name FROM chain ORDER BY depth DESC`;
        if (path[0]?.id !== share.targetId) throw unavailable();
        const children = await tx.$queryRaw<
          {
            id: string;
            name: string;
            folder_count: number;
            file_count: number;
            cover_sha256: string | null;
          }[]
        >`
          SELECT f.id, f.name,
            (SELECT count(*) FROM folders c WHERE c.parent_id = f.id AND c.deleted_at IS NULL)::int AS folder_count,
            (SELECT count(*) FROM file_entries e JOIN assets a ON a.id = e.asset_id
              WHERE e.folder_id = f.id AND e.deleted_at IS NULL AND ${visible(owner)})::int AS file_count,
            (SELECT a.sha256 FROM file_entries e JOIN assets a ON a.id = e.asset_id
              WHERE e.folder_id = f.id AND e.deleted_at IS NULL AND ${visible(owner)}
                AND EXISTS (SELECT 1 FROM derivatives d WHERE d.asset_id = a.id AND d.variant = 'sm')
              ORDER BY a.local_at DESC LIMIT 1) AS cover_sha256
          FROM folders f
          WHERE f.parent_id = ${folderId}::uuid AND f.user_id = ${owner}::uuid AND f.deleted_at IS NULL
          ORDER BY lower(f.name), f.name`;
        folders = cursor
          ? []
          : await Promise.all(
              children.map(async (child) => ({
                id: child.id,
                name: child.name,
                fileCount: child.file_count,
                folderCount: child.folder_count,
                cover: child.cover_sha256 ? await this.urls.thumbs(owner, child.cover_sha256) : null,
              })),
            );
        where = Prisma.sql`${visible(owner)} AND EXISTS (
          SELECT 1 FROM file_entries e WHERE e.asset_id = a.id AND e.deleted_at IS NULL AND e.folder_id = ${folderId}::uuid)`;
      }
      const rows = await tx.$queryRaw<TileRow[]>`
        SELECT ${TILE_COLUMNS} FROM assets a
        WHERE ${where}
          ${cursor ? Prisma.sql`AND (a.local_at, a.id) < (${cursor.localAt}::timestamp, ${cursor.id}::uuid)` : Prisma.empty}
        ORDER BY a.local_at DESC, a.id DESC
        LIMIT ${query.limit + 1}`;
      const pageRows = rows.slice(0, query.limit);
      return {
        items: this.publicTiles(share, await this.browse.toTiles(owner, pageRows)),
        nextCursor: rows.length > query.limit ? encodeCursor(pageRows.at(-1)!) : null,
        ...(folders ? { folders } : {}),
        ...(path ? { path } : {}),
      };
    });
  }

  private async inScope(tx: Tx, share: ShareLink, assetId: string): Promise<boolean> {
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      SELECT a.id FROM assets a
      WHERE ${visible(share.userId)} AND a.id = ${assetId}::uuid
        AND ${this.scope(share.userId, share.kind, share.targetId)}`;
    return Boolean(row);
  }

  async asset(
    token: string,
    session: string | undefined,
    assetId: string,
    meta: RequestMeta,
  ): Promise<SharedAsset> {
    const share = await this.open(token, session, meta);
    const owner = share.userId;
    return withUser(this.ctx.db, owner, async (tx) => {
      if (!(await this.inScope(tx, share, assetId))) throw notFound('Photo not found');
      const [row] = await tx.$queryRaw<
        TileRow[]
      >`SELECT ${TILE_COLUMNS} FROM assets a WHERE a.id = ${assetId}::uuid`;
      const asset = await tx.asset.findUniqueOrThrow({ where: { id: assetId } });
      const variants = new Set(
        (await tx.derivative.findMany({ where: { assetId }, select: { variant: true } })).map(
          (d) => d.variant,
        ),
      );
      const [tile] = this.publicTiles(share, await this.browse.toTiles(owner, [row!]));
      return {
        ...tile!,
        mimeType: asset.mimeType,
        preview:
          variants.has('lg') && variants.has('md')
            ? {
                lg: await this.urls.derivative(owner, asset.sha256, 'lg'),
                md: await this.urls.derivative(owner, asset.sha256, 'md'),
              }
            : null,
        stream: streamQualities(variants),
        motionUrl: variants.has('motion') ? await this.urls.object(motionKey(owner, asset.sha256)) : null,
        downloadUrl: share.allowDownload ? await this.urls.original(asset, 'attachment') : null,
      };
    });
  }

  async streamMaster(token: string, session: string | undefined, assetId: string, meta: RequestMeta) {
    const share = await this.open(token, session, meta);
    const allowed = await withUser(this.ctx.db, share.userId, (tx) => this.inScope(tx, share, assetId));
    return allowed ? this.streams.master(share.userId, assetId) : null;
  }

  async streamMedia(
    token: string,
    session: string | undefined,
    assetId: string,
    quality: number,
    meta: RequestMeta,
  ) {
    const share = await this.open(token, session, meta);
    const allowed = await withUser(this.ctx.db, share.userId, (tx) => this.inScope(tx, share, assetId));
    return allowed ? this.streams.media(share.userId, assetId, quality) : null;
  }

  /** A zip of the whole share, or of some of it, when the link allows downloads. */
  async createDownload(
    token: string,
    session: string | undefined,
    assetIds: string[] | undefined,
    meta: RequestMeta,
  ): Promise<DownloadSummary> {
    const share = await this.open(token, session, meta);
    if (!share.allowDownload) throw new HttpError(403, 'forbidden', 'This link doesn’t allow downloads');
    let request: CreateDownloadRequest;
    if (assetIds) {
      const inScope = await withUser(
        this.ctx.db,
        share.userId,
        (tx) =>
          tx.$queryRaw<{ id: string }[]>`
          SELECT a.id FROM assets a
          WHERE ${visible(share.userId)} AND a.id = ANY(${assetIds}::uuid[])
            AND ${this.scope(share.userId, share.kind, share.targetId)}`,
      );
      if (inScope.length === 0) throw notFound('Nothing to download');
      request = { assetIds: inScope.map((row) => row.id) };
    } else {
      request =
        share.kind === 'album'
          ? { albumId: share.targetId }
          : share.kind === 'folder'
            ? { folderId: share.targetId }
            : { assetIds: [share.targetId] };
    }
    const summary = await this.downloads.create(share.userId, request, { shareId: share.id });
    await audit(this.ctx.db, {
      userId: share.userId,
      type: 'share.downloaded',
      meta,
      metadata: { shareId: share.id, files: summary.fileCount, bytes: summary.totalBytes },
    });
    return summary;
  }

  async openDownload(token: string, session: string | undefined, id: string, meta: RequestMeta) {
    const share = await this.open(token, session, meta);
    if (!share.allowDownload) throw new HttpError(403, 'forbidden', 'This link doesn’t allow downloads');
    return this.downloads.open(share.userId, id, { shareId: share.id });
  }
}
