import { api } from '@/lib/api';
import type { SignedRequest, UploadTransport } from './engine';

const aborted = () => new DOMException('The upload was paused', 'AbortError');

const toBase64 = (buffer: ArrayBuffer) => {
  let binary = '';
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** The real thing: a Web Worker for hashing, the API through the gateway, XHR to S3 for progress. */
export const browserTransport: UploadTransport = {
  hash(file, onProgress, signal) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./hash.worker.ts', import.meta.url), { type: 'module' });
      const stop = () => {
        worker.terminate();
        reject(aborted());
      };
      signal.addEventListener('abort', stop, { once: true });
      worker.onmessage = (
        event: MessageEvent<{ type: string; bytes?: number; sha256?: string; message?: string }>,
      ) => {
        const message = event.data;
        if (message.type === 'progress') onProgress(message.bytes ?? 0);
        if (message.type === 'progress') return;
        signal.removeEventListener('abort', stop);
        worker.terminate();
        if (message.type === 'done' && message.sha256) resolve(message.sha256);
        else reject(new Error(message.message ?? 'The file could not be read'));
      };
      worker.onerror = (event) => {
        signal.removeEventListener('abort', stop);
        worker.terminate();
        reject(new Error(event.message || 'The file could not be read'));
      };
      worker.postMessage({ file });
    });
  },

  async hashPart(blob) {
    return toBase64(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  },

  api: (path, init) => api(path, init),

  put(request: SignedRequest, body, onProgress, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(aborted());
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', request.url);
      for (const [name, value] of Object.entries(request.headers)) xhr.setRequestHeader(name, value);
      xhr.upload.onprogress = (event) => onProgress(event.loaded);
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300
          ? resolve({ etag: xhr.getResponseHeader('ETag') })
          : reject(
              new Error(
                `Storage answered ${xhr.status}${xhr.status === 403 ? ' (the link may have expired; retry)' : ''}`,
              ),
            );
      xhr.onerror = () => reject(new Error('The connection to storage failed'));
      xhr.onabort = () => reject(aborted());
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(body);
    });
  },
};
