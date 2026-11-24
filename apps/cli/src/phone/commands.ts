import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidArgumentError, type Command } from 'commander';
import {
  formatBytes,
  formatCount,
  formatDuration,
  sourceIdSchema,
  type SourceId,
} from '@memory-vault/shared';
import { config, manifestPath } from '../config';
import { describeEntry } from '../commands/scan';
import { Manifest, type EntryUpsert, type FileRow } from '../manifest/manifest';
import { LiveView, progressLine, RateMeter } from '../ui/live';
import { interruptSignal } from '../ui/pool';
import {
  parseDevices,
  parseDf,
  parseSha256Line,
  parseStatLine,
  PHONE_ROOT,
  runAdb,
  type AdbDevice,
  type PhoneFileStat,
} from './adb';

export const DEFAULT_EXCLUDED = ['Android/data', 'Android/obb'];

function parseSourceId(value: string): SourceId {
  const parsed = sourceIdSchema.safeParse(value);
  if (!parsed.success || !value.startsWith('phone:')) {
    throw new InvalidArgumentError('expected a phone source id, e.g. phone:s21fe');
  }
  return parsed.data;
}

const relativeToRoot = (path: string) => path.slice(PHONE_ROOT.length + 1);
const isExcludedByDefault = (path: string) =>
  DEFAULT_EXCLUDED.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));

export async function pickDevice(serial?: string): Promise<AdbDevice> {
  const { stdout } = await runAdb({ op: 'devices' });
  const devices = parseDevices(stdout);
  const usable = devices.filter((device) => device.state === 'device');
  if (serial) {
    const match = devices.find((device) => device.serial === serial);
    if (!match) throw new Error(`device ${serial} is not connected`);
    if (match.state !== 'device')
      throw new Error(`device ${serial} is ${match.state}; unlock it and accept the prompt`);
    return match;
  }
  if (usable.length === 1) return usable[0]!;
  if (usable.length > 1)
    throw new Error(
      `several devices connected; pick one with --serial (${usable.map((d) => d.serial).join(', ')})`,
    );
  if (devices.some((device) => device.state === 'unauthorized')) {
    throw new Error(
      'the phone has not authorised this computer yet: unlock it and tap Allow on the USB debugging prompt',
    );
  }
  throw new Error(
    'no phone found over adb. Turn on USB debugging (docs/setup/phase-0-aws-setup.md §0.2), reconnect the cable, then run `vault phone devices`.',
  );
}

/** Groups a phone path into the folder shown in the inventory, with a little more detail where it matters. */
export function displayFolder(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return '(top-level files)';
  const [first, second, third] = parts;
  if (first === 'Android' && second === 'media' && third && parts.length > 3) return `Android/media/${third}`;
  if (first === 'Android') return `Android/${second}`;
  if ((first === 'DCIM' || first === 'Pictures' || first === 'Movies') && parts.length > 2)
    return `${first}/${second}`;
  return first!;
}

interface FolderRow {
  folder: string;
  files: number;
  bytes: number;
  selectedFiles: number;
  selectedBytes: number;
  reviewFiles: number;
  hashed: number;
}

export function folderSummary(files: FileRow[]): FolderRow[] {
  const rows = new Map<string, FolderRow>();
  for (const file of files) {
    if (file.entryType !== 'file' || file.status === 'missing') continue;
    const folder = displayFolder(file.path);
    const row = rows.get(folder) ?? {
      folder,
      files: 0,
      bytes: 0,
      selectedFiles: 0,
      selectedBytes: 0,
      reviewFiles: 0,
      hashed: 0,
    };
    row.files += 1;
    row.bytes += file.size ?? 0;
    if (file.selected) {
      row.selectedFiles += 1;
      row.selectedBytes += file.size ?? 0;
      if (file.route === 'review') row.reviewFiles += 1;
      if (file.sha256) row.hashed += 1;
    }
    rows.set(folder, row);
  }
  return [...rows.values()].sort((a, b) => b.bytes - a.bytes);
}

