import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import type { AppContext } from '../context';
import { withUser } from '../db';
import { parseKey } from '../storage/keys';

type MaintenanceContext = Pick<AppContext, 'db' | 's3' | 'env' | 'logger'>;

export interface IntegrityReport {
  checkedAt: string;
  users: {
    userId: string;
    assetsInDatabase: number;
    objectsInS3: number;
    missingInS3: { assetId: string; key: string }[];
    sizeMismatches: { assetId: string; key: string; database: string; s3: number }[];
    unrecordedInS3: { key: string; size: number }[];
  }[];
  healthy: boolean;
}

async function listOriginals(ctx: MaintenanceContext, userId: string): Promise<Map<string, number>> {
  const objects = new Map<string, number>();
  let ContinuationToken: string | undefined;
  do {
    const page = await ctx.s3.send(
      new ListObjectsV2Command({
        Bucket: ctx.env.S3_BUCKET,
        Prefix: `users/${userId}/originals/`,
        ...(ContinuationToken ? { ContinuationToken } : {}),
      }),
    );
    for (const object of page.Contents ?? []) if (object.Key) objects.set(object.Key, object.Size ?? 0);
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return objects;
}

/** Every database record has its object in S3 with the right size, and every original in S3 is recorded. */
export async function runIntegrityCheck(ctx: MaintenanceContext): Promise<IntegrityReport> {
  const users = await ctx.db.user.findMany({ where: { status: { not: 'deleted' } }, select: { id: true } });
  const report: IntegrityReport = { checkedAt: new Date().toISOString(), users: [], healthy: true };
  for (const { id: userId } of users) {
    const objects = await listOriginals(ctx, userId);
    const assets = await withUser(ctx.db, userId, (tx) =>
      tx.asset.findMany({
        where: { status: { in: ['verified', 'missing'] }, deletedAt: null },
        select: { id: true, s3Key: true, sizeBytes: true, status: true },
      }),
    );
    const result: IntegrityReport['users'][number] = {
      userId,
      assetsInDatabase: assets.length,
      objectsInS3: objects.size,
      missingInS3: [],
      sizeMismatches: [],
      unrecordedInS3: [],
    };
    const recorded = new Set<string>();
    const nowMissing: string[] = [];
    const backAgain: string[] = [];
    for (const asset of assets) {
      recorded.add(asset.s3Key);
      const size = objects.get(asset.s3Key);
      if (size === undefined) {
        result.missingInS3.push({ assetId: asset.id, key: asset.s3Key });
        if (asset.status === 'verified') nowMissing.push(asset.id);
      } else {
        if (BigInt(size) !== asset.sizeBytes) {
          result.sizeMismatches.push({
            assetId: asset.id,
            key: asset.s3Key,
            database: asset.sizeBytes.toString(),
            s3: size,
          });
        }
        if (asset.status === 'missing') backAgain.push(asset.id);
      }
    }
    for (const [key, size] of objects) {
      if (!recorded.has(key) && parseKey(key)?.kind === 'original') result.unrecordedInS3.push({ key, size });
    }
    await withUser(ctx.db, userId, async (tx) => {
      if (nowMissing.length)
        await tx.asset.updateMany({ where: { id: { in: nowMissing } }, data: { status: 'missing' } });
      if (backAgain.length) {
        await tx.asset.updateMany({
          where: { id: { in: backAgain } },
          data: { status: 'verified', lastSeenInS3At: new Date() },
        });
      }
      if (assets.length) {
        await tx.asset.updateMany({
          where: { id: { in: assets.filter((asset) => objects.has(asset.s3Key)).map((asset) => asset.id) } },
          data: { lastSeenInS3At: new Date() },
        });
      }
    });
    if (result.missingInS3.length || result.sizeMismatches.length || result.unrecordedInS3.length)
      report.healthy = false;
    report.users.push(result);
  }
  const body = Buffer.from(JSON.stringify(report, null, 2));
  await ctx.s3.send(
    new PutObjectCommand({
      Bucket: ctx.env.S3_BUCKET,
      Key: `system/integrity/${report.checkedAt.slice(0, 10)}.json`,
      Body: body,
      ContentType: 'application/json',
      StorageClass: 'INTELLIGENT_TIERING',
    }),
  );
  ctx.logger[report.healthy ? 'info' : 'error']({ healthy: report.healthy }, 'integrity check finished');
  return report;
}

/** pg_dump (custom format) uploaded to S3: daily copies, plus a monthly copy kept indefinitely. */
export async function runDatabaseBackup(ctx: MaintenanceContext): Promise<string[]> {
  const url = ctx.env.DATABASE_MIGRATE_URL;
  if (!url) throw new Error('DATABASE_MIGRATE_URL is required for backups');
  const directory = mkdtempSync(join(tmpdir(), 'vault-backup-'));
  const file = join(directory, 'vault.dump');
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('pg_dump', ['--format=custom', '--no-owner', `--file=${file}`, url], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', reject);
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pg_dump failed: ${stderr.trim()}`)),
      );
    });
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    const checksum = hash.digest('base64');
    const day = new Date().toISOString().slice(0, 10);
    const keys = [`system/db-backups/daily/${day}.dump`];
    if (day.endsWith('-01')) keys.push(`system/db-backups/monthly/${day.slice(0, 7)}.dump`);
    for (const Key of keys) {
      await ctx.s3.send(
        new PutObjectCommand({
          Bucket: ctx.env.S3_BUCKET,
          Key,
          Body: createReadStream(file),
          ContentLength: statSync(file).size,
          ChecksumSHA256: checksum,
          StorageClass: 'INTELLIGENT_TIERING',
          ContentType: 'application/octet-stream',
        }),
      );
    }
    ctx.logger.info({ keys }, 'database backup uploaded');
    return keys;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * A plain JSON-lines catalogue of every asset with all the places it came from
 * and the folders it appears in, so the library can be understood and rebuilt
 * from the bucket alone.
 */
export async function runCatalogExport(ctx: MaintenanceContext): Promise<string[]> {
  const users = await ctx.db.user.findMany({
    where: { status: { not: 'deleted' } },
    select: { id: true, email: true },
  });
  const keys: string[] = [];
  for (const user of users) {
    const { assets, folders } = await withUser(ctx.db, user.id, async (tx) => ({
      assets: await tx.asset.findMany({
        where: { status: 'verified' },
        include: {
          origins: true,
          entries: { where: { deletedAt: null } },
          albumItems: { select: { album: { select: { name: true } } } },
        },
        orderBy: { id: 'asc' },
      }),
      folders: await tx.folder.findMany({ select: { id: true, parentId: true, name: true } }),
    }));
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const pathOf = (folderId: string): string => {
      const names: string[] = [];
      for (let current = byId.get(folderId); current?.parentId; current = byId.get(current.parentId)) {
        names.unshift(current.name);
      }
      return names.join('/');
    };
    const lines = assets.map((asset) =>
      JSON.stringify({
        sha256: asset.sha256,
        s3Key: asset.s3Key,
        sizeBytes: asset.sizeBytes.toString(),
        mimeType: asset.mimeType,
        originalName: asset.originalName,
        takenAt: asset.takenAt,
        gps: asset.gpsLatitude !== null ? [asset.gpsLatitude, asset.gpsLongitude] : null,
        camera: [asset.cameraMake, asset.cameraModel].filter(Boolean).join(' ') || null,
        locations: asset.entries.map((entry) => `${pathOf(entry.folderId)}/${entry.name}`),
        favoriteAt: asset.favoriteAt,
        deletedAt: asset.deletedAt,
        albums: asset.albumItems.map((item) => item.album.name),
        origins: asset.origins.map((origin) => ({
          source: origin.sourceId,
          path: origin.originalPath,
          modifiedAt: origin.originalModifiedAt,
        })),
      }),
    );
    const body = gzipSync(
      `${JSON.stringify({ format: 'memory-vault-catalog/1', userId: user.id, exportedAt: new Date() })}\n${lines.join('\n')}\n`,
    );
    const latest = `system/catalog/${user.id}/latest.jsonl.gz`;
    const dated = `system/catalog/${user.id}/${new Date().toISOString().slice(0, 10)}.jsonl.gz`;
    for (const Key of [latest, dated]) {
      await ctx.s3.send(
        new PutObjectCommand({
          Bucket: ctx.env.S3_BUCKET,
          Key,
          Body: body,
          ContentType: 'application/gzip',
          StorageClass: 'INTELLIGENT_TIERING',
          ChecksumSHA256: createHash('sha256').update(body).digest('base64'),
        }),
      );
    }
    keys.push(latest, dated);
  }
  return keys;
}
