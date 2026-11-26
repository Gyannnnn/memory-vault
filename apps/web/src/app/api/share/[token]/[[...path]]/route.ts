import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { apiUrl, forwardedHeaders, secure } from '@/lib/server/session';

/** Proof that a share link's password was given; scoped to that link's gateway path. */
const SHARE_COOKIE = 'mv_share';
const SESSION_SECONDS = 12 * 60 * 60;

/**
 * Same-origin gateway for share links, for visitors who aren't signed in: forwards to the
 * API's public share routes with the link's password session (from an httpOnly cookie), and
 * never with the owner's own tokens.
 */
async function forward(
  request: NextRequest,
  context: { params: Promise<{ token: string; path?: string[] }> },
) {
  const { token, path = [] } = await context.params;
  if (!/^[\w-]{20,100}$/.test(token)) {
    return NextResponse.json(
      { error: { code: 'not_available', message: 'This link isn’t available' } },
      { status: 404 },
    );
  }
  const session = (await cookies()).get(SHARE_COOKIE)?.value;
  const target = `${apiUrl()}/v1/public/shares/${token}${path.map((part) => `/${encodeURIComponent(part)}`).join('')}${request.nextUrl.search}`;
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      ...forwardedHeaders(request),
      ...(session ? { 'x-share-session': session } : {}),
      ...(hasBody ? { 'content-type': request.headers.get('content-type') ?? 'application/json' } : {}),
    },
    body: hasBody ? request.body : null,
    ...(hasBody ? { duplex: 'half' } : {}),
    redirect: 'manual',
    cache: 'no-store',
  });

  // The password session goes into a cookie the page can't read, not to the page.
  if (path.length === 1 && path[0] === 'unlock' && upstream.ok) {
    const { session: issued } = (await upstream.json()) as { session: string };
    const response = NextResponse.json({ ok: true });
    response.cookies.set({
      name: SHARE_COOKIE,
      value: issued,
      httpOnly: true,
      sameSite: 'lax',
      secure: secure(),
      path: `/api/share/${token}`,
      maxAge: SESSION_SECONDS,
    });
    return response;
  }

  const headers = new Headers({ 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' });
  for (const name of [
    'content-type',
    'content-disposition',
    'content-length',
    'cache-control',
    'retry-after',
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export { forward as GET, forward as POST };
