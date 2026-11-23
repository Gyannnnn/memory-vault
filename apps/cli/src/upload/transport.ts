import http from 'node:http';
import https from 'node:https';
import { setTimeout as sleep } from 'node:timers/promises';
import { ApiError } from '@memory-vault/api-client';

const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: 32 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: 32 }),
};

const STALL_TIMEOUT_MS = 120_000;
const WRITE_CHUNK = 256 * 1024;

export class TransferError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: 'network' | 'expired' | 'rejected' | 'server',
  ) {
    super(message);
  }
}

/** PUTs a buffer to a presigned URL with the exact signed headers, reporting bytes as they are written. */
export function putBuffer(
  url: string,
  headers: Record<string, string>,
  body: Buffer,
  onProgress: (bytes: number) => void,
): Promise<{ etag: string | undefined }> {
  const target = new URL(url);
  const transport = target.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    let sent = 0;
    const request = transport.request(
      target,
      {
        method: 'PUT',
        agent: agents[target.protocol as 'http:' | 'https:'],
        headers: { ...headers, 'content-length': String(body.length) },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve({ etag: response.headers.etag });
            return;
          }
          onProgress(-sent);
          const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] ?? `HTTP ${status}`;
          const kind =
            status >= 500 || status === 429
              ? 'server'
              : status === 403 && /expired|RequestTimeTooSkewed/i.test(text)
                ? 'expired'
                : 'rejected';
          reject(new TransferError(`S3 refused the upload: ${code}`, status, kind));
        });
      },
    );
    request.setTimeout(STALL_TIMEOUT_MS, () => request.destroy(new Error('upload stalled')));
    request.on('error', (error) => {
      onProgress(-sent);
      reject(new TransferError(error.message, 0, 'network'));
    });
    let offset = 0;
    const writeMore = () => {
      while (offset < body.length) {
        const end = Math.min(body.length, offset + WRITE_CHUNK);
        const accepted = request.write(body.subarray(offset, end));
        onProgress(end - offset);
        sent += end - offset;
        offset = end;
        if (!accepted) {
          request.once('drain', writeMore);
          return;
        }
      }
      request.end();
    };
    writeMore();
  });
}

export function isNetworkError(error: unknown): boolean {
  return (
    (error instanceof TransferError && error.kind === 'network') ||
    (error instanceof ApiError && error.status === 0)
  );
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof TransferError) return error.kind !== 'rejected';
  if (error instanceof ApiError) return error.retryable;
  return false;
}

/** Blocks until the API answers again, so a dropped connection pauses work instead of failing it. */
export async function waitForNetwork(
  apiUrl: string,
  signal: AbortSignal,
  onWaiting: (seconds: number) => void,
): Promise<void> {
  const started = Date.now();
  while (!signal.aborted) {
    try {
      const response = await fetch(`${apiUrl}/health`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return;
    } catch {
      // still offline
    }
    onWaiting(Math.round((Date.now() - started) / 1000));
    await sleep(15_000, undefined, { signal }).catch(() => undefined);
  }
}

export async function withRetry<T>(
  work: (attempt: number) => Promise<T>,
  options: {
    attempts: number;
    signal: AbortSignal;
    apiUrl: string;
    onWaiting: (seconds: number) => void;
  },
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work(attempt);
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (isNetworkError(error)) {
        await waitForNetwork(options.apiUrl, options.signal, options.onWaiting);
        attempt -= 1;
        continue;
      }
      if (!isRetryable(error) || attempt >= options.attempts) throw error;
      const delay = Math.min(60_000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random() / 2);
      await sleep(delay, undefined, { signal: options.signal }).catch(() => undefined);
    }
  }
}
