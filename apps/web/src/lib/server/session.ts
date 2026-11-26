import type { TokenResponse } from '@memory-vault/shared';

export const ACCESS_COOKIE = 'vault_at';
export const REFRESH_COOKIE = 'vault_rt';

export const apiUrl = () => (process.env.API_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

export const secure = () => process.env.NODE_ENV === 'production' && !apiUrl().startsWith('http://localhost');

interface CookieWriter {
  set(options: {
    name: string;
    value: string;
    httpOnly: boolean;
    sameSite: 'lax';
    secure: boolean;
    path: string;
    expires: Date;
  }): unknown;
  delete(name: string): unknown;
}

/** Tokens live only in httpOnly cookies: page scripts can never read them. */
export function writeSession(cookies: CookieWriter, tokens: TokenResponse): void {
  const common = { httpOnly: true, sameSite: 'lax' as const, secure: secure(), path: '/' };
  cookies.set({
    name: ACCESS_COOKIE,
    value: tokens.accessToken,
    expires: new Date(tokens.accessTokenExpiresAt),
    ...common,
  });
  cookies.set({
    name: REFRESH_COOKIE,
    value: tokens.refreshToken,
    expires: new Date(tokens.refreshTokenExpiresAt),
    ...common,
  });
}

export function clearSession(cookies: CookieWriter): void {
  cookies.delete(ACCESS_COOKIE);
  cookies.delete(REFRESH_COOKIE);
}

/** Reads the expiry from an access token without verifying it; the API verifies every request. */
export function expiresSoon(token: string | undefined, marginSeconds = 30): boolean {
  if (!token) return true;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return !payload.exp || payload.exp * 1000 - Date.now() < marginSeconds * 1000;
  } catch {
    return true;
  }
}

export function deviceName(userAgent: string | null): string {
  const ua = userAgent ?? '';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS X/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'unknown system';
  return `${browser} on ${os}`;
}

export function forwardedHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  const userAgent = request.headers.get('user-agent');
  const forwardedFor = request.headers.get('x-forwarded-for');
  if (userAgent) headers['user-agent'] = userAgent;
  if (forwardedFor) headers['x-forwarded-for'] = forwardedFor;
  return headers;
}
