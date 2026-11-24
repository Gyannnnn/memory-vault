import {
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256Stream } from '@memory-vault/media';
import {
  formatBytes,
  formatCount,
  formatDuration,
  type PendingOriginal,
  type SourceId,
} from '@memory-vault/shared';
import { apiClient } from '../auth/credentials';
import { config, manifestPath } from '../config';
import { Manifest } from '../manifest/manifest';
import { LiveView, progressLine, RateMeter } from '../ui/live';
import { interruptSignal } from '../ui/pool';
import { PHONE_ROOT, pickDevice, runAdb } from './adb';
import { freeBytes, HEADROOM_BYTES, stagingRootFor } from './stage';

const POLL_MS = 5000;
/** A file the worker keeps failing on gets its copy removed after this long; its retries use S3. */
const GIVE_UP_AFTER_ERROR_MS = 15 * 60_000;
const STALL_WARNING_MS = 5 * 60_000;
const STATUS_BATCH = 1000;
const LOOKAHEAD = 200;

/**
 * The order the worker runs waiting files in: everything but videos first, then videos
 * (they wait at a lower priority), newest first within each.
 */
export function stagingOrder(items: PendingOriginal[]): PendingOriginal[] {
  const rank = (item: PendingOriginal) => (item.kind === 'video' ? 1 : 0);
  return [...items].sort(
    (a, b) => rank(a) - rank(b) || b.localAt.localeCompare(a.localAt) || b.assetId.localeCompare(a.assetId),
  );
}

/** Whether one more copy fits. With nothing staged anything fits, so a large video can go on its own. */
export function fitsWindow(stagedBytes: number, nextBytes: number, windowBytes: number): boolean {
  return stagedBytes === 0 || stagedBytes + nextBytes <= windowBytes;
}

/** Where a phone path is staged; null if the path would land outside the staging folder. */
export function stagingPath(root: string, phonePath: string): string | null {
  if (!phonePath || isAbsolute(phonePath) || phonePath.includes('\0')) return null;
  const target = resolve(root, phonePath);
  const inside = relative(root, target);
  return inside && !inside.startsWith('..') && !isAbsolute(inside) ? target : null;
}

interface StagedCopy {
  item: PendingOriginal;
  files: string[];
  erroredAt: number | null;
}

interface Outcome {
  assetId: string;
  path: string;
  reason: string;
}

async function sha256Of(path: string): Promise<string> {
  return sha256Stream(createReadStream(path));
}

/** Deletes a staged copy and the folders it leaves empty, never going above the staging root. */
function removeCopy(root: string, file: string): void {
  rmSync(file, { force: true });
  for (
    let folder = dirname(file);
    folder !== root && folder.startsWith(`${root}/`);
    folder = dirname(folder)
  ) {
    try {
      if (readdirSync(folder).length > 0) break;
      rmdirSync(folder);
    } catch {
      break;
    }
  }
}

/**
 * The copies this command made (file → asset), kept in the CLI's data folder so a later
 * run can remove copies whose file was processed in between. Copies made by anything
 * else (an upload in progress, for example) are never touched.
 */
class Ledger {
  private readonly entries: Map<string, string>;
  private dirty = false;

  constructor(private readonly path: string) {
    let saved: Record<string, string> = {};
    try {
      saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
    } catch {
      /* first run */
    }
    this.entries = new Map(Object.entries(saved));
  }

  get files(): [string, string][] {
    return [...this.entries];
  }

  add(file: string, assetId: string): void {
    this.entries.set(file, assetId);
    this.dirty = true;
  }

  delete(file: string): void {
    this.dirty = this.entries.delete(file) || this.dirty;
  }

  has(file: string): boolean {
    return this.entries.has(file);
  }

  save(): void {
    if (!this.dirty) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.entries)));
    renameSync(temporary, this.path);
    this.dirty = false;
  }
}

function filesUnder(folder: string): number {
  if (!existsSync(folder)) return 0;
  return readdirSync(folder, { withFileTypes: true }).reduce(
    (count, entry) =>
      count + (entry.isDirectory() ? filesUnder(`${folder}/${entry.name}`) : entry.isFile() ? 1 : 0),
    0,
  );
}

