import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { dosDateTime, planZip, uniqueNames, zipStream, type ZipEntry, type ZipLimits } from './zip';

const content = (seed: number, size: number) =>
  Buffer.from(Array.from({ length: size }, (_, index) => (index * 31 + seed) % 256));

async function build(entries: (ZipEntry & { data: Buffer })[], limits?: ZipLimits) {
  const plan = planZip(entries, 'Asia/Kolkata', limits);
  const chunks: Buffer[] = [];
  for await (const chunk of zipStream(
    plan,
    (_entry, index) => Promise.resolve(Readable.from([entries[index]!.data])),
    limits,
  ))
    chunks.push(chunk);
  return { plan, zip: Buffer.concat(chunks) };
}

/** Python's zipfile as an independent reader: names, sizes, CRC check and contents' SHA-256. */
function readWithPython(zip: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'zip-test-'));
  try {
    const path = join(directory, 'test.zip');
    writeFileSync(path, zip);
    const script = [
      'import hashlib, json, sys, zipfile',
      'z = zipfile.ZipFile(sys.argv[1])',
      'print(json.dumps({"bad": z.testzip(), "files": [[i.filename, i.file_size, list(i.date_time), hashlib.sha256(z.read(i)).hexdigest()] for i in z.infolist()]}))',
    ].join('\n');
    return JSON.parse(execFileSync('python3', ['-c', script, path]).toString()) as {
      bad: string | null;
      files: [string, number, number[], string][];
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

describe('zip', () => {
  const entries = [
    {
      name: 'DCIM/Camera/IMG_20261122_092444.jpg',
      size: 5000,
      modifiedAt: new Date('2026-11-22T03:54:44Z'),
      data: content(1, 5000),
    },
    {
      name: 'Holi 2026 – रंग.mp4',
      size: 777,
      modifiedAt: new Date('2026-03-14T10:00:01Z'),
      data: content(2, 777),
    },
    { name: 'empty.txt', size: 0, modifiedAt: new Date('2025-01-01T00:00:00Z'), data: Buffer.alloc(0) },
  ];

  it('is exactly as long as planned, and opens cleanly elsewhere', async () => {
    const { plan, zip } = await build(entries);
    expect(zip.length).toBe(plan.totalSize);
    expect(plan.zip64End).toBe(false);
    const read = readWithPython(zip);
    expect(read.bad).toBeNull();
    expect(read.files).toEqual([
      ['DCIM/Camera/IMG_20261122_092444.jpg', 5000, [2026, 11, 22, 9, 24, 44], sha(entries[0]!.data)],
      ['Holi 2026 – रंग.mp4', 777, [2026, 3, 14, 15, 30, 0], sha(entries[1]!.data)],
      ['empty.txt', 0, [2025, 1, 1, 5, 30, 0], sha(Buffer.alloc(0))],
    ]);
  });

  it('switches to zip64 where sizes, offsets or counts need it', async () => {
    const limits = { max32: 1000, max16: 2 };
    const { plan, zip } = await build(entries, limits);
    expect(plan.zip64End).toBe(true);
    expect(plan.entries.map((item) => item.zip64)).toEqual([true, true, true]);
    expect(zip.length).toBe(plan.totalSize);
    const read = readWithPython(zip);
    expect(read.bad).toBeNull();
    expect(read.files.map(([name, size, , digest]) => [name, size, digest])).toEqual(
      entries.map((entry) => [entry.name, entry.size, sha(entry.data)]),
    );
  });

  it('stops instead of writing a corrupt archive when a file is not the recorded size', async () => {
    const plan = planZip([{ name: 'a.jpg', size: 10, modifiedAt: new Date() }], 'UTC');
    const consume = async () => {
      for await (const _chunk of zipStream(plan, () => Promise.resolve(Readable.from([Buffer.alloc(9)])))) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow('a.jpg is shorter than recorded');
  });

  it('keeps names unique within the archive, ignoring case', () => {
    expect(uniqueNames(['a/IMG.jpg', 'a/img.jpg', 'b/IMG.jpg', 'a/IMG.jpg', 'a/README', 'a/README'])).toEqual(
      ['a/IMG.jpg', 'a/img (2).jpg', 'b/IMG.jpg', 'a/IMG (3).jpg', 'a/README', 'a/README (2)'],
    );
  });

  it('writes DOS times on the owner’s wall clock', () => {
    const { date, time } = dosDateTime(new Date('2026-11-22T03:54:44Z'), 'Asia/Kolkata');
    expect([date >> 9, (date >> 5) & 15, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2]).toEqual([
      46, 11, 22, 9, 24, 44,
    ]);
  });
});
