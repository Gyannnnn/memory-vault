import { createSourceReader } from '@memory-vault/media';
import { formatCount, type SourceId } from '@memory-vault/shared';
import { config, containerPath } from '../config';
import type { FileRow, Manifest } from '../manifest/manifest';
import { createPhoneStager } from '../phone/stage';
import { LiveView } from '../ui/live';
import { interruptSignal } from '../ui/pool';

const SCORABLE = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif']);
const BATCH = 32;

interface JunkResult {
  path: string;
  junk?: number;
  label?: string;
}

/**
 * Scores review images with the local CLIP model so the review page can put likely
 * forwards and greetings first. Scores only order the review; nothing is decided here.
 */
export async function classify(manifest: Manifest, sourceIds: SourceId[]): Promise<void> {
  const health = await fetch(`${config.mlUrl}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `the ML service is not running at ${config.mlUrl}; start it with \`docker compose --profile app up -d ml\``,
    );
  }
  const view = new LiveView();
  const { signal, dispose } = interruptSignal(() => view.finish(['Stopping; scores so far are saved.']));
  const stage = createPhoneStager(manifest, { keepStaging: true });
  try {
    const pending = manifest
      .reviewItems(sourceIds)
      .filter((item) => item.junkScore === null && SCORABLE.has(item.ext ?? '') && (item.size ?? 0) > 0);
    let scored = 0;
    let unreadable = 0;
    for (let start = 0; start < pending.length && !signal.aborted; start += BATCH) {
      const batch: { row: FileRow; path: string }[] = [];
      for (const row of pending.slice(start, start + BATCH)) {
        const source = manifest.getSource(row.sourceId)!;
        const hostPath =
          source.kind === 'local'
            ? createSourceReader(source.root).absolutePath(row.path)
            : await stage(source, row, signal).then((file) => file.reader.absolutePath(file.relativePath));
        const mapped = containerPath(hostPath);
        if (mapped) batch.push({ row, path: mapped });
        else unreadable += 1;
      }
      if (batch.length === 0) continue;
      const response = await fetch(`${config.mlUrl}/junk`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: batch.map((item) => item.path) }),
      });
      if (!response.ok) throw new Error(`ML service answered ${response.status}`);
      const { results } = (await response.json()) as { results: JunkResult[] };
      results.forEach((result, index) => {
        const { row } = batch[index]!;
        if (result.junk === undefined || !result.label) unreadable += 1;
        else {
          manifest.setJunkScore(row.sourceId, row.path, result.junk, result.label);
          scored += 1;
        }
      });
      view.render([`Scoring review images… ${formatCount(scored)} / ${formatCount(pending.length)}`]);
    }
    view.finish([
      `Scored ${formatCount(scored)} images${unreadable ? `; ${formatCount(unreadable)} could not be read (they stay unscored)` : ''}.`,
    ]);
  } finally {
    dispose();
  }
}
