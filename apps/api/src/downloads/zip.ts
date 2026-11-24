import type { Readable } from 'node:stream';
import { crc32 } from 'node:zlib';

/**
 * A streaming ZIP writer for originals. Files are stored, not compressed (photos and videos
 * don't shrink), so the archive's exact size is known before the first byte: the browser can
 * show real progress and time left. Zip64 is used wherever a size or offset needs it.
 */
export interface ZipEntry {
  /** Path inside the archive, with forward slashes. */
  name: string;
  size: number;
  modifiedAt: Date;
}

export interface ZipLimits {
  /** Largest value a 32-bit field may hold before zip64 takes over (lowered in tests). */
  max32: number;
  max16: number;
}

const LIMITS: ZipLimits = { max32: 0xffffffff, max16: 0xffff };
const FLAGS = 0x0008 | 0x0800; // sizes and CRC follow the data; names are UTF-8
const MADE_BY = (3 << 8) | 45; // Unix, zip 4.5
const FILE_MODE = (0o100644 << 16) >>> 0;
const UT_EXTRA = 9; // extended timestamp: modification time in UTC

interface Planned {
  entry: ZipEntry;
  name: Buffer;
  offset: number;
  zip64: boolean;
}

export interface ZipPlan {
  entries: Planned[];
  centralOffset: number;
  centralSize: number;
  zip64End: boolean;
  totalSize: number;
  timeZone: string;
}

function centralZip64Fields(planned: Planned, limits: ZipLimits): number {
  let fields = 0;
  if (planned.entry.size >= limits.max32) fields += 2; // uncompressed and compressed size
  if (planned.offset >= limits.max32) fields += 1;
  return fields;
}

export function planZip(entries: ZipEntry[], timeZone: string, limits: ZipLimits = LIMITS): ZipPlan {
  let offset = 0;
  const planned: Planned[] = [];
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const zip64 = entry.size >= limits.max32 || offset >= limits.max32;
    planned.push({ entry, name, offset, zip64 });
    offset += 30 + name.length + UT_EXTRA + (zip64 ? 20 : 0) + entry.size + (zip64 ? 24 : 16);
  }
  const centralOffset = offset;
  let centralSize = 0;
  for (const item of planned) {
    const fields = centralZip64Fields(item, limits);
    centralSize += 46 + item.name.length + UT_EXTRA + (fields ? 4 + fields * 8 : 0);
  }
  const zip64End =
    planned.length >= limits.max16 ||
    centralOffset >= limits.max32 ||
    centralSize >= limits.max32 ||
    planned.some((item) => item.zip64);
  return {
    entries: planned,
    centralOffset,
    centralSize,
    zip64End,
    totalSize: centralOffset + centralSize + (zip64End ? 56 + 20 : 0) + 22,
    timeZone,
  };
}

/** MS-DOS date and time, as the wall clock shows it in the owner's time zone. */
export function dosDateTime(date: Date, timeZone: string): { date: number; time: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const year = Math.min(2107, Math.max(1980, parts.year!));
  return {
    date: ((year - 1980) << 9) | (parts.month! << 5) | parts.day!,
    time: (parts.hour! << 11) | (parts.minute! << 5) | Math.floor(parts.second! / 2),
  };
}

const unixSeconds = (date: Date) => Math.min(0xffffffff, Math.max(0, Math.floor(date.getTime() / 1000)));

function timestampExtra(date: Date): Buffer {
  const extra = Buffer.alloc(UT_EXTRA);
  extra.writeUInt16LE(0x5455, 0);
  extra.writeUInt16LE(5, 2);
  extra.writeUInt8(1, 4);
  extra.writeUInt32LE(unixSeconds(date), 5);
  return extra;
}

function localHeader(item: Planned, timeZone: string): Buffer {
  const { date, time } = dosDateTime(item.entry.modifiedAt, timeZone);
  const zip64Extra = item.zip64 ? 20 : 0;
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(item.zip64 ? 45 : 20, 4);
  header.writeUInt16LE(FLAGS, 6);
  header.writeUInt16LE(0, 8); // stored
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(date, 12);
  // CRC and sizes come in the data descriptor; zip64 entries mark the sizes as "see extra".
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(item.zip64 ? 0xffffffff : 0, 18);
  header.writeUInt32LE(item.zip64 ? 0xffffffff : 0, 22);
  header.writeUInt16LE(item.name.length, 26);
  header.writeUInt16LE(UT_EXTRA + zip64Extra, 28);
  const parts = [header, item.name, timestampExtra(item.entry.modifiedAt)];
  if (item.zip64) {
    const extra = Buffer.alloc(20);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    parts.push(extra);
  }
  return Buffer.concat(parts);
}

function descriptor(item: Planned, crc: number): Buffer {
  const out = Buffer.alloc(item.zip64 ? 24 : 16);
  out.writeUInt32LE(0x08074b50, 0);
  out.writeUInt32LE(crc, 4);
  if (item.zip64) {
    out.writeBigUInt64LE(BigInt(item.entry.size), 8);
    out.writeBigUInt64LE(BigInt(item.entry.size), 16);
  } else {
    out.writeUInt32LE(item.entry.size, 8);
    out.writeUInt32LE(item.entry.size, 12);
  }
  return out;
}

