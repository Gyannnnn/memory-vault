import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ApiClient } from '@memory-vault/api-client';
import { formatBytes, formatCount, type SourceId } from '@memory-vault/shared';
import type { FileRow, FileStatus, Manifest } from '../manifest/manifest';

export const buckets = [
  'uploaded',
  'deduplicated',
  'awaiting_review',
  'skipped',
  'excluded',
  'failed',
  'pending',
] as const;
export type Bucket = (typeof buckets)[number];

const bucketLabels: Record<Bucket, string> = {
  uploaded: 'Uploaded',
  deduplicated: 'Already stored (duplicate content)',
  awaiting_review: 'Awaiting your junk review',
  skipped: 'Skipped by you in review',
  excluded: 'Excluded by folder selection',
  failed: 'Failed',
  pending: 'Not attempted yet',
};

interface Tally {
  files: number;
  bytes: number;
}

export interface SourceReconciliation {
  id: SourceId;
  kind: string;
  root: string;
  found: Tally;
  buckets: Record<Bucket, Tally>;
  invariantHolds: boolean;
  notUploaded: { bucket: Bucket; path: string; sha256: string | null; error: string | null }[];
  notRegularFiles: { type: string; path: string; error: string | null }[];
  goneSinceScan: string[];
  safeToDelete: string[] | null;
  stillToVerify: { path: string; status: string }[];
}

export interface ReconciliationReport {
  generatedAt: string;
  verifiedAgainstS3: boolean;
  sources: SourceReconciliation[];
  total: { found: Tally; buckets: Record<Bucket, Tally>; invariantHolds: boolean };
  verification?: {
    checked: number;
    verified: number;
    problems: { sha256: string; status: string; detail?: string }[];
  };
}

function bucketOf(row: FileRow): Bucket {
  if (!row.selected || row.status === 'excluded') return 'excluded';
  if (row.sha256 === null && row.error !== null) return 'failed';
  const status = row.status as Exclude<FileStatus, 'missing'>;
  return status;
}

const emptyBuckets = () =>
  Object.fromEntries(buckets.map((bucket) => [bucket, { files: 0, bytes: 0 }])) as Record<Bucket, Tally>;

export async function buildReconciliation(
  manifest: Manifest,
  sourceIds: SourceId[],
  api: ApiClient | null,
): Promise<ReconciliationReport> {
  const rowsBySource = new Map(sourceIds.map((id) => [id, manifest.files(id)] as const));
  let verification: ReconciliationReport['verification'];
  const verified = new Set<string>();

  if (api) {
    const shas = [
      ...new Set(
        [...rowsBySource.values()]
          .flat()
          .filter((row) => row.status === 'uploaded' || row.status === 'deduplicated')
          .map((row) => row.sha256!),
      ),
    ];
    verification = { checked: shas.length, verified: 0, problems: [] };
    for (let start = 0; start < shas.length; start += 500) {
      const { results } = await api.verifyAssets(shas.slice(start, start + 500));
      for (const result of results) {
        if (result.status === 'verified') verified.add(result.sha256);
        else verification.problems.push(result);
      }
    }
    verification.verified = verified.size;
  }

  const total = { found: { files: 0, bytes: 0 }, buckets: emptyBuckets(), invariantHolds: true };
  const sources: SourceReconciliation[] = [];
  for (const id of sourceIds) {
    const source = manifest.getSource(id)!;
    const rows = rowsBySource.get(id)!;
    const files = rows.filter((row) => row.entryType === 'file' && row.status !== 'missing');
    const result: SourceReconciliation = {
      id,
      kind: source.kind,
      root: source.root,
      found: { files: 0, bytes: 0 },
      buckets: emptyBuckets(),
      invariantHolds: false,
      notUploaded: [],
      notRegularFiles: rows
        .filter((row) => row.entryType !== 'file' && row.status !== 'missing')
        .map((row) => ({ type: row.entryType, path: row.path, error: row.error })),
      goneSinceScan: rows.filter((row) => row.status === 'missing').map((row) => row.path),
      safeToDelete: api ? [] : null,
      stillToVerify: [],
    };
    for (const row of files) {
      const bucket = bucketOf(row);
      result.found.files += 1;
      result.found.bytes += row.size ?? 0;
      result.buckets[bucket].files += 1;
      result.buckets[bucket].bytes += row.size ?? 0;
      if (bucket !== 'uploaded' && bucket !== 'deduplicated') {
        result.notUploaded.push({ bucket, path: row.path, sha256: row.sha256, error: row.error });
      } else if (api) {
        if (verified.has(row.sha256!)) result.safeToDelete!.push(row.path);
        else result.stillToVerify.push({ path: row.path, status: row.status });
      }
    }
    const sum = buckets.reduce((acc, bucket) => acc + result.buckets[bucket].files, 0);
    result.invariantHolds = sum === result.found.files;
    total.invariantHolds &&= result.invariantHolds;
    total.found.files += result.found.files;
    total.found.bytes += result.found.bytes;
    for (const bucket of buckets) {
      total.buckets[bucket].files += result.buckets[bucket].files;
      total.buckets[bucket].bytes += result.buckets[bucket].bytes;
    }
    sources.push(result);
  }

  return {
    generatedAt: new Date().toISOString(),
    verifiedAgainstS3: api !== null,
    sources,
    total,
    ...(verification ? { verification } : {}),
  };
}

