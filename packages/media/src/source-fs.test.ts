import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sha256Hex, sha256Stream } from './hash';
import { createSourceReader, type SourceEntry } from './source-fs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vault-source-'));
  mkdirSync(join(root, 'Camera/Cshot'), { recursive: true });
  mkdirSync(join(root, 'WhatsApp Images/Private'), { recursive: true });
  writeFileSync(join(root, 'Camera/b.jpg'), 'bbb');
  writeFileSync(join(root, 'Camera/a.jpg'), 'aaaa');
  writeFileSync(join(root, 'Camera/.temp-1.mp4'), 'temp');
  writeFileSync(join(root, 'Camera/Cshot/burst.jpg'), 'burst');
  writeFileSync(join(root, 'WhatsApp Images/Private/.nomedia'), '');
  writeFileSync(join(root, 'root.mp4'), 'video');
  symlinkSync(join(root, 'root.mp4'), join(root, 'link.mp4'));
  utimesSync(join(root, 'root.mp4'), new Date('2024-01-02T03:04:05Z'), new Date('2024-01-02T03:04:05Z'));
  return root;
}

async function collect(walk: AsyncGenerator<SourceEntry>) {
  const entries: SourceEntry[] = [];
  for await (const entry of walk) entries.push(entry);
  return entries;
}

describe('createSourceReader', () => {
  it('walks every file, including hidden ones, in a stable order without following symlinks', async () => {
    const reader = createSourceReader(fixture());
    const entries = await collect(reader.walk());
    expect(entries.map((entry) => `${entry.type}:${entry.relativePath}`)).toEqual([
      'symlink:link.mp4',
      'file:root.mp4',
      'file:Camera/.temp-1.mp4',
      'file:Camera/a.jpg',
      'file:Camera/b.jpg',
      'file:Camera/Cshot/burst.jpg',
      'file:WhatsApp Images/Private/.nomedia',
    ]);
    const video = entries.find((entry) => entry.relativePath === 'root.mp4');
    expect(video).toMatchObject({ type: 'file', size: 5, mtimeMs: Date.parse('2024-01-02T03:04:05Z') });
  });

  it('streams file contents for hashing', async () => {
    const reader = createSourceReader(fixture());
    expect(await sha256Stream(reader.openRead('Camera/a.jpg'))).toBe(sha256Hex('aaaa'));
  });

  it('reads byte ranges', async () => {
    const reader = createSourceReader(fixture());
    expect((await reader.readRange('Camera/a.jpg', 1, 2)).toString()).toBe('aa');
    await expect(reader.readRange('Camera/a.jpg', 3, 5)).rejects.toThrow(/end of file/);
  });

  it('refuses paths outside the root', () => {
    const reader = createSourceReader(fixture());
    expect(() => reader.openRead('../etc/passwd')).toThrow(/escapes/);
    expect(() => reader.openRead('/etc/passwd')).toThrow(/relative/);
    expect(() => reader.absolutePath('Camera/../../x')).toThrow(/escapes/);
  });

  it('exposes only read operations', () => {
    const reader = createSourceReader(fixture());
    expect(Object.keys(reader).sort()).toEqual([
      'absolutePath',
      'openRead',
      'readRange',
      'root',
      'stat',
      'walk',
    ]);
    expect(Object.isFrozen(reader)).toBe(true);
  });

  it('contains no filesystem write calls in its implementation', () => {
    const source = readFileSync(fileURLToPath(new URL('./source-fs.ts', import.meta.url)), 'utf8');
    const forbidden =
      /\b(writeFile|appendFile|createWriteStream|unlink|rmdir|rm|rename|mkdir|copyFile|cp|chmod|chown|utimes|lutimes|futimes|truncate|symlink|link)\s*\(/;
    expect(source).not.toMatch(forbidden);
    expect(source).not.toMatch(/flags:\s*'(?!r')/);
    const opens = source.split('\n').filter((line) => /\bopen\(/.test(line));
    expect(opens.length).toBeGreaterThan(0);
    expect(opens.every((line) => line.includes("'r')"))).toBe(true);
  });
});
