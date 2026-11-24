import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { AppContext } from '../context';
import type { Asset } from '../generated/prisma/client';

/** Where the worker container sees the sources (read-only mounts from docker-compose.yml). */
export const SOURCE_MOUNTS = { laptop: '/mnt/sources/laptop', staging: '/mnt/sources/staging' } as const;

/** Maps a path on the uploading machine to where the worker sees it (read-only mounts). */
export function mapLocalPath(localPath: string, pathMap: string): string | null {
  for (const pair of pathMap.split(';').filter(Boolean)) {
    const [host, container] = pair.split('=');
    if (!host || !container) continue;
    if (localPath === host || localPath.startsWith(`${host}/`))
      return `${container}${localPath.slice(host.length)}`;
  }
  return null;
}

/**
 * Places a local copy of the file may be, most likely first: the uploader's path, then each
 * place the file was found (a laptop source is mounted as is; any source can be staged as
 * `<staging>/<device>-<label>/<path>`, which is where `vault phone stage-pending` puts it).
 * None is trusted until its size and SHA-256 match.
 */
export function localCandidates(
  input: { localPath?: string; origins: { sourceId: string; path: string }[] },
  pathMap: string,
): string[] {
  const candidates: string[] = [];
  if (input.localPath) {
    const mapped = mapLocalPath(input.localPath, pathMap);
    if (mapped) candidates.push(mapped);
    candidates.push(input.localPath);
  }
  for (const origin of input.origins) {
    if (!origin.path || origin.path.split('/').includes('..') || origin.path.startsWith('/')) continue;
    if (origin.sourceId.startsWith('laptop:')) candidates.push(`${SOURCE_MOUNTS.laptop}/${origin.path}`);
    candidates.push(`${SOURCE_MOUNTS.staging}/${origin.sourceId.replace(':', '-')}/${origin.path}`);
  }
  return [...new Set(candidates)];
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** Uses a local copy when one is visible and identical; otherwise downloads the original from S3. */
export async function obtainOriginal(
  ctx: Pick<AppContext, 's3' | 'env'>,
  asset: Pick<Asset, 'sizeBytes' | 'sha256' | 's3Key' | 'extension'>,
  where: { localPath?: string; origins: { sourceId: string; path: string }[] },
  workDirectory: string,
): Promise<{ path: string; from: 'local' | 's3' }> {
  for (const candidate of localCandidates(where, ctx.env.LOCAL_PATH_MAP)) {
    if (!existsSync(candidate) || statSync(candidate).size !== Number(asset.sizeBytes)) continue;
    if ((await sha256File(candidate)) === asset.sha256) return { path: candidate, from: 'local' };
  }
  const target = join(workDirectory, `original.${asset.extension || 'bin'}`);
  const object = await ctx.s3.send(new GetObjectCommand({ Bucket: ctx.env.S3_BUCKET, Key: asset.s3Key }));
  await pipeline(object.Body as Readable, createWriteStream(target));
  return { path: target, from: 's3' };
}
