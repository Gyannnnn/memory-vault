/// <reference lib="webworker" />
// SHA-256 of a whole file, off the main thread, a few MiB at a time (so a large video
// never has to fit in memory). Reports progress as it goes.
import { createSHA256 } from 'hash-wasm';

const CHUNK = 8 * 1024 * 1024;

self.onmessage = async (event: MessageEvent<{ file: Blob }>) => {
  try {
    const { file } = event.data;
    const hasher = await createSHA256();
    hasher.init();
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      hasher.update(new Uint8Array(await file.slice(offset, offset + CHUNK).arrayBuffer()));
      self.postMessage({ type: 'progress', bytes: Math.min(file.size, offset + CHUNK) });
    }
    self.postMessage({ type: 'done', sha256: hasher.digest('hex') });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
