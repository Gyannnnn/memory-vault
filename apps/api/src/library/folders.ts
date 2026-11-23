import { deviceOf, fileNameOf, type Origin } from '@memory-vault/shared';
import { newId, type Tx } from '../db';

const ROOT_NAME = '';

const deviceTitles: Record<string, string> = {
  laptop: 'Laptop',
  phone: 'Phone',
  web: 'Web uploads',
  mobile: 'Mobile uploads',
  's3-direct': 'Direct to S3',
};

/** "laptop:s21fe" → "Laptop · s21fe": the top-level folder that mirrors a source. */
export function sourceFolderName(sourceId: string): string {
  const device = deviceOf(sourceId);
  const label = sourceId.slice(device.length + 1);
  const title = deviceTitles[device] ?? device.charAt(0).toUpperCase() + device.slice(1);
  return `${title} · ${label}`;
}

function cleanSegment(segment: string): string {
  const cleaned = [...segment]
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join('')
    .trim();
  return (cleaned || '(unnamed)').slice(0, 255);
}

export async function ensureRootFolder(tx: Tx, userId: string): Promise<string> {
  const existing = await tx.folder.findFirst({ where: { userId, parentId: null, name: ROOT_NAME } });
  if (existing) return existing.id;
  // NULL parents aren't covered by the unique constraint, so serialise root creation per user.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`;
  const again = await tx.folder.findFirst({ where: { userId, parentId: null, name: ROOT_NAME } });
  if (again) return again.id;
  const id = newId();
  await tx.folder.create({ data: { id, userId, parentId: null, name: ROOT_NAME } });
  return id;
}

export async function ensureFolderPath(tx: Tx, userId: string, segments: string[]): Promise<string> {
  let parentId = await ensureRootFolder(tx, userId);
  for (const raw of segments) {
    const name = cleanSegment(raw);
    const where = { userId_parentId_name: { userId, parentId, name } };
    const found = await tx.folder.findUnique({ where });
    if (found) {
      parentId = found.id;
      continue;
    }
    await tx.folder.createMany({ data: [{ id: newId(), userId, parentId, name }], skipDuplicates: true });
    parentId = (await tx.folder.findUniqueOrThrow({ where })).id;
  }
  return parentId;
}

function withSuffix(name: string, attempt: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${attempt})${name.slice(dot)}` : `${name} (${attempt})`;
}

/**
 * Records where an asset came from and mirrors that location as a file entry in
 * the source's folder tree. Repeating the same origin is a no-op.
 */
export async function recordOrigin(
  tx: Tx,
  userId: string,
  assetId: string,
  origin: Pick<Origin, 'sourceId' | 'path' | 'modifiedAt'>,
): Promise<void> {
  const segments = origin.path.split('/').filter(Boolean);
  const fileName = cleanSegment(fileNameOf(origin.path));
  const modifiedAt = origin.modifiedAt ? new Date(origin.modifiedAt) : null;

  await tx.assetOrigin.upsert({
    where: { userId_sourceId_originalPath: { userId, sourceId: origin.sourceId, originalPath: origin.path } },
    create: {
      id: newId(),
      userId,
      assetId,
      sourceId: origin.sourceId,
      originalPath: origin.path,
      originalName: fileName,
      originalModifiedAt: modifiedAt,
    },
    update: { assetId, originalModifiedAt: modifiedAt },
  });

  const folderId = await ensureFolderPath(tx, userId, [
    sourceFolderName(origin.sourceId),
    ...segments.slice(0, -1),
  ]);
  for (let attempt = 1; attempt < 1000; attempt += 1) {
    const name = attempt === 1 ? fileName : withSuffix(fileName, attempt);
    const existing = await tx.fileEntry.findUnique({ where: { folderId_name: { folderId, name } } });
    if (existing?.assetId === assetId) return;
    if (existing) continue;
    const created = await tx.fileEntry.createMany({
      data: [{ id: newId(), userId, folderId, assetId, name }],
      skipDuplicates: true,
    });
    if (created.count === 1) return;
  }
  throw new Error(`could not find a free name for ${fileName}`);
}
