import { gunzipSync } from 'node:zlib';
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { AppContext } from '../context';
import { withUser } from '../db';
import { recordOrigin } from '../library/folders';
import { parseKey } from '../storage/keys';
import type { Jobs } from './queues';
import { adoptOriginal } from './s3-events';

interface CatalogLine {
  sha256: string;
  origins: { source: string; path: string; modifiedAt: string | null }[];
}

/**
 * Rebuilds a user's library from the bucket alone: every original is adopted from
 * its own metadata, then the catalogue export restores every other location.
 */
export async function rebuildIndex(
  ctx: Pick<AppContext, 'db' | 's3' | 'env' | 'logger'> & { jobs: Jobs },
  userId: string,
  onProgress: (message: string) => void,
): Promise<{ adopted: number; locations: number }> {
  let adopted = 0;
  let ContinuationToken: string | undefined;
  do {
    const page = await ctx.s3.send(
      new ListObjectsV2Command({
        Bucket: ctx.env.S3_BUCKET,
        Prefix: `users/${userId}/originals/`,
        ...(ContinuationToken ? { ContinuationToken } : {}),
      }),
    );
    for (const object of page.Contents ?? []) {
      const parsed = object.Key ? parseKey(object.Key) : null;
      if (parsed?.kind !== 'original') continue;
      await adoptOriginal(ctx, userId, object.Key!, parsed.sha256);
      adopted += 1;
      if (adopted % 500 === 0) onProgress(`adopted ${adopted} originals`);
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);

  let locations = 0;
  try {
    const catalog = await ctx.s3.send(
      new GetObjectCommand({ Bucket: ctx.env.S3_BUCKET, Key: `system/catalog/${userId}/latest.jsonl.gz` }),
    );
    const lines = gunzipSync(Buffer.from(await catalog.Body!.transformToByteArray()))
      .toString('utf8')
      .split('\n')
      .slice(1)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as CatalogLine);
    for (const line of lines) {
      await withUser(ctx.db, userId, async (tx) => {
        const asset = await tx.asset.findUnique({
          where: { userId_sha256: { userId, sha256: line.sha256 } },
        });
        if (!asset) return;
        for (const origin of line.origins) {
          await recordOrigin(tx, userId, asset.id, {
            sourceId: origin.source,
            path: origin.path,
            ...(origin.modifiedAt ? { modifiedAt: new Date(origin.modifiedAt).toISOString() } : {}),
          });
          locations += 1;
        }
      });
    }
  } catch (error) {
    if ((error as { name?: string }).name !== 'NoSuchKey') throw error;
    onProgress('no catalogue export found; only the locations stored on each object were restored');
  }
  return { adopted, locations };
}