function renderFolderTable(rows: FolderRow[]): string[] {
  const header = `${'Folder'.padEnd(48)} ${'Files'.padStart(8)} ${'Size'.padStart(10)}  Import`;
  return [
    header,
    '-'.repeat(header.length + 12),
    ...rows.map((row) => {
      const state =
        row.selectedFiles === 0
          ? 'excluded'
          : row.selectedFiles < row.files
            ? `partly (${formatCount(row.selectedFiles)})`
            : row.reviewFiles === row.selectedFiles
              ? 'yes → junk review'
              : row.reviewFiles > 0
                ? `yes (${formatCount(row.reviewFiles)} to review)`
                : 'yes';
      return `${row.folder.slice(0, 48).padEnd(48)} ${formatCount(row.files).padStart(8)} ${formatBytes(row.bytes).padStart(10)}  ${state}`;
    }),
  ];
}

function writeInventoryReport(
  sourceId: SourceId,
  device: AdbDevice & { androidVersion?: string },
  storage: ReturnType<typeof parseDf>,
  files: FileRow[],
): string {
  mkdirSync(config.reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rows = folderSummary(files);
  const problems = files.filter((file) => file.entryType !== 'file');
  const markdown = [
    `# Phone inventory — ${sourceId}`,
    '',
    `Device ${device.model ?? ''} (${device.serial}), Android ${device.androidVersion ?? '?'}.`,
    storage
      ? `Storage: ${formatBytes(storage.usedBytes)} used of ${formatBytes(storage.totalBytes)} (${formatBytes(storage.freeBytes)} free; includes apps).`
      : '',
    '',
    '| Folder | Files | Size | Selected files | Selected size | To review | Hashed |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (row) =>
        `| \`${row.folder}\` | ${formatCount(row.files)} | ${formatBytes(row.bytes)} | ${formatCount(row.selectedFiles)} | ${formatBytes(row.selectedBytes)} | ${formatCount(row.reviewFiles)} | ${formatCount(row.hashed)} |`,
    ),
    '',
    '## Not regular files',
    '',
    problems.length === 0
      ? 'None.'
      : problems
          .map((file) => `- ${file.entryType}: \`${file.path}\`${file.error ? ` — ${file.error}` : ''}`)
          .join('\n'),
    '',
  ].join('\n');
  const path = join(config.reportsDir, `phone-inventory-${stamp}.md`);
  writeFileSync(path, markdown);
  writeFileSync(
    path.replace(/\.md$/, '.json'),
    `${JSON.stringify({ sourceId, device, storage, folders: rows }, null, 2)}\n`,
  );
  return path;
}

