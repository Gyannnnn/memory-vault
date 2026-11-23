import {
  estimateStorageCost,
  estimateUploadSeconds,
  reviewReasonLabels,
  s3Pricing,
  type MediaKind,
  type ReviewReason,
  type SourceId,
} from '@memory-vault/shared';
import type { FileRow, Manifest, SourceRow } from '../manifest/manifest';

const EXAMPLES = 5;
export const DEFAULT_SPEEDS_MBPS = [20, 50, 100];

interface Tally {
  files: number;
  bytes: number;
}

interface TallyWithExamples extends Tally {
  examples: string[];
}

export interface SourceSummary {
  id: SourceId;
  kind: SourceRow['kind'];
  root: string;
  files: Tally;
  excluded: Tally & { folders: string[] };
  missingSinceLastScan: TallyWithExamples;
  symlinks: string[];
  otherEntries: string[];
  unreadable: { path: string; error: string }[];
  notYetHashed: number;
  hidden: TallyWithExamples;
  zeroByte: number;
  byKind: Partial<Record<MediaKind, Tally>>;
  byExtension: (Tally & { extension: string })[];
  topFolders: (Tally & { folder: string })[];
  duplicatesWithinSource: {
    groups: number;
    redundantFiles: number;
    redundantBytes: number;
    examples: string[][];
  };
  alreadyInEarlierSource: Tally;
  /** Content first seen in this source: what would have to be copied off a phone before upload. */
  newContent: Tally;
  review: Tally & { byReason: (TallyWithExamples & { reason: ReviewReason; label: string })[] };
}

export interface StagingPlan {
  directory: string;
  freeBytes: number;
  neededBytes: number;
  headroomBytes: number;
  batchBytes: number;
  batches: number;
}

export interface DryRunReport {
  generatedAt: string;
  sources: SourceSummary[];
  combined: {
    found: Tally;
    uniqueContent: Tally;
    duplicateCopies: Tally;
    uploadDirectly: Tally;
    awaitingReview: Tally;
    uploadEstimates: { mbps: number; directSeconds: number; allSeconds: number }[];
    monthlyCost: ReturnType<typeof estimateStorageCost>;
    pricing: typeof s3Pricing;
  };
  staging?: StagingPlan;
  reviewPaths: Record<SourceId, { path: string; reasons: ReviewReason[] }[]>;
  duplicateGroups: { sha256: string; size: number; copies: { sourceId: SourceId; path: string }[] }[];
}

const isHidden = (path: string) => path.split('/').some((segment) => segment.startsWith('.'));
const topFolder = (path: string) => (path.includes('/') ? path.slice(0, path.indexOf('/')) : '(top level)');

function add(tally: Tally, bytes: number | null): void {
  tally.files += 1;
  tally.bytes += bytes ?? 0;
}

function addExample(tally: TallyWithExamples, bytes: number | null, path: string): void {
  add(tally, bytes);
  if (tally.examples.length < EXAMPLES) tally.examples.push(path);
}

function summarize(source: SourceRow, files: FileRow[], seenEarlier: Set<string>): SourceSummary {
  const live = files.filter((file) => file.status !== 'missing');
  const included = live.filter((file) => file.entryType === 'file' && file.selected);
  const excluded = live.filter((file) => file.entryType === 'file' && !file.selected);

  const summary: SourceSummary = {
    id: source.id,
    kind: source.kind,
    root: source.root,
    files: { files: 0, bytes: 0 },
    excluded: {
      files: 0,
      bytes: 0,
      folders: [...new Set(excluded.map((file) => topFolder(file.path)))].sort(),
    },
    missingSinceLastScan: { files: 0, bytes: 0, examples: [] },
    symlinks: live.filter((file) => file.entryType === 'symlink').map((file) => file.path),
    otherEntries: live.filter((file) => file.entryType === 'other').map((file) => file.path),
    unreadable: live
      .filter((file) => file.error !== null)
      .map((file) => ({ path: file.path, error: file.error ?? '' })),
    notYetHashed: included.filter((file) => file.sha256 === null && file.error === null).length,
    hidden: { files: 0, bytes: 0, examples: [] },
    zeroByte: 0,
    byKind: {},
    byExtension: [],
    topFolders: [],
    duplicatesWithinSource: { groups: 0, redundantFiles: 0, redundantBytes: 0, examples: [] },
    alreadyInEarlierSource: { files: 0, bytes: 0 },
    newContent: { files: 0, bytes: 0 },
    review: { files: 0, bytes: 0, byReason: [] },
  };

  for (const file of files.filter((row) => row.status === 'missing')) {
    addExample(summary.missingSinceLastScan, file.size, file.path);
  }
  for (const file of excluded) add(summary.excluded, file.size);

  const extensions = new Map<string, Tally>();
  const folders = new Map<string, Tally>();
  const reasons = new Map<ReviewReason, TallyWithExamples>();
  const bySha = new Map<string, FileRow[]>();

  for (const file of included) {
    add(summary.files, file.size);
    if (isHidden(file.path)) addExample(summary.hidden, file.size, file.path);
    if (file.size === 0) summary.zeroByte += 1;
    const kind = file.kind ?? 'other';
    add((summary.byKind[kind] ??= { files: 0, bytes: 0 }), file.size);
    const extension = file.ext || '(none)';
    if (!extensions.has(extension)) extensions.set(extension, { files: 0, bytes: 0 });
    add(extensions.get(extension)!, file.size);
    const folder = topFolder(file.path);
    if (!folders.has(folder)) folders.set(folder, { files: 0, bytes: 0 });
    add(folders.get(folder)!, file.size);
    if (file.route === 'review') {
      add(summary.review, file.size);
      for (const reason of file.reasons) {
        if (!reasons.has(reason)) reasons.set(reason, { files: 0, bytes: 0, examples: [] });
        addExample(reasons.get(reason)!, file.size, file.path);
      }
    }
    if (file.sha256) {
      if (seenEarlier.has(file.sha256)) add(summary.alreadyInEarlierSource, file.size);
      const group = bySha.get(file.sha256) ?? [];
      group.push(file);
      bySha.set(file.sha256, group);
    }
  }

  for (const [sha256, group] of bySha) {
    if (!seenEarlier.has(sha256)) add(summary.newContent, group[0]!.size);
    if (group.length < 2) continue;
    summary.duplicatesWithinSource.groups += 1;
    summary.duplicatesWithinSource.redundantFiles += group.length - 1;
    summary.duplicatesWithinSource.redundantBytes += (group.length - 1) * (group[0]!.size ?? 0);
    if (summary.duplicatesWithinSource.examples.length < EXAMPLES) {
      summary.duplicatesWithinSource.examples.push(group.map((file) => file.path));
    }
  }

  const bySize = (a: Tally, b: Tally) => b.bytes - a.bytes;
  summary.byExtension = [...extensions].map(([extension, tally]) => ({ extension, ...tally })).sort(bySize);
  summary.topFolders = [...folders].map(([folder, tally]) => ({ folder, ...tally })).sort(bySize);
  summary.review.byReason = [...reasons]
    .map(([reason, tally]) => ({ reason, label: reviewReasonLabels[reason], ...tally }))
    .sort(bySize);
  return summary;
}

