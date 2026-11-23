import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatBytes, formatCount, formatDuration, formatUsd } from '@memory-vault/shared';
import type { DryRunReport, SourceSummary } from './dry-run';

const tally = (value: { files: number; bytes: number }) =>
  `${formatCount(value.files)} files · ${formatBytes(value.bytes)}`;

function table(headers: string[], rows: (string | number)[][]): string {
  const line = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

function sourceSection(source: SourceSummary): string {
  const parts: string[] = [
    `## ${source.id}`,
    '',
    `Root: \`${source.root}\``,
    '',
    table(
      ['', 'Files', 'Size'],
      [
        ['Included in this import', formatCount(source.files.files), formatBytes(source.files.bytes)],
        ['…of which go to junk review', formatCount(source.review.files), formatBytes(source.review.bytes)],
        [
          '…of which already found in an earlier source',
          formatCount(source.alreadyInEarlierSource.files),
          formatBytes(source.alreadyInEarlierSource.bytes),
        ],
        [
          '…redundant copies inside this source',
          formatCount(source.duplicatesWithinSource.redundantFiles),
          formatBytes(source.duplicatesWithinSource.redundantBytes),
        ],
        ['Hidden files (included)', formatCount(source.hidden.files), formatBytes(source.hidden.bytes)],
        ['Zero-byte files (included)', formatCount(source.zeroByte), '0 B'],
        [
          'Excluded by folder selection',
          formatCount(source.excluded.files),
          formatBytes(source.excluded.bytes),
        ],
      ],
    ),
    '',
  ];

  if (source.excluded.folders.length > 0) {
    parts.push(
      `Excluded folders: ${source.excluded.folders.map((folder) => `\`${folder}\``).join(', ')}`,
      '',
    );
  }

  parts.push(
    '### By type',
    '',
    table(
      ['Type', 'Files', 'Size'],
      Object.entries(source.byKind)
        .sort(([, a], [, b]) => b.bytes - a.bytes)
        .map(([kind, value]) => [kind, formatCount(value.files), formatBytes(value.bytes)]),
    ),
    '',
    '### By extension',
    '',
    table(
      ['Extension', 'Files', 'Size'],
      source.byExtension.map((row) => [row.extension, formatCount(row.files), formatBytes(row.bytes)]),
    ),
    '',
    '### By top-level folder',
    '',
    table(
      ['Folder', 'Files', 'Size'],
      source.topFolders.map((row) => [`\`${row.folder}\``, formatCount(row.files), formatBytes(row.bytes)]),
    ),
    '',
  );

  parts.push('### Junk review', '');
  if (source.review.byReason.length === 0) {
    parts.push('Nothing in this source needs review.', '');
  } else {
    parts.push(
      'A file can match more than one rule, so rows can add up to more than the total.',
      '',
      table(
        ['Rule', 'Files', 'Size', 'Examples'],
        source.review.byReason.map((row) => [
          row.label,
          formatCount(row.files),
          formatBytes(row.bytes),
          row.examples.map((path) => `\`${path}\``).join('<br>'),
        ]),
      ),
      '',
    );
  }

  if (source.duplicatesWithinSource.examples.length > 0) {
    parts.push(
      '### Duplicate examples (same SHA-256)',
      '',
      ...source.duplicatesWithinSource.examples.map(
        (group) => `- ${group.map((path) => `\`${path}\``).join(' = ')}`,
      ),
      '',
    );
  }

  const problems: string[] = [];
  for (const entry of source.unreadable) problems.push(`- unreadable: \`${entry.path}\` — ${entry.error}`);
  for (const path of source.symlinks) problems.push(`- symlink (not followed, not uploaded): \`${path}\``);
  for (const path of source.otherEntries) problems.push(`- special file (not uploaded): \`${path}\``);
  if (source.notYetHashed > 0)
    problems.push(`- ${source.notYetHashed} files not hashed yet (scan interrupted)`);
  if (source.missingSinceLastScan.files > 0) {
    problems.push(
      `- ${source.missingSinceLastScan.files} files from an earlier scan are no longer in the source, e.g. ${source.missingSinceLastScan.examples
        .map((path) => `\`${path}\``)
        .join(', ')}`,
    );
  }
  parts.push('### Needs attention', '', problems.length > 0 ? problems.join('\n') : 'Nothing.', '');
  return parts.join('\n');
}

export function renderDryRunMarkdown(report: DryRunReport): string {
  const { combined } = report;
  const cost = combined.monthlyCost;
  return [
    '# Dry run',
    '',
    `Generated ${report.generatedAt}. Nothing was uploaded, and the sources were only read.`,
    '',
    '## Summary',
    '',
    table(
      ['', 'Files', 'Size'],
      [
        ['Found across all sources', formatCount(combined.found.files), formatBytes(combined.found.bytes)],
        [
          'Duplicate copies (stored once)',
          formatCount(combined.duplicateCopies.files),
          formatBytes(combined.duplicateCopies.bytes),
        ],
        [
          'Unique content',
          formatCount(combined.uniqueContent.files),
          formatBytes(combined.uniqueContent.bytes),
        ],
        [
          '…uploads directly',
          formatCount(combined.uploadDirectly.files),
          formatBytes(combined.uploadDirectly.bytes),
        ],
        [
          '…waits for your junk review',
          formatCount(combined.awaitingReview.files),
          formatBytes(combined.awaitingReview.bytes),
        ],
      ],
    ),
    '',
    'Content found in both a review folder and a normal folder uploads directly; the review copy is only recorded as another location.',
    '',
    '### Upload time',
    '',
    table(
      ['Upload speed', 'Direct uploads', 'Everything (if all review files are approved)'],
      combined.uploadEstimates.map((row) => [
        `${row.mbps} Mbps`,
        formatDuration(row.directSeconds),
        formatDuration(row.allSeconds),
      ]),
    ),
    '',
    `### Monthly S3 cost (${combined.pricing.region}, Intelligent-Tiering, prices from ${combined.pricing.fetchedOn})`,
    '',
    table(
      ['When', 'Per month'],
      [
        ['First month (everything in the frequent tier)', formatUsd(cost.firstMonth)],
        ['After 30 days without access', formatUsd(cost.idleAfterThirtyDays)],
        [
          'After 90 days without access (steady state for most of an archive)',
          formatUsd(cost.idleAfterNinetyDays),
        ],
        ['One-time upload requests', formatUsd(cost.uploadRequests)],
      ],
    ),
    '',
    'Upper bound: assumes every review file is approved. Thumbnails and previews add well under $1/month.',
    '',
    ...report.sources.map(sourceSection),
  ].join('\n');
}

