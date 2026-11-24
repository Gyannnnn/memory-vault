import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { CreateDownloadRequest, DownloadSummary } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { withUser, type Tx } from '../db';
import { notFound } from '../http/errors';
import { visible } from '../library/browse';
import { planZip, uniqueNames, zipStream, type ZipPlan } from './zip';

const TTL_SECONDS = 60 * 60;
const key = (id: string) => `download:${id}`;

interface StoredDownload {
  userId: string;
  request: CreateDownloadRequest;
  fileName: string;
}

interface FileRow {
  path: string;
  size_bytes: bigint;
  s3_key: string;
  modified_at: Date;
}

/** A name that is safe as a file name on every system. */
const safeFileName = (name: string) =>
  [...name]
    .map((char) => (char.charCodeAt(0) < 32 ? '-' : char))
    .join('')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^[.\s]+|[.\s]+$/g, '') || 'memory-vault';

/**
 * Zips of originals, streamed from S3 through the API without touching the disk. A
 * download is prepared first (the files are checked against the caller's library and the
 * exact zip size is worked out), then fetched by id within the hour.
 */
export class DownloadService {
  constructor(private readonly ctx: Pick<AppContext, 'db' | 's3' | 'env' | 'redis' | 'logger'>) {}

  private async files(
    tx: Tx,
    userId: string,
    request: CreateDownloadRequest,
    timeZone: string,
  ): Promise<{ name: string; rows: FileRow[] }> {
    if ('assetIds' in request) {
      const rows = await tx.$queryRaw<FileRow[]>`
        SELECT a.original_name AS path, a.size_bytes, a.s3_key,
               coalesce(a.original_modified_at, a.taken_at, a.created_at) AS modified_at
        FROM assets a
        WHERE ${visible(userId)} AND a.id = ANY(${request.assetIds}::uuid[])
        ORDER BY a.local_at, a.id`;
      // Today on the owner's calendar (en-CA writes YYYY-MM-DD).
      const day = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
      return { name: `Memory Vault ${day} (${rows.length} ${rows.length === 1 ? 'file' : 'files'})`, rows };
    }
    const [folder] = await tx.$queryRaw<{ name: string }[]>`
      SELECT name FROM folders WHERE id = ${request.folderId}::uuid AND user_id = ${userId}::uuid AND deleted_at IS NULL`;
    if (!folder) throw notFound('Folder not found');
    const rows = await tx.$queryRaw<FileRow[]>`
      WITH RECURSIVE tree AS (
        SELECT f.id, ''::text AS path FROM folders f
        WHERE f.id = ${request.folderId}::uuid AND f.user_id = ${userId}::uuid AND f.deleted_at IS NULL
        UNION ALL
        SELECT child.id, tree.path || child.name || '/'
        FROM folders child JOIN tree ON child.parent_id = tree.id
        WHERE child.deleted_at IS NULL
      )
      SELECT tree.path || e.name AS path, a.size_bytes, a.s3_key,
             coalesce(a.original_modified_at, a.taken_at, a.created_at) AS modified_at
      FROM tree
      JOIN file_entries e ON e.folder_id = tree.id AND e.deleted_at IS NULL
      JOIN assets a ON a.id = e.asset_id
      WHERE ${visible(userId)}
      ORDER BY path`;
    return { name: folder.name || 'Folder', rows };
  }

  private async prepare(userId: string, request: CreateDownloadRequest) {
    return withUser(this.ctx.db, userId, async (tx) => {
      const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { timezone: true } });
      const { name, rows } = await this.files(tx, userId, request, user.timezone);
      if (rows.length === 0) throw notFound('Nothing to download');
      const names = uniqueNames(rows.map((row) => row.path));
      const plan = planZip(
        rows.map((row, index) => ({
          name: names[index]!,
          size: Number(row.size_bytes),
          modifiedAt: row.modified_at,
        })),
        user.timezone,
      );
      return { fileName: `${safeFileName(name)}.zip`, plan, keys: rows.map((row) => row.s3_key) };
    });
  }

  async create(userId: string, request: CreateDownloadRequest): Promise<DownloadSummary> {
    const { fileName, plan } = await this.prepare(userId, request);
    const id = randomBytes(16).toString('hex');
    const stored: StoredDownload = { userId, request, fileName };
    await this.ctx.redis.set(key(id), JSON.stringify(stored), 'EX', TTL_SECONDS);
    return { id, fileName, fileCount: plan.entries.length, totalBytes: plan.totalSize };
  }

  /** The prepared zip, re-checked against the library now; only its owner can fetch it. */
  async open(
    userId: string,
    id: string,
  ): Promise<{ fileName: string; plan: ZipPlan; stream: () => AsyncGenerator<Buffer> }> {
    const raw = /^[0-9a-f]{32}$/.test(id) ? await this.ctx.redis.get(key(id)) : null;
    const stored = raw ? (JSON.parse(raw) as StoredDownload) : null;
    if (!stored || stored.userId !== userId) throw notFound('This download has expired; start it again');
    const { fileName, plan, keys } = await this.prepare(userId, stored.request);
    const open = async (_entry: unknown, index: number) => {
      const object = await this.ctx.s3.send(
        new GetObjectCommand({ Bucket: this.ctx.env.S3_BUCKET, Key: keys[index]! }),
      );
      return object.Body as Readable;
    };
    return { fileName, plan, stream: () => zipStream(plan, open) };
  }
}

export const contentDisposition = (fileName: string) =>
  `attachment; filename="${fileName.replace(/[^\x20-\x7e]|["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
