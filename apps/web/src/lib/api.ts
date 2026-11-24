/** Browser-side calls. Every request goes to this app's own origin; the session cookies never leave it. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const fallbackMessage = (status: number) =>
  status === 0
    ? 'Could not reach the server. Check that the API is running.'
    : status === 429
      ? 'Too many attempts. Wait a minute and try again.'
      : status >= 500
        ? 'Something went wrong on the server. Try again.'
        : 'The request was not accepted.';

async function send<T>(url: string, method: string, body: unknown, signOutOn401: boolean): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', fallbackMessage(0));
  }
  if (response.status === 204) return undefined as T;
  const payload = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  if (!response.ok) {
    if (response.status === 401 && signOutOn401) {
      const next = `${window.location.pathname}${window.location.search}`;
      // A full page load, so nothing from the library stays in this tab's memory.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.assign(`/sign-in?next=${encodeURIComponent(next)}`);
    }
    throw new ApiError(
      response.status,
      payload?.error?.code ?? 'http_error',
      payload?.error?.message ?? fallbackMessage(response.status),
    );
  }
  return payload as T;
}

/** Calls the Memory Vault API through the same-origin gateway; a lost session goes back to sign-in. */
export function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  return send<T>(`/api/v1${path}`, options.method ?? 'GET', options.body, true);
}

/** Sign-in steps; a 401 here is a wrong answer, not a lost session. */
export function authStep<T = unknown>(step: string, body?: unknown): Promise<T> {
  return send<T>(`/api/auth/${step}`, 'POST', body ?? {}, false);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}