/**
 * Copies the phone files the worker still has to process into the staging folder, at the
 * path each waiting job already looks at, so the worker reads them locally instead of
 * downloading them from S3. The phone is only read (`adb pull`); every copy must match
 * the SHA-256 the server holds; copies are deleted once their file is processed.
 */
export async function stagePending(
  sourceId: SourceId,
  options: { serial?: string; windowBytes: number },
): Promise<void> {
  const manifest = new Manifest(manifestPath());
  const source = (() => {
    try {
      return manifest.getSource(sourceId);
    } finally {
      manifest.close();
    }
  })();
  if (!source) throw new Error(`unknown source ${sourceId}; run \`vault phone inventory\` first`);
  if (!source.deviceSerial)
    throw new Error(`no device recorded for ${sourceId}; run \`vault phone inventory\``);
  if (options.serial && options.serial !== source.deviceSerial)
    throw new Error(`${sourceId} was imported from device ${source.deviceSerial}, not ${options.serial}`);
  // Only the phone this source was imported from: its serial must be connected.
  const device = await pickDevice(source.deviceSerial);
  const api = apiClient();
  const root = stagingRootFor(sourceId);

  const items: PendingOriginal[] = [];
  let total = 0;
  let totalBytes = 0;
  let cursor: string | undefined;
  do {
    const page = await api.pendingOriginals({ source: sourceId, cursor, limit: 2000 });
    if (page.total !== null) total = page.total;
    if (page.totalBytes !== null) totalBytes = page.totalBytes;
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  const queue = stagingOrder(items);
  mkdirSync(root, { recursive: true });
  const ledger = new Ledger(join(config.dataDir, `stage-pending-${sourceId.replace(':', '-')}.json`));
  const waiting = new Set(items.map((item) => item.assetId));
  let cleanedEarlier = 0;
  for (const [file, assetId] of ledger.files) {
    if (waiting.has(assetId)) continue;
    // Processed (or removed) since an earlier run left this copy.
    if (file.startsWith(`${root}/`) && existsSync(file)) {
      removeCopy(root, file);
      cleanedEarlier += 1;
    }
    ledger.delete(file);
  }
  ledger.save();
  if (items.length === 0) {
    console.log(
      `Nothing to do: every file from ${sourceId} has been processed.${cleanedEarlier ? ` Removed ${formatCount(cleanedEarlier)} copies left by an earlier run.` : ''}`,
    );
    return;
  }
  console.log(
    `${device.model ?? 'Phone'} (${device.serial}) · ${formatCount(total)} files waiting for the worker (${formatBytes(totalBytes)})`,
  );
  console.log(`Copies go to ${root} and are deleted once each file is processed. The phone is only read.\n`);

  const staged = new Map<string, StagedCopy>();
  const skip = new Set<string>();
  const missing: Outcome[] = [];
  const mismatched: Outcome[] = [];
  const unsafe: Outcome[] = [];
  const failed: Outcome[] = [];
  const counts = { copied: 0, reused: 0, processed: 0, alreadyProcessed: 0, gone: 0 };
  const meter = new RateMeter();
  let handledBytes = 0;
  let stagedBytes = 0;
  let next = 0;
  let lastPoll = 0;
  let lastProgressAt = Date.now();
  let current: string | null = null;
  let apiProblem: string | null = null;

  const view = new LiveView();
  const interrupt = interruptSignal(() =>
    view.finish(['Stopping after the current file… (press Ctrl+C again to quit at once)']),
  );
  const { signal } = interrupt;

  const release = (copy: StagedCopy) => {
    for (const file of copy.files) {
      removeCopy(root, file);
      ledger.delete(file);
    }
    staged.delete(copy.item.assetId);
    stagedBytes -= copy.item.sizeBytes;
  };

  const poll = async () => {
    const upcoming = queue.slice(next, next + LOOKAHEAD).map((item) => item.assetId);
    const ids = [...staged.keys(), ...upcoming];
    const known = new Map<string, { done: boolean; error: string | null }>();
    for (let start = 0; start < ids.length; start += STATUS_BATCH) {
      const { items: batch } = await api.processingStatus(ids.slice(start, start + STATUS_BATCH));
      for (const status of batch) known.set(status.id, status);
    }
    const now = Date.now();
    for (const copy of [...staged.values()]) {
      const status = known.get(copy.item.assetId);
      if (!status) {
        // Deleted from the library meanwhile: nothing will read the copy.
        counts.gone += 1;
        release(copy);
      } else if (status.done) {
        counts.processed += 1;
        lastProgressAt = now;
        release(copy);
      } else if (status.error) {
        copy.erroredAt ??= now;
        if (now - copy.erroredAt >= GIVE_UP_AFTER_ERROR_MS) {
          failed.push({ assetId: copy.item.assetId, path: copy.item.paths[0]!, reason: status.error });
          release(copy);
        }
      }
    }
    for (const id of upcoming) {
      const status = known.get(id);
      if (!status || status.done) skip.add(id);
    }
    ledger.save();
  };

  /** Stages one file; true when a verified copy is in place for the worker. */
  const stageOne = async (item: PendingOriginal): Promise<boolean> => {
    const targets = item.paths.map((path) => ({ path, file: stagingPath(root, path) }));
    const usable = targets.filter((target): target is { path: string; file: string } => target.file !== null);
    if (usable.length === 0) {
      unsafe.push({ assetId: item.assetId, path: item.paths[0]!, reason: 'path leaves the staging folder' });
      return false;
    }
    const free = freeBytes(root);
    if (free - item.sizeBytes < HEADROOM_BYTES)
      throw new Error(`not enough disk space to stage more (${formatBytes(free)} free)`);

    // Reuse a verified copy from an earlier run; otherwise pull from the first path the phone still has.
    let primary: string | null = null;
    for (const target of usable) {
      if (existsSync(target.file) && statSync(target.file).size === item.sizeBytes) {
        if ((await sha256Of(target.file)) === item.sha256) {
          primary = target.file;
          counts.reused += 1;
          break;
        }
      }
    }
    if (!primary) {
      let reasons: string[] = [];
      for (const target of usable) {
        mkdirSync(dirname(target.file), { recursive: true });
        current = target.path;
        // Not tied to Ctrl+C: the current file finishes, so no half-written copy is left behind.
        const result = await runAdb({
          op: 'pull',
          serial: device.serial,
          remote: `${PHONE_ROOT}/${target.path}`,
          local: target.file,
        }).catch((error: unknown) => {
          removeCopy(root, target.file);
          throw error;
        });
        if (result.code !== 0) {
          removeCopy(root, target.file);
          const error = result.stderr.trim();
          reasons.push(/no such file/i.test(error) ? 'not on the phone' : error || `adb exit ${result.code}`);
          continue;
        }
        if ((await sha256Of(target.file)) !== item.sha256) {
          removeCopy(root, target.file);
          mismatched.push({
            assetId: item.assetId,
            path: target.path,
            reason: 'the copy differs from the uploaded file',
          });
          return false;
        }
        primary = target.file;
        counts.copied += 1;
        reasons = [];
        break;
      }
      if (!primary) {
        missing.push({
          assetId: item.assetId,
          path: usable[0]!.path,
          reason: reasons.at(-1) ?? 'not on the phone',
        });
        return false;
      }
    }

    // The waiting job may have recorded any of the file's paths: put the copy at each (hard links, no extra space).
    const files = [primary];
    for (const target of usable) {
      if (target.file === primary) continue;
      mkdirSync(dirname(target.file), { recursive: true });
      rmSync(target.file, { force: true });
      linkSync(primary, target.file);
      files.push(target.file);
    }
    for (const file of files) ledger.add(file, item.assetId);
    staged.set(item.assetId, { item, files, erroredAt: null });
    stagedBytes += item.sizeBytes;
    return true;
  };

  const render = () => {
    const done = counts.processed + counts.alreadyProcessed;
    const lines = [
      progressLine('Copying  ', handledBytes, totalBytes, meter),
      `Processed ${formatCount(done)} of ${formatCount(items.length)} · waiting in staging: ${formatCount(staged.size)} (${formatBytes(stagedBytes)})`,
    ];
    const problems = missing.length + mismatched.length + unsafe.length + failed.length;
    if (problems > 0)
      lines.push(
        `Left to S3: ${formatCount(missing.length)} missing on the phone, ${formatCount(mismatched.length)} different, ${formatCount(failed.length)} failing`,
      );
    if (staged.size > 0 && Date.now() - lastProgressAt > STALL_WARNING_MS)
      lines.push('Nothing has finished processing for 5 minutes. Is the worker running? (docker compose ps)');
    if (apiProblem)
      lines.push(`Can't reach the API (${apiProblem}); retrying. Copies stay until it answers.`);
    if (current && next < queue.length) lines.push(`  ${current}`);
    view.render(lines);
  };

  try {
    while (!signal.aborted && (next < queue.length || staged.size > 0)) {
      if (Date.now() - lastPoll >= POLL_MS) {
        lastPoll = Date.now();
        try {
          await poll();
          apiProblem = null;
        } catch (error) {
          apiProblem = error instanceof Error ? error.message : String(error);
        }
      }
      if (next < queue.length && fitsWindow(stagedBytes, queue[next]!.sizeBytes, options.windowBytes)) {
        const item = queue[next++]!;
        if (skip.has(item.assetId)) {
          counts.alreadyProcessed += 1;
          for (const path of item.paths) {
            const file = stagingPath(root, path);
            if (file && ledger.has(file)) {
              removeCopy(root, file);
              ledger.delete(file);
            }
          }
        } else if (await stageOne(item)) {
          meter.add(item.sizeBytes);
        }
        handledBytes += item.sizeBytes;
      } else {
        current = null;
        await sleep(1000, undefined, { signal }).catch(() => undefined);
      }
      render();
    }
  } finally {
    ledger.save();
    interrupt.dispose();
  }

  const leftInStaging = filesUnder(root);
  const lines = [
    signal.aborted ? 'Stopped.' : 'Done.',
    `  Copied from the phone:        ${formatCount(counts.copied)} files${counts.reused ? ` (+${formatCount(counts.reused)} reused from an earlier run)` : ''}`,
    `  Processed from local copies:  ${formatCount(counts.processed)}`,
    `  Processed before a copy was needed: ${formatCount(counts.alreadyProcessed)}`,
    ...(cleanedEarlier ? [`  Removed copies left by an earlier run: ${formatCount(cleanedEarlier)}`] : []),
    `  Time: ${formatDuration(meter.elapsedSeconds())}`,
  ];
  const sections: [string, Outcome[]][] = [
    ['Not on the phone any more', missing],
    ['Different on the phone than in the vault', mismatched],
    ['Skipped: unsafe path', unsafe],
    ['Still failing in the worker', failed],
  ];
  for (const [title, rows] of sections) {
    if (rows.length === 0) continue;
    lines.push(
      `  ${title}: ${formatCount(rows.length)} (the worker downloads these from S3; nothing is lost)`,
    );
    for (const row of rows.slice(0, 10)) lines.push(`    ${row.path} — ${row.reason}`);
    if (rows.length > 10) lines.push(`    … and ${formatCount(rows.length - 10)} more`);
  }
  if (sections.some(([, rows]) => rows.length > 0)) {
    mkdirSync(config.reportsDir, { recursive: true });
    const file = join(
      config.reportsDir,
      `stage-pending-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`,
    );
    writeFileSync(
      file,
      sections
        .filter(([, rows]) => rows.length > 0)
        .map(([title, rows]) =>
          [
            `${title} (${rows.length}):`,
            ...rows.map((row) => `${row.assetId}\t${row.path}\t${row.reason}`),
          ].join('\n'),
        )
        .join('\n\n') + '\n',
    );
    lines.push(`  Full list: ${file}`);
  }
  if (counts.gone > 0) lines.push(`  Removed from the library while staged: ${formatCount(counts.gone)}`);
  lines.push(
    leftInStaging === 0
      ? `  Staging folder is empty: ${root}`
      : `  ${formatCount(leftInStaging)} verified copies are still in ${root} for the worker; run this again to finish and clean up.`,
  );
  view.finish(lines);
}
