import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SourceId } from '@memory-vault/shared';
import { config } from '../config';
import type { Manifest } from '../manifest/manifest';
import { createPhoneStager } from '../phone/stage';
import { startReviewServer } from './server';

const staticDir = join(dirname(fileURLToPath(import.meta.url)), '../../review-ui/dist');

export async function review(
  manifest: Manifest,
  sourceIds: SourceId[],
  options: { open: boolean },
): Promise<void> {
  if (!existsSync(join(staticDir, 'index.html'))) {
    const { buildReviewUi } = await import('../../scripts/build-review');
    await buildReviewUi();
  }
  let inherited = { kept: 0, skipped: 0 };
  for (const id of sourceIds) {
    const result = manifest.inheritDecisions(id);
    inherited = { kept: inherited.kept + result.kept, skipped: inherited.skipped + result.skipped };
    manifest.holdForReview(id);
  }
  if (inherited.kept + inherited.skipped > 0) {
    console.log(
      `Carried over earlier decisions for identical files: ${inherited.kept} already stored (kept), ${inherited.skipped} skipped before. You can still change them.`,
    );
  }
  const server = await startReviewServer({
    manifest,
    sourceIds,
    staticDir,
    cacheDir: join(config.dataDir, 'review-cache'),
    stagePhoneFile: createPhoneStager(manifest, { keepStaging: true }),
  });
  console.log(`Review page: ${server.url}`);
  console.log(
    'Decisions are saved as you go. Press Ctrl+C when you are done, then run `vault upload` to send approved files.',
  );
  if (options.open) spawn('xdg-open', [server.url], { stdio: 'ignore', detached: true }).unref();
  await new Promise<void>((resolve) => process.once('SIGINT', resolve));
  await server.close();
}