function centralHeader(item: Planned, crc: number, timeZone: string, limits: ZipLimits): Buffer {
  const { date, time } = dosDateTime(item.entry.modifiedAt, timeZone);
  const bigSize = item.entry.size >= limits.max32;
  const bigOffset = item.offset >= limits.max32;
  const fields = centralZip64Fields(item, limits);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(MADE_BY, 4);
  header.writeUInt16LE(item.zip64 ? 45 : 20, 6);
  header.writeUInt16LE(FLAGS, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(bigSize ? 0xffffffff : item.entry.size, 20);
  header.writeUInt32LE(bigSize ? 0xffffffff : item.entry.size, 24);
  header.writeUInt16LE(item.name.length, 28);
  header.writeUInt16LE(UT_EXTRA + (fields ? 4 + fields * 8 : 0), 30);
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(FILE_MODE, 38);
  header.writeUInt32LE(bigOffset ? 0xffffffff : item.offset, 42);
  const parts = [header, item.name, timestampExtra(item.entry.modifiedAt)];
  if (fields) {
    const extra = Buffer.alloc(4 + fields * 8);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(fields * 8, 2);
    let at = 4;
    if (bigSize) {
      extra.writeBigUInt64LE(BigInt(item.entry.size), at);
      extra.writeBigUInt64LE(BigInt(item.entry.size), at + 8);
      at += 16;
    }
    if (bigOffset) extra.writeBigUInt64LE(BigInt(item.offset), at);
    parts.push(extra);
  }
  return Buffer.concat(parts);
}

function endRecords(plan: ZipPlan, limits: ZipLimits): Buffer {
  const count = plan.entries.length;
  const parts: Buffer[] = [];
  if (plan.zip64End) {
    const zip64End = Buffer.alloc(56);
    zip64End.writeUInt32LE(0x06064b50, 0);
    zip64End.writeBigUInt64LE(44n, 4);
    zip64End.writeUInt16LE(MADE_BY, 12);
    zip64End.writeUInt16LE(45, 14);
    zip64End.writeUInt32LE(0, 16);
    zip64End.writeUInt32LE(0, 20);
    zip64End.writeBigUInt64LE(BigInt(count), 24);
    zip64End.writeBigUInt64LE(BigInt(count), 32);
    zip64End.writeBigUInt64LE(BigInt(plan.centralSize), 40);
    zip64End.writeBigUInt64LE(BigInt(plan.centralOffset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeUInt32LE(0, 4);
    locator.writeBigUInt64LE(BigInt(plan.centralOffset + plan.centralSize), 8);
    locator.writeUInt32LE(1, 16);
    parts.push(zip64End, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(count, limits.max16), 8);
  end.writeUInt16LE(Math.min(count, limits.max16), 10);
  end.writeUInt32LE(Math.min(plan.centralSize, limits.max32), 12);
  end.writeUInt32LE(Math.min(plan.centralOffset, limits.max32), 16);
  parts.push(end);
  return Buffer.concat(parts);
}

/**
 * Yields the archive. `open` supplies each file's bytes in order; a file that turns out
 * shorter or longer than planned stops the archive with an error rather than corrupting it.
 */
export async function* zipStream(
  plan: ZipPlan,
  open: (entry: ZipEntry, index: number) => Promise<Readable>,
  limits: ZipLimits = LIMITS,
): AsyncGenerator<Buffer> {
  const crcs: number[] = [];
  for (const [index, item] of plan.entries.entries()) {
    yield localHeader(item, plan.timeZone);
    let crc = 0;
    let written = 0;
    for await (const chunk of await open(item.entry, index)) {
      const buffer = chunk as Buffer;
      written += buffer.length;
      if (written > item.entry.size) throw new Error(`${item.entry.name} is larger than recorded`);
      crc = crc32(buffer, crc);
      yield buffer;
    }
    if (written !== item.entry.size) throw new Error(`${item.entry.name} is shorter than recorded`);
    crcs.push(crc);
    yield descriptor(item, crc);
  }
  for (const [index, item] of plan.entries.entries())
    yield centralHeader(item, crcs[index]!, plan.timeZone, limits);
  yield endRecords(plan, limits);
}

/** "IMG.jpg", "IMG (2).jpg", … so no two entries in a folder share a name. */
export function uniqueNames(paths: string[]): string[] {
  const taken = new Set<string>();
  return paths.map((path) => {
    let candidate = path;
    for (let count = 2; taken.has(candidate.toLowerCase()); count += 1) {
      const slash = path.lastIndexOf('/');
      const dot = path.lastIndexOf('.');
      const hasExtension = dot > slash + 1;
      candidate = hasExtension ? `${path.slice(0, dot)} (${count})${path.slice(dot)}` : `${path} (${count})`;
    }
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}
