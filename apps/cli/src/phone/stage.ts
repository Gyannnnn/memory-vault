import { existsSync, mkdirSync, rmSync, statfsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createSourceReader, sha256Stream } from '@memory-vault/media';
import { formatBytes } from '@memory-vault/shared';
import { config } from '../config';
import type { FileRow, Manifest, SourceRow } from '../manifest/manifest';
import type { StagedFile } from '../upload/engine';
import { parseSha256Line, PHONE_ROOT, runAdb } from './adb';

const HEADROOM_BYTES = 10 * 1024 ** 3;

export const stagingRootFor = (sourceId: string) => join(config.stagingDir, sourceId.replace(':', '-'));

/**
 * Copies one phone file into the staging folder (same relative path, original
 * timestamps kept by `adb pull -a`) and proves the copy matches the SHA-256
 * computed on the phone. Staged copies are ours to delete; the phone is never touched.
 */
export function createPhoneStager(manifest: Manifest, options: { keepStaging: boolean }) {
  return async function stagePhoneFile(
    source: SourceRow,
    row: FileRow,
    signal: AbortSignal,
  ): Promise<StagedFile> {
    if (!source.deviceSerial)
      throw new Error(`no device recorded for ${source.id}; run \`vault phone inventory\``);
    const root = stagingRootFor(source.id);
    const destination = join(root, row.path);
    mkdirSync(dirname(destination), { recursive: true });
    const reader = createSourceReader(root);

    const free = (() => {
      const stats = statfsSync(dirname(destination));
      return stats.bavail * stats.bsize;
    })();
    if (free - (row.size ?? 0) < HEADROOM_BYTES) {
      throw new Error(`not enough disk space to stage ${row.path} (${formatBytes(free)} free)`);
    }

    // The copy is only trusted if it matches a SHA-256 computed on the phone itself.
    let expected = row.sha256;
    if (!expected) {
      const remote = `${PHONE_ROOT}/${row.path}`;
      const hashed = await runAdb({ op: 'sha256', serial: source.deviceSerial, paths: [remote] }, { signal });
      expected =
        hashed.stdout
          .split('\n')
          .map(parseSha256Line)
          .find((line) => line?.path === remote)?.sha256 ?? null;
      if (!expected)
        throw new Error(`could not hash ${row.path} on the phone: ${hashed.stderr.trim() || 'no output'}`);
      manifest.setHash(source.id, row.path, expected, row.size ?? 0, row.mtimeNs);
    }
    const alreadyStaged =
      existsSync(destination) && (await reader.stat(row.path)).size === row.size
        ? (await sha256Stream(reader.openRead(row.path))) === expected
        : false;
    if (!alreadyStaged) {
      const result = await runAdb(
        { op: 'pull', serial: source.deviceSerial, remote: `${PHONE_ROOT}/${row.path}`, local: destination },
        { signal },
      );
      if (result.code !== 0)
        throw new Error(`adb pull failed: ${result.stderr.trim() || `exit ${result.code}`}`);
      const copied = await sha256Stream(reader.openRead(row.path));
      if (copied !== expected) {
        rmSync(destination, { force: true });
        throw new Error('the copy pulled from the phone does not match the SHA-256 computed on the phone');
      }
    }
    manifest.setStagedPath(source.id, row.path, destination);

    return {
      reader,
      relativePath: row.path,
      release: (succeeded) => {
        if (succeeded && !options.keepStaging) {
          rmSync(destination, { force: true });
          manifest.setStagedPath(source.id, row.path, null);
        }
        return Promise.resolve();
      },
    };
  };
}
