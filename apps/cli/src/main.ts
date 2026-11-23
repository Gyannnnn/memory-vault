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
import { createPhoneStager } from './phone/stage';
import { apiClient } from './auth/credentials';
import { login, logout } from './auth/login';
import { runUpload } from './upload/engine';
import { review } from './review/command';
import { classify } from './review/classify';
import { buildReconciliation, printReconciliation, writeReconciliation } from './report/reconcile';

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

function sourceIdsOrAll(manifest: Manifest, sources: string[]): SourceId[] {
  const ids = sources.length > 0 ? sources.map(parseSourceId) : manifest.listSources().map((s) => s.id);
  if (ids.length === 0) throw new Error('no sources scanned yet; run `vault scan` first');
  return ids;
}

program
  .command('dry-run')
  .description('Summarise scanned sources without uploading anything')
  .argument('[sources...]', 'source ids (default: every scanned source, in scan order)')
  .option('--upload-mbps <list>', 'upload speeds for time estimates', parseSpeeds, DEFAULT_SPEEDS_MBPS)
  .action((sources: string[], options: { uploadMbps: number[] }) => {
    const manifest = openManifest();
    try {
      reportDryRun(manifest, sourceIdsOrAll(manifest, sources), options.uploadMbps);
    } finally {
      manifest.close();
    }
  });

program
  .command('login')
  .description('Sign in to your Memory Vault (password + authenticator code, or a recovery code)')
  .option('--recovery', 'sign in with a printed recovery code')
  .action((options: { recovery?: boolean }) => login(options));

program
  .command('logout')
  .description('Sign out on this computer')
  .action(() => logout());

program
  .command('upload')
  .description('Upload scanned sources: resumable, checksum-verified, deduplicated')
  .argument('<sources...>', 'source ids, e.g. laptop:s21fe phone:s21fe')
  .option('--retry-failed', 'retry files that failed in an earlier run')
  .option('--no-rescan', 'skip re-scanning local sources before uploading')
  .option('--keep-staging', 'keep copies pulled from the phone after they upload')
  .option('--parts <n>', 'upload parts in flight', (value) => Number.parseInt(value, 10), 6)
  .option('--files <n>', 'files in flight', (value) => Number.parseInt(value, 10), 4)
  .action(
    async (
      sources: string[],
      options: {
        retryFailed?: boolean;
        rescan: boolean;
        keepStaging?: boolean;
        parts: number;
        files: number;
      },
    ) => {
      const ids = sources.map(parseSourceId);
      const api = apiClient();
      await api.me();
      const manifest = openManifest();
      try {
        for (const id of ids) {
          const source = manifest.getSource(id);
          if (!source) throw new Error(`unknown source ${id}; scan it first`);
          if (source.kind === 'local' && options.rescan) {
            const scan = await scanLocalSource(manifest, id, source.root);
            if (scan.interrupted) return;
          }
        }
        const summary = await runUpload(manifest, api, {
          sourceIds: ids,
          apiUrl: config.apiUrl,
          retryFailed: Boolean(options.retryFailed),
          parallelParts: options.parts,
          parallelFiles: options.files,
          stagePhoneFile: createPhoneStager(manifest, { keepStaging: Boolean(options.keepStaging) }),
        });
        const report = await buildReconciliation(manifest, ids, null);
        printReconciliation(report);
        console.log(`\nReport:\n  ${writeReconciliation(report, config.reportsDir).join('\n  ')}`);
        if (summary.interrupted) process.exitCode = 130;
        else if (summary.failed > 0) process.exitCode = 2;
      } finally {
        manifest.close();
      }
    },
  );

program
  .command('report')
  .description(
    'Reconcile sources against what is stored: found vs uploaded vs duplicates vs review vs failed',
  )
  .argument('[sources...]', 'source ids (default: every scanned source)')
  .option('--verify', 'check every stored file in S3 now and list what is safe to delete from the sources')
  .action(async (sources: string[], options: { verify?: boolean }) => {
    const manifest = openManifest();
    try {
      const ids = sourceIdsOrAll(manifest, sources);
      const report = await buildReconciliation(manifest, ids, options.verify ? apiClient() : null);
      printReconciliation(report);
      console.log(`\nReport:\n  ${writeReconciliation(report, config.reportsDir).join('\n  ')}`);
      if (!report.total.invariantHolds) process.exitCode = 3;
    } finally {
      manifest.close();
    }
  });

program
  .command('review')
  .description(
    'Open the junk review page for files from WhatsApp, Telegram, screenshots, downloads and similar',
  )
  .argument('[sources...]', 'source ids (default: every scanned source)')
  .option('--no-open', 'print the link instead of opening the browser')
  .action(async (sources: string[], options: { open: boolean }) => {
    const manifest = openManifest();
    try {
      await review(manifest, sourceIdsOrAll(manifest, sources), options);
    } finally {
      manifest.close();
    }
  });

program
  .command('classify')
  .description('Score review images with the local CLIP model so likely forwards and greetings sort first')
  .argument('[sources...]', 'source ids (default: every scanned source)')
  .action(async (sources: string[]) => {
    const manifest = openManifest();
    try {
      await classify(manifest, sourceIdsOrAll(manifest, sources));
    } finally {
      manifest.close();
    }
  });

registerPhoneCommands(program);

program.parseAsync().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
