import { createReadStream, type ReadStream } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type SourceEntry =
  | {
      type: 'file';
      relativePath: string;
      size: number;
      mtimeMs: number;
      mtimeNs: bigint;
      ino: bigint;
    }
  | { type: 'symlink' | 'other'; relativePath: string }
  | { type: 'error'; relativePath: string; error: string };

/**
 * Read-only view of a source folder. It deliberately exposes no way to write,
 * rename, delete or change timestamps, and refuses paths that escape the root.
 */
export interface SourceReader {
  readonly root: string;
  walk(): AsyncGenerator<SourceEntry>;
  stat(relativePath: string): Promise<{ size: number; mtimeMs: number; mtimeNs: bigint; ino: bigint }>;
  openRead(relativePath: string, options?: { start?: number; end?: number }): ReadStream;
  readRange(relativePath: string, start: number, length: number): Promise<Buffer>;
  absolutePath(relativePath: string): string;
}

const READ_CHUNK = 4 * 1024 * 1024;

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

export function createSourceReader(rootPath: string): SourceReader {
  const root = resolve(rootPath);

  function absolutePath(relativePath: string): string {
    if (isAbsolute(relativePath)) throw new Error(`expected a path relative to the source: ${relativePath}`);
    const absolute = resolve(root, relativePath);
    const back = relative(root, absolute);
    if (back.startsWith('..') || isAbsolute(back)) {
      throw new Error(`path escapes the source root: ${relativePath}`);
    }
    return absolute;
  }

  async function* walk(): AsyncGenerator<SourceEntry> {
    const pending: string[] = [''];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      let names: { name: string; isDirectory: boolean }[];
      try {
        const handle = await opendir(join(root, directory));
        names = [];
        for await (const dirent of handle) {
          names.push({ name: dirent.name, isDirectory: dirent.isDirectory() });
        }
      } catch (error) {
        yield { type: 'error', relativePath: toPosix(directory) || '.', error: String(error) };
        continue;
      }
      names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      const subdirectories: string[] = [];
      for (const { name, isDirectory } of names) {
        const relativePath = directory ? join(directory, name) : name;
        if (isDirectory) {
          subdirectories.push(relativePath);
          continue;
        }
        try {
          const stats = await lstat(join(root, relativePath), { bigint: true });
          if (stats.isFile()) {
            yield {
              type: 'file',
              relativePath: toPosix(relativePath),
              size: Number(stats.size),
              mtimeMs: Number(stats.mtimeNs / 1_000_000n),
              mtimeNs: stats.mtimeNs,
              ino: stats.ino,
            };
          } else {
            yield { type: stats.isSymbolicLink() ? 'symlink' : 'other', relativePath: toPosix(relativePath) };
          }
        } catch (error) {
          yield { type: 'error', relativePath: toPosix(relativePath), error: String(error) };
        }
      }
      pending.push(...subdirectories.reverse());
    }
  }

  async function stat(relativePath: string) {
    const stats = await lstat(absolutePath(relativePath), { bigint: true });
    return {
      size: Number(stats.size),
      mtimeMs: Number(stats.mtimeNs / 1_000_000n),
      mtimeNs: stats.mtimeNs,
      ino: stats.ino,
    };
  }

  function openRead(relativePath: string, options: { start?: number; end?: number } = {}): ReadStream {
    return createReadStream(absolutePath(relativePath), {
      flags: 'r',
      highWaterMark: READ_CHUNK,
      ...options,
    });
  }

  async function readRange(relativePath: string, start: number, length: number): Promise<Buffer> {
    const handle = await open(absolutePath(relativePath), 'r');
    try {
      const buffer = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled);
        if (bytesRead === 0) throw new Error(`unexpected end of file reading ${relativePath}`);
        filled += bytesRead;
      }
      return buffer;
    } finally {
      await handle.close();
    }
  }

  return Object.freeze({ root, walk, stat, openRead, readRange, absolutePath });
}
