import { isUuid } from '../db';

const SHA256 = /^[0-9a-f]{64}$/;

function assertParts(userId: string, sha256: string): void {
  if (!isUuid(userId)) throw new Error('invalid user id for an S3 key');
  if (!SHA256.test(sha256)) throw new Error('invalid sha256 for an S3 key');
}

export function safeExtension(extension: string): string {
  const lower = extension.toLowerCase();
  return /^[a-z0-9]{1,10}$/.test(lower) ? lower : '';
}

export function originalKey(userId: string, sha256: string, extension: string): string {
  assertParts(userId, sha256);
  const ext = safeExtension(extension);
  return `users/${userId}/originals/${sha256.slice(0, 2)}/${sha256}${ext ? `.${ext}` : ''}`;
}

export function thumbKey(userId: string, sha256: string, variant: string): string {
  assertParts(userId, sha256);
  if (!/^[a-z0-9-]{1,20}$/.test(variant)) throw new Error('invalid derivative variant');
  return `users/${userId}/thumbs/${sha256}/${variant}.webp`;
}

/** One HLS rendition of a video: a single fragmented MP4 that the playlist addresses by byte range. */
export function streamKey(userId: string, sha256: string, height: number): string {
  assertParts(userId, sha256);
  if (!Number.isInteger(height) || height < 16 || height > 4320) throw new Error('invalid stream height');
  return `users/${userId}/streams/${sha256}/${height}p.mp4`;
}

/** Parses keys written by the app or dropped into a user's inbox. Anything else returns null. */
export function parseKey(
  key: string,
):
  | { kind: 'original'; userId: string; sha256: string }
  | { kind: 'thumb'; userId: string; sha256: string }
  | { kind: 'inbox'; userId: string; name: string }
  | null {
  const original = /^users\/([0-9a-f-]{36})\/originals\/[0-9a-f]{2}\/([0-9a-f]{64})(\.[a-z0-9]{1,10})?$/.exec(
    key,
  );
  if (original && isUuid(original[1])) return { kind: 'original', userId: original[1], sha256: original[2]! };
  const thumb = /^users\/([0-9a-f-]{36})\/thumbs\/([0-9a-f]{64})\/[a-z0-9-]+\.webp$/.exec(key);
  if (thumb && isUuid(thumb[1])) return { kind: 'thumb', userId: thumb[1], sha256: thumb[2]! };
  const inbox = /^users\/([0-9a-f-]{36})\/inbox\/(.+)$/.exec(key);
  if (inbox && isUuid(inbox[1])) return { kind: 'inbox', userId: inbox[1], name: inbox[2]! };
  return null;
}

/** S3 user metadata must be ASCII; non-ASCII names and paths are percent-encoded. */
export function encodeMetadataValue(value: string, maxLength = 1024): string {
  const encoded = encodeURIComponent(value);
  return encoded.length > maxLength
    ? `${encoded.slice(0, maxLength - 3).replace(/%[0-9A-F]?$/i, '')}...`
    : encoded;
}

export function decodeMetadataValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeURIComponent(value.replace(/\.\.\.$/, ''));
  } catch {
    return value;
  }
}