export function buildDryRunReport(
  manifest: Manifest,
  sourceIds: SourceId[],
  speedsMbps: number[] = DEFAULT_SPEEDS_MBPS,
): DryRunReport {
  const seen = new Set<string>();
  const sources: SourceSummary[] = [];
  const reviewPaths: DryRunReport['reviewPaths'] = {};
  const content = new Map<
    string,
    { size: number; direct: boolean; copies: { sourceId: SourceId; path: string }[] }
  >();
  const found: Tally = { files: 0, bytes: 0 };

  for (const id of sourceIds) {
    const source = manifest.getSource(id);
    if (!source) throw new Error(`unknown source ${id}; scan it first`);
    const files = manifest.files(id);
    sources.push(summarize(source, files, seen));
    reviewPaths[id] = [];
    for (const file of files) {
      if (file.entryType !== 'file' || !file.selected || file.status === 'missing') continue;
      add(found, file.size);
      if (file.route === 'review') reviewPaths[id].push({ path: file.path, reasons: file.reasons });
      if (!file.sha256) continue;
      const entry = content.get(file.sha256) ?? { size: file.size ?? 0, direct: false, copies: [] };
      entry.direct ||= file.route === 'direct';
      entry.copies.push({ sourceId: id, path: file.path });
      content.set(file.sha256, entry);
    }
    for (const file of files) if (file.sha256) seen.add(file.sha256);
  }

  const uniqueContent: Tally = { files: 0, bytes: 0 };
  const uploadDirectly: Tally = { files: 0, bytes: 0 };
  const awaitingReview: Tally = { files: 0, bytes: 0 };
  let monitoredObjects = 0;
  let multipartParts = 0;
  for (const entry of content.values()) {
    add(uniqueContent, entry.size);
    add(entry.direct ? uploadDirectly : awaitingReview, entry.size);
    if (entry.size >= s3Pricing.intelligentTiering.minMonitoredObjectBytes) monitoredObjects += 1;
    if (entry.size > 16 * 1024 * 1024) multipartParts += Math.ceil(entry.size / (16 * 1024 * 1024)) + 2;
  }

  const duplicateGroups = [...content]
    .filter(([, entry]) => entry.copies.length > 1)
    .map(([sha256, entry]) => ({ sha256, size: entry.size, copies: entry.copies }));

  return {
    generatedAt: new Date().toISOString(),
    sources,
    combined: {
      found,
      uniqueContent,
      duplicateCopies: { files: found.files - uniqueContent.files, bytes: found.bytes - uniqueContent.bytes },
      uploadDirectly,
      awaitingReview,
      uploadEstimates: speedsMbps.map((mbps) => ({
        mbps,
        directSeconds: estimateUploadSeconds(uploadDirectly.bytes, uploadDirectly.files, mbps),
        allSeconds: estimateUploadSeconds(uniqueContent.bytes, uniqueContent.files, mbps),
      })),
      monthlyCost: estimateStorageCost({
        bytes: uniqueContent.bytes,
        objects: uniqueContent.files,
        monitoredObjects,
        multipartParts,
      }),
      pricing: s3Pricing,
    },
    reviewPaths,
    duplicateGroups,
  };
}