function bucketTable(found: Tally, values: Record<Bucket, Tally>): string {
  return [
    '| | Files | Size |',
    '| --- | --- | --- |',
    `| **Found** | **${formatCount(found.files)}** | **${formatBytes(found.bytes)}** |`,
    ...buckets.map(
      (bucket) =>
        `| ${bucketLabels[bucket]} | ${formatCount(values[bucket].files)} | ${formatBytes(values[bucket].bytes)} |`,
    ),
  ].join('\n');
}

export function renderReconciliation(report: ReconciliationReport): string {
  const lines = [
    '# Upload reconciliation',
    '',
    `Generated ${report.generatedAt}. ${
      report.verifiedAgainstS3
        ? 'Every uploaded or already-stored file was checked against S3 just now (exists, same size, same SHA-256 checksum).'
        : 'Statuses come from the upload log; run `vault report --verify` to check each file against S3.'
    }`,
    '',
    `Every file found is counted in exactly one row: ${report.total.invariantHolds ? '**holds**' : '**DOES NOT HOLD — investigate**'}.`,
    '',
    '## All sources',
    '',
    bucketTable(report.total.found, report.total.buckets),
    '',
  ];
  if (report.verification) {
    lines.push(
      `S3 check: ${formatCount(report.verification.verified)} of ${formatCount(report.verification.checked)} distinct files verified.`,
      ...report.verification.problems.map(
        (problem) => `- **${problem.status}** ${problem.sha256} ${problem.detail ?? ''}`,
      ),
      '',
    );
  }
  for (const source of report.sources) {
    lines.push(
      `## ${source.id}`,
      '',
      `Root: \`${source.root}\``,
      '',
      bucketTable(source.found, source.buckets),
      '',
    );
    if (source.safeToDelete) {
      lines.push(
        `Verified in S3 and safe to delete from this source: ${formatCount(source.safeToDelete.length)} files (listed in the safe-to-delete file).`,
        '',
      );
    }
    for (const bucket of buckets.filter((value) => value !== 'uploaded' && value !== 'deduplicated')) {
      const rows = source.notUploaded.filter((row) => row.bucket === bucket);
      if (rows.length === 0) continue;
      lines.push(`### ${bucketLabels[bucket]} (${formatCount(rows.length)})`, '');
      for (const row of rows) lines.push(`- \`${row.path}\`${row.error ? ` — ${row.error}` : ''}`);
      lines.push('');
    }
    if (source.notRegularFiles.length > 0) {
      lines.push('### Not regular files (not uploaded)', '');
      for (const entry of source.notRegularFiles) {
        lines.push(`- ${entry.type}: \`${entry.path}\`${entry.error ? ` — ${entry.error}` : ''}`);
      }
      lines.push('');
    }
    if (source.goneSinceScan.length > 0) {
      lines.push('### No longer in the source since an earlier scan', '');
      for (const path of source.goneSinceScan) lines.push(`- \`${path}\``);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function writeReconciliation(report: ReconciliationReport, directory: string): string[] {
  mkdirSync(directory, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const written = [join(directory, `upload-${stamp}.md`), join(directory, `upload-${stamp}.json`)];
  writeFileSync(written[0]!, `${renderReconciliation(report)}\n`);
  writeFileSync(written[1]!, `${JSON.stringify(report, null, 2)}\n`);
  for (const source of report.sources) {
    if (!source.safeToDelete) continue;
    const path = join(directory, `safe-to-delete-${source.id.replace(':', '-')}-${stamp}.txt`);
    writeFileSync(
      path,
      source.safeToDelete.map((relative) => `${source.root}/${relative}`).join('\n') + '\n',
    );
    written.push(path);
  }
  return written;
}

export function printReconciliation(report: ReconciliationReport): void {
  const row = (label: string, tally: Tally) =>
    `    ${label.padEnd(36)} ${formatCount(tally.files).padStart(8)}  ${formatBytes(tally.bytes).padStart(9)}`;
  console.log('');
  for (const source of [
    ...report.sources,
    { id: 'TOTAL', found: report.total.found, buckets: report.total.buckets },
  ]) {
    console.log(`  ${source.id}`);
    console.log(row('found', source.found));
    for (const bucket of buckets) console.log(row(bucketLabels[bucket], source.buckets[bucket]));
    console.log('');
  }
  console.log(
    `  Every file counted exactly once: ${report.total.invariantHolds ? 'yes' : 'NO — investigate before deleting anything'}`,
  );
  if (report.verification) {
    console.log(
      `  Checked in S3 now: ${formatCount(report.verification.verified)} / ${formatCount(report.verification.checked)} verified${report.verification.problems.length ? `, ${report.verification.problems.length} problems (see report)` : ''}`,
    );
  }
}