async function inventory(sourceId: SourceId, serial?: string): Promise<void> {
  const device = await pickDevice(serial);
  const [model, android, df] = await Promise.all([
    runAdb({ op: 'getprop', serial: device.serial, property: 'ro.product.model' }),
    runAdb({ op: 'getprop', serial: device.serial, property: 'ro.build.version.release' }),
    runAdb({ op: 'df', serial: device.serial, path: PHONE_ROOT }),
  ]);
  const details = { ...device, model: model.stdout.trim(), androidVersion: android.stdout.trim() };
  const storage = parseDf(df.stdout);
  console.log(`Phone ${details.model} (${device.serial}), Android ${details.androidVersion}`);

  const manifest = new Manifest(manifestPath());
  const view = new LiveView();
  try {
    manifest.registerSource({ id: sourceId, kind: 'phone', root: PHONE_ROOT, deviceSerial: device.serial });
    const scanId = manifest.startScan(sourceId);
    let batch: EntryUpsert[] = [];
    const flush = () => {
      manifest.upsertEntries(sourceId, scanId, batch);
      batch = [];
    };

    // Two steps whose batch sizes we control: `find -exec … {} +` on the phone
    // silently drops whole batches once they exceed its argument limit.
    view.render(['Listing phone files…']);
    const listing = await runAdb({ op: 'list-paths', serial: device.serial, root: PHONE_ROOT });
    const lines = listing.stdout.split('\n').filter(Boolean);
    const paths = lines.filter((line) => line.startsWith(`${PHONE_ROOT}/`));
    const strayLines = lines.filter((line) => !line.startsWith(`${PHONE_ROOT}/`));

    const stats = new Map<string, PhoneFileStat>();
    const statErrors = new Map<string, string>();
    for (let index = 0; index < paths.length;) {
      const chunk: string[] = [];
      let length = 0;
      while (index < paths.length && chunk.length < 200 && length < 60_000) {
        chunk.push(paths[index]!);
        length += paths[index]!.length + 3;
        index += 1;
      }
      const result = await runAdb({ op: 'stat', serial: device.serial, paths: chunk });
      for (const line of result.stdout.split('\n')) {
        const stat = parseStatLine(line);
        if (stat) stats.set(stat.path, stat);
      }
      for (const line of result.stderr.split('\n').filter(Boolean)) {
        const path = /'([^']+)'/.exec(line)?.[1];
        if (path) statErrors.set(path, line.trim());
      }
      view.render([`Reading file details… ${formatCount(index)} / ${formatCount(paths.length)}`]);
    }

    for (const absolute of paths) {
      const path = relativeToRoot(absolute);
      const stat = stats.get(absolute);
      batch.push(
        stat
          ? {
              path,
              entryType: 'file',
              size: stat.size,
              mtimeMs: stat.mtimeSeconds * 1000,
              mtimeNs: (BigInt(stat.mtimeSeconds) * 1_000_000_000n).toString(),
              ...describeEntry(path),
              defaultSelected: !isExcludedByDefault(path),
            }
          : {
              path,
              entryType: 'file',
              error: statErrors.get(absolute) ?? 'the phone listed this file but returned no details for it',
              ...describeEntry(path),
              defaultSelected: !isExcludedByDefault(path),
            },
      );
      if (batch.length >= 1000) flush();
    }
    strayLines.forEach((line, index) =>
      batch.push({
        path: `(unparsed ${index + 1}) ${line.slice(0, 200)}`,
        entryType: 'error',
        error: 'a listing line that is not a path (a file name containing a line break?)',
      }),
    );
    for (const line of listing.stderr.split('\n').filter(Boolean)) {
      const match = /'([^']+)'[^']*$/.exec(line) ?? /^find: (\/[^:]+):/.exec(line);
      const path = match?.[1]?.startsWith(`${PHONE_ROOT}/`)
        ? relativeToRoot(match[1])
        : `(error) ${line.slice(0, 200)}`;
      batch.push({
        path,
        entryType: 'error',
        error: line.trim(),
        defaultSelected: !isExcludedByDefault(path),
      });
    }
    const listed = stats.size;
    const unreadable = paths.length - listed;
    const special = await runAdb({ op: 'list-special', serial: device.serial, root: PHONE_ROOT });
    for (const line of special.stdout.split('\n').filter((entry) => entry.startsWith(`${PHONE_ROOT}/`))) {
      const path = relativeToRoot(line);
      batch.push({
        path,
        entryType: 'other',
        ...describeEntry(path),
        defaultSelected: !isExcludedByDefault(path),
      });
    }
    flush();
    manifest.finishScan(sourceId, scanId);
    view.finish([
      `Listed ${formatCount(paths.length)} files on the phone` +
        (unreadable > 0 ? `; ${formatCount(unreadable)} could not be read and are listed as failed.` : '.'),
    ]);

    const files = manifest.files(sourceId);
    console.log(['', ...renderFolderTable(folderSummary(files)), ''].join('\n'));
    if (storage) {
      console.log(
        `Phone storage: ${formatBytes(storage.usedBytes)} used of ${formatBytes(storage.totalBytes)} (includes apps)`,
      );
    }
    const reportPath = writeInventoryReport(sourceId, details, storage, files);
    console.log(`Saved ${reportPath}`);
    console.log(
      `\nExcluded by default: ${DEFAULT_EXCLUDED.join(', ')} (app-private data). Change with \`vault phone select\`. Nothing has been copied from the phone.`,
    );
  } finally {
    manifest.close();
  }
}