export function printDryRunSummary(report: DryRunReport): void {
  const { combined } = report;
  const lines = [
    '',
    'Dry run — nothing uploaded, sources only read',
    '',
    ...report.sources.flatMap((source) => [
      `  ${source.id}  (${source.root})`,
      `    included          ${tally(source.files)}`,
      `    junk review       ${tally(source.review)}`,
      `    in earlier source ${tally(source.alreadyInEarlierSource)}`,
      `    duplicates inside ${formatCount(source.duplicatesWithinSource.redundantFiles)} files · ${formatBytes(source.duplicatesWithinSource.redundantBytes)}`,
      ...(source.excluded.files > 0 ? [`    excluded          ${tally(source.excluded)}`] : []),
      ...(source.unreadable.length > 0
        ? [`    unreadable        ${source.unreadable.length} (see report)`]
        : []),
    ]),
    '',
    `  unique content      ${tally(combined.uniqueContent)}`,
    `    uploads directly  ${tally(combined.uploadDirectly)}`,
    `    awaits review     ${tally(combined.awaitingReview)}`,
    '',
    `  upload time (direct): ${combined.uploadEstimates.map((row) => `${formatDuration(row.directSeconds)} @ ${row.mbps} Mbps`).join(', ')}`,
    `  S3 per month: ${formatUsd(combined.monthlyCost.firstMonth)} first month → ${formatUsd(combined.monthlyCost.idleAfterNinetyDays)} once idle 90+ days`,
    '',
  ];
  console.log(lines.join('\n'));
}

export function writeDryRunReport(
  report: DryRunReport,
  directory: string,
): { json: string; markdown: string } {
  mkdirSync(directory, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, '-');
  const json = join(directory, `dry-run-${stamp}.json`);
  const markdown = join(directory, `dry-run-${stamp}.md`);
  writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdown, `${renderDryRunMarkdown(report)}\n`);
  return { json, markdown };
}
