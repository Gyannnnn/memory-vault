import type { AlbumList, AlbumSummary, MediaUrls } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { newId, Prisma, withUser, type Tx } from '../db';
import { badRequest, notFound } from '../http/errors';
import { visible } from './browse';
import { MediaUrlSigner } from './media-urls';

interface AlbumRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
  count: number;
  cover_sha256: string | null;
}

const HAS_THUMB = Prisma.sql`EXISTS (SELECT 1 FROM derivatives d WHERE d.asset_id = a.id AND d.variant = 'sm')`;

/**
 * Albums and favourites. An album holds references, never files: deleting an album or
 * taking a photo out of one leaves the photo where it was. Only visible items count
 * (trashed ones are left out of counts, covers and listings).
 */
export class AlbumService {
  private readonly urls: MediaUrlSigner;

  constructor(private readonly ctx: Pick<AppContext, 'db' | 's3' | 'env'>) {
    this.urls = new MediaUrlSigner(ctx);
  }

  private rows(tx: Tx, userId: string, albumId?: string): Promise<AlbumRow[]> {
    return tx.$queryRaw<AlbumRow[]>`
      SELECT al.id, al.name, al.created_at, al.updated_at,
        (SELECT count(*)::int FROM album_items ai JOIN assets a ON a.id = ai.asset_id
          WHERE ai.album_id = al.id AND ${visible(userId)}) AS count,
        coalesce(
          (SELECT a.sha256 FROM album_items ai JOIN assets a ON a.id = ai.asset_id
            WHERE ai.album_id = al.id AND a.id = al.cover_asset_id AND ${visible(userId)} AND ${HAS_THUMB}),
          (SELECT a.sha256 FROM album_items ai JOIN assets a ON a.id = ai.asset_id
            WHERE ai.album_id = al.id AND ${visible(userId)} AND ${HAS_THUMB}
            ORDER BY a.local_at DESC, a.id DESC LIMIT 1)
        ) AS cover_sha256
      FROM albums al
      WHERE al.user_id = ${userId}::uuid ${albumId ? Prisma.sql`AND al.id = ${albumId}::uuid` : Prisma.empty}
      ORDER BY al.updated_at DESC, al.id`;
  }

  private cover(userId: string, sha256: string | null): Promise<MediaUrls | null> {
    return sha256 ? this.urls.thumbs(userId, sha256) : Promise.resolve(null);
  }

  private async summary(userId: string, row: AlbumRow): Promise<AlbumSummary> {
    return {
      id: row.id,
      name: row.name,
      count: row.count,
      cover: await this.cover(userId, row.cover_sha256),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async owned(tx: Tx, userId: string, albumId: string): Promise<void> {
    const album = await tx.album.findFirst({ where: { id: albumId, userId }, select: { id: true } });
    if (!album) throw notFound('Album not found');
  }

  /** Adds the caller's visible assets among `assetIds`; anything else is ignored. */
  private async add(tx: Tx, userId: string, albumId: string, assetIds: string[]): Promise<number> {
    if (assetIds.length === 0) return 0;
    return tx.$executeRaw`
      INSERT INTO album_items (album_id, asset_id, user_id)
      SELECT ${albumId}::uuid, a.id, a.user_id FROM assets a
      WHERE ${visible(userId)} AND a.id = ANY(${assetIds}::uuid[])
      ON CONFLICT DO NOTHING`;
  }

  private touch(tx: Tx, albumId: string) {
    return tx.$executeRaw`UPDATE albums SET updated_at = now() WHERE id = ${albumId}::uuid`;
  }

  list(userId: string): Promise<AlbumList> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const rows = await this.rows(tx, userId);
      const [favorites] = await tx.$queryRaw<{ count: number; cover_sha256: string | null }[]>`
        SELECT count(*)::int AS count,
          (SELECT a.sha256 FROM assets a
            WHERE ${visible(userId)} AND a.favorite_at IS NOT NULL AND ${HAS_THUMB}
            ORDER BY a.favorite_at DESC, a.id DESC LIMIT 1) AS cover_sha256
        FROM assets a WHERE ${visible(userId)} AND a.favorite_at IS NOT NULL`;
      return {
        favorites: {
          count: favorites?.count ?? 0,
          cover: await this.cover(userId, favorites?.cover_sha256 ?? null),
        },
        albums: await Promise.all(rows.map((row) => this.summary(userId, row))),
      };
    });
  }

  get(userId: string, albumId: string): Promise<AlbumSummary> {
    return withUser(this.ctx.db, userId, async (tx) => {
      const [row] = await this.rows(tx, userId, albumId);
      if (!row) throw notFound('Album not found');
      return this.summary(userId, row);
    });
  }

  async create(userId: string, input: { name: string; assetIds: string[] }): Promise<AlbumSummary> {
    const id = newId();
    await withUser(this.ctx.db, userId, async (tx) => {
      await tx.album.create({ data: { id, userId, name: input.name } });
      await this.add(tx, userId, id, input.assetIds);
    });
    return this.get(userId, id);
  }

  async update(
    userId: string,
    albumId: string,
    input: { name?: string | undefined; coverAssetId?: string | null | undefined },
  ): Promise<AlbumSummary> {
    await withUser(this.ctx.db, userId, async (tx) => {
      await this.owned(tx, userId, albumId);
      if (input.coverAssetId) {
        const [member] = await tx.$queryRaw<{ id: string }[]>`
          SELECT a.id FROM album_items ai JOIN assets a ON a.id = ai.asset_id
          WHERE ai.album_id = ${albumId}::uuid AND a.id = ${input.coverAssetId}::uuid AND ${visible(userId)}`;
        if (!member) throw badRequest('The cover must be a photo in this album');
      }
      await tx.album.update({
        where: { id: albumId },
        data: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.coverAssetId === undefined ? {} : { coverAssetId: input.coverAssetId }),
        },
      });
    });
    return this.get(userId, albumId);
  }

  /** The album goes; the photos in it stay in the library. */
  remove(userId: string, albumId: string): Promise<void> {
    return withUser(this.ctx.db, userId, async (tx) => {
      await this.owned(tx, userId, albumId);
      await tx.album.delete({ where: { id: albumId } });
    });
  }

  addItems(userId: string, albumId: string, assetIds: string[]): Promise<{ added: number }> {
    return withUser(this.ctx.db, userId, async (tx) => {
      await this.owned(tx, userId, albumId);
      const added = await this.add(tx, userId, albumId, assetIds);
      if (added > 0) await this.touch(tx, albumId);
      return { added };
    });
  }

  removeItems(userId: string, albumId: string, assetIds: string[]): Promise<{ removed: number }> {
    return withUser(this.ctx.db, userId, async (tx) => {
      await this.owned(tx, userId, albumId);
      const { count } = await tx.albumItem.deleteMany({ where: { albumId, assetId: { in: assetIds } } });
      if (count > 0) await this.touch(tx, albumId);
      return { removed: count };
    });
  }

  /** Marks or unmarks favourites; a photo keeps the time it was first marked. */
  setFavorite(userId: string, ids: string[], favorite: boolean): Promise<{ updated: number }> {
    return withUser(this.ctx.db, userId, async (tx) => ({
      updated: await tx.$executeRaw`
        UPDATE assets a
        SET favorite_at = ${favorite ? Prisma.sql`coalesce(a.favorite_at, now())` : Prisma.sql`NULL`}
        WHERE ${visible(userId)} AND a.id = ANY(${ids}::uuid[])`,
    }));
  }
}
