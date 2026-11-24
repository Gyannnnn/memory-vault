import { NextResponse, type NextRequest } from 'next/server';
import type { TokenResponse } from '@memory-vault/shared';
import {
  ACCESS_COOKIE,
  apiUrl,
  clearSession,
  expiresSoon,
  forwardedHeaders,
  REFRESH_COOKIE,
  writeSession,
} from '@/lib/server/session';

const PUBLIC_PATHS = ['/sign-in', '/api/auth'];

async function refresh(request: NextRequest, refreshToken: string): Promise<TokenResponse | null> {
  try {
    const response = await fetch(`${apiUrl()}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...forwardedHeaders(request) },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    return response.ok ? ((await response.json()) as TokenResponse) : null;
  } catch {
    return null;
  }
}

/**
 * Gatekeeper for every page and API call: lets valid sessions through, renews an
 * expiring access token with the refresh token, and sends everyone else to sign in.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) {
    return NextResponse.next();
  }

  const access = request.cookies.get(ACCESS_COOKIE)?.value;
  if (!expiresSoon(access)) return NextResponse.next();

  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  const tokens = refreshToken ? await refresh(request, refreshToken) : null;
  if (tokens) {
    request.cookies.set(ACCESS_COOKIE, tokens.accessToken);
    request.cookies.set(REFRESH_COOKIE, tokens.refreshToken);
    const response = NextResponse.next({ request: { headers: new Headers(request.headers) } });
    writeSession(response.cookies, tokens);
    return response;
  }

  const response = pathname.startsWith('/api/')
    ? NextResponse.json({ error: { code: 'unauthorized', message: 'Sign in required' } }, { status: 401 })
    : NextResponse.redirect(
        new URL(
          `/sign-in${pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + search)}`}`,
          request.url,
        ),
      );
  clearSession(response.cookies);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|webp|ico|txt)$).*)'],
};
