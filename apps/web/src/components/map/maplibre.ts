import { getVersion, setWorkerUrl } from 'maplibre-gl';

// Must run before the first map is created; see scripts/copy-vendor.ts.
setWorkerUrl(`/vendor/maplibre-gl-worker.mjs?v=${getVersion()}`);
