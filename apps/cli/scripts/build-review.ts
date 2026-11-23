import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { toCss } from '@memory-vault/tokens';

const root = join(dirname(fileURLToPath(import.meta.url)), '../review-ui');
const out = join(root, 'dist');

export async function buildReviewUi(): Promise<string> {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'assets'), { recursive: true });
  await build({
    entryPoints: [join(root, 'src/main.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify: true,
    sourcemap: false,
    outfile: join(out, 'assets/app.js'),
    logLevel: 'warning',
  });
  writeFileSync(
    join(out, 'assets/app.css'),
    `${toCss()}\n\n${readFileSync(join(root, 'src/styles.css'), 'utf8')}`,
  );
  copyFileSync(join(root, 'index.html'), join(out, 'index.html'));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`Built ${await buildReviewUi()}`);
}
