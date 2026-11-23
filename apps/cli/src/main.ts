#!/usr/bin/env node
import { existsSync, statfsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { sourceIdSchema, type SourceId } from '@memory-vault/shared';
import { config, manifestPath } from './config';
import { Manifest } from './manifest/manifest';
import { scanLocalSource } from './commands/scan';
import { buildDryRunReport, DEFAULT_SPEEDS_MBPS, type DryRunReport } from './report/dry-run';
import { printDryRunSummary, writeDryRunReport } from './report/render-dry-run';
import { registerPhoneCommands } from './phone/commands';

function parseSourceId(value: string): SourceId {
  const parsed = sourceIdSchema.safeParse(value);
  if (!parsed.success) throw new InvalidArgumentError(parsed.error.issues[0]?.message ?? 'invalid source id');
  return parsed.data;
}

function parseSpeeds(value: string): number[] {
  const speeds = value.split(',').map(Number);
  if (speeds.some((speed) => !Number.isFinite(speed) || speed <= 0)) {
    throw new InvalidArgumentError('expected comma-separated Mbps values, e.g. 20,50,100');
  }
  return speeds;
}

export function openManifest(): Manifest {
  return new Manifest(manifestPath());
}

const STAGING_HEADROOM = 15 * 1024 ** 3;
const MAX_BATCH = 40 * 1024 ** 3;

function freeBytesAt(directory: string): number {
  let probe = directory;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const stats = statfsSync(probe);
  return stats.bavail * stats.bsize;
}

export function stagingPlan(neededBytes: number): NonNullable<DryRunReport['staging']> {
  const freeBytes = freeBytesAt(config.stagingDir);
  const batchBytes = Math.max(0, Math.min(MAX_BATCH, freeBytes - STAGING_HEADROOM));
  return {
    directory: config.stagingDir,
    freeBytes,
    neededBytes,
    headroomBytes: STAGING_HEADROOM,
    batchBytes,
    batches: batchBytes > 0 ? Math.ceil(neededBytes / batchBytes) : Number.POSITIVE_INFINITY,
  };
}

export function reportDryRun(manifest: Manifest, sourceIds: SourceId[], speeds: number[]): void {
  const report = buildDryRunReport(manifest, sourceIds, speeds);
  const phoneSources = report.sources.filter((source) => source.kind === 'phone');
  if (phoneSources.length > 0)
    report.staging = stagingPlan(phoneSources.reduce((sum, s) => sum + s.newContent.bytes, 0));
  printDryRunSummary(report);
  const files = writeDryRunReport(report, config.reportsDir);
  console.log(`Full report:\n  ${files.markdown}\n  ${files.json}`);
}

const program = new Command()
  .name('vault')
  .description('Memory Vault command-line tools')
  .showHelpAfterError();

program
  .command('scan')
  .description('Scan a local folder: hash every file and classify it (read-only)')
  .argument('<path>', 'folder to scan')
  .requiredOption('-s, --source <id>', 'source id, e.g. laptop:s21fe', parseSourceId)
  .option('--dry-run', 'print and save a dry-run report after scanning')
  .option('--upload-mbps <list>', 'upload speeds for time estimates', parseSpeeds, DEFAULT_SPEEDS_MBPS)
  .option('-j, --concurrency <n>', 'files hashed in parallel', (value) => Number.parseInt(value, 10), 4)
  .action(
    async (
      path: string,
      options: { source: SourceId; dryRun?: boolean; uploadMbps: number[]; concurrency: number },
    ) => {
      const manifest = openManifest();
      try {
        const result = await scanLocalSource(manifest, options.source, resolve(path), {
          concurrency: options.concurrency,
        });
        if (result.interrupted) process.exitCode = 130;
        else if (options.dryRun) reportDryRun(manifest, [options.source], options.uploadMbps);
      } finally {
        manifest.close();
      }
    },
  );

program
  .command('report')
  .description('Summarise scanned sources without uploading anything')
  .argument('[sources...]', 'source ids (default: every scanned source, in scan order)')
  .option('--upload-mbps <list>', 'upload speeds for time estimates', parseSpeeds, DEFAULT_SPEEDS_MBPS)
  .action((sources: string[], options: { uploadMbps: number[] }) => {
    const manifest = openManifest();
    try {
      const ids = sources.length > 0 ? sources.map(parseSourceId) : manifest.listSources().map((s) => s.id);
      if (ids.length === 0) throw new Error('no sources scanned yet; run `vault scan` first');
      reportDryRun(manifest, ids, options.uploadMbps);
    } finally {
      manifest.close();
    }
  });

registerPhoneCommands(program);

program.parseAsync().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
