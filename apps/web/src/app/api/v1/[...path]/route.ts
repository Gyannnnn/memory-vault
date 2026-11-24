import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { ACCESS_COOKIE, apiUrl, forwardedHeaders } from '@/lib/server/session';

/**
 * Same-origin gateway from the browser to the API. The proxy has already renewed
 * the session if needed; this attaches the access token and streams the answer back.
 */
async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const accessToken = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!accessToken) {
    return NextResponse.json(
      { error: { code: 'unauthorized', message: 'Sign in required' } },
      { status: 401 },
    );
  }
  const target = `${apiUrl()}/v1/${path.map(encodeURIComponent).join('/')}${request.nextUrl.search}`;
  const hasBody = !['GET', 'HEAD'].includes(request.method);
  const upstream = await fetch(target, {
    method: request.method,
    headers: {
      ...forwardedHeaders(request),
      authorization: `Bearer ${accessToken}`,
      ...(hasBody ? { 'content-type': request.headers.get('content-type') ?? 'application/json' } : {}),
    },
    body: hasBody ? request.body : null,
    // Required by Node's fetch when streaming a request body.
    ...(hasBody ? { duplex: 'half' } : {}),
    redirect: 'manual',
    cache: 'no-store',
  });
  const headers = new Headers();
  for (const name of [
    'content-type',
    'content-disposition',
    'content-length',
    'location',
    'cache-control',
    'retry-after',
  ]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new NextResponse(upstream.body, { status: upstream.status, headers });
}

export { forward as GET, forward as POST, forward as PUT, forward as PATCH, forward as DELETE };