async function hashOnPhone(sourceId: SourceId, serial?: string): Promise<void> {
  const manifest = new Manifest(manifestPath());
  const view = new LiveView();
  const { signal, dispose } = interruptSignal(() => view.finish(['Stopping… progress so far is saved.']));
  try {
    const source = manifest.getSource(sourceId);
    if (!source) throw new Error(`unknown source ${sourceId}; run \`vault phone inventory\` first`);
    const device = await pickDevice(serial ?? source.deviceSerial ?? undefined);
    const pending = manifest.filesNeedingHash(sourceId);
    const total = pending.reduce((sum, file) => sum + (file.size ?? 0), 0);
    const meter = new RateMeter();
    let done = 0;
    let failed = 0;
    console.log(
      `Hashing ${formatCount(pending.length)} files (${formatBytes(total)}) on the phone — nothing is copied.`,
    );
    const timer = setInterval(
      () =>
        view.render([
          progressLine('Hashing on phone', meter.total, total, meter),
          `        ${formatCount(done)} / ${formatCount(pending.length)} files${failed ? `, ${failed} failed` : ''}`,
        ]),
      500,
    );
    try {
      let index = 0;
      while (index < pending.length && !signal.aborted) {
        const batch: FileRow[] = [];
        let batchBytes = 0;
        let commandLength = 0;
        while (
          index < pending.length &&
          batch.length < 200 &&
          batchBytes < 2 * 1024 ** 3 &&
          commandLength < 60_000
        ) {
          const file = pending[index]!;
          batch.push(file);
          batchBytes += file.size ?? 0;
          commandLength += file.path.length + PHONE_ROOT.length + 4;
          index += 1;
        }
        const byPath = new Map(batch.map((file) => [`${PHONE_ROOT}/${file.path}`, file]));
        const seen = new Set<string>();
        const result = await runAdb(
          { op: 'sha256', serial: device.serial, paths: [...byPath.keys()] },
          {
            signal,
            onStdoutLine: (line) => {
              const parsed = parseSha256Line(line);
              const file = parsed && byPath.get(parsed.path);
              if (!parsed || !file) return;
              seen.add(parsed.path);
              manifest.setHash(sourceId, file.path, parsed.sha256, file.size ?? 0, file.mtimeNs);
              meter.add(file.size ?? 0);
              done += 1;
            },
          },
        ).catch((error: unknown) => {
          if (signal.aborted) return null;
          throw error;
        });
        if (!result) break;
        for (const [path, file] of byPath) {
          if (seen.has(path)) continue;
          failed += 1;
          const reason = result.stderr.split('\n').find((line) => line.includes(path)) ?? 'no hash returned';
          manifest.setError(sourceId, file.path, reason.trim());
        }
      }
    } finally {
      clearInterval(timer);
    }
    view.finish([
      signal.aborted
        ? `Paused after ${formatCount(done)} files. Re-run to continue.`
        : `Hashed ${formatCount(done)} files on the phone in ${formatDuration(meter.elapsedSeconds())}${failed ? `; ${failed} could not be read (see report)` : ''}.`,
    ]);
    if (signal.aborted) process.exitCode = 130;
  } finally {
    dispose();
    manifest.close();
  }
}

function select(sourceId: SourceId, include: string[], exclude: string[]): void {
  const manifest = new Manifest(manifestPath());
  try {
    if (!manifest.getSource(sourceId))
      throw new Error(`unknown source ${sourceId}; run \`vault phone inventory\` first`);
    for (const prefix of include)
      console.log(`include ${prefix}: ${manifest.setSelected(sourceId, prefix, true)} files`);
    for (const prefix of exclude)
      console.log(`exclude ${prefix}: ${manifest.setSelected(sourceId, prefix, false)} files`);
    console.log(['', ...renderFolderTable(folderSummary(manifest.files(sourceId)))].join('\n'));
  } finally {
    manifest.close();
  }
}

export function registerPhoneCommands(program: Command): void {
  const phone = program.command('phone').description('Import from an Android phone over adb (read-only)');
  const collect = (value: string, previous: string[]) => [...previous, value.replace(/^\/+|\/+$/g, '')];

  phone
    .command('devices')
    .description('Check that the phone is connected and authorised')
    .action(async () => {
      const device = await pickDevice();
      console.log(`Connected: ${device.model ?? 'phone'} (${device.serial})`);
    });

  phone
    .command('inventory')
    .description('List every file on the phone with sizes; nothing is copied')
    .requiredOption('-s, --source <id>', 'source id, e.g. phone:s21fe', parseSourceId)
    .option('--serial <serial>', 'device serial when several are connected')
    .action((options: { source: SourceId; serial?: string }) => inventory(options.source, options.serial));

  phone
    .command('select')
    .description('Include or exclude phone folders from the import')
    .requiredOption('-s, --source <id>', 'source id, e.g. phone:s21fe', parseSourceId)
    .option('--include <folder>', 'folder to include (repeatable)', collect, [])
    .option('--exclude <folder>', 'folder to exclude (repeatable)', collect, [])
    .action((options: { source: SourceId; include: string[]; exclude: string[] }) =>
      select(options.source, options.include, options.exclude),
    );

  phone
    .command('hash')
    .description('Compute SHA-256 of selected files on the phone itself, so only new files get copied')
    .requiredOption('-s, --source <id>', 'source id, e.g. phone:s21fe', parseSourceId)
    .option('--serial <serial>', 'device serial when several are connected')
    .action((options: { source: SourceId; serial?: string }) => hashOnPhone(options.source, options.serial));
}
