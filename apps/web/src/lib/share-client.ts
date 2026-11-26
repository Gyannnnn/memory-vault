import { ApiError } from './api';

/** Calls a share link's gateway. Unlike `api`, a 401 means "password needed", not "sign in". */
export async function shareApi<T>(
  token: string,
  path = '',
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/share/${token}${path}`, {
      method: options.method ?? 'GET',
      headers: options.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach Memory Vault. Check your connection.');
  }
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'http_error',
      payload?.error?.message ??
        (response.status === 429
          ? 'Too many tries. Wait a few minutes.'
          : 'Something went wrong. Try again.'),
    );
  }
  return payload as T;
}

export const sharePath = (token: string, path: string) => `/api/share/${token}${path}`;
