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
    throw new Error('the review page is not built yet; run `pnpm --filter @memory-vault/cli build:review`');
  }
  for (const id of sourceIds) manifest.holdForReview(id);
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
