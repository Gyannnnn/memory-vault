import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * MapLibre loads its web worker from a file beside its own module, which bundlers don't
 * emit. Serve the published worker from /vendor instead (see components/map/maplibre.ts).
 */
const require = createRequire(import.meta.url);
const source = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist/maplibre-gl-worker.mjs');
const target = join(dirname(fileURLToPath(import.meta.url)), '../public/vendor/maplibre-gl-worker.mjs');
mkdirSync(dirname(target), { recursive: true });
copyFileSync(source, target);
