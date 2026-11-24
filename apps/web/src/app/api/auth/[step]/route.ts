import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import type { TokenResponse } from '@memory-vault/shared';
import {
  ACCESS_COOKIE,
  apiUrl,
  clearSession,
  deviceName,
  forwardedHeaders,
  writeSession,
} from '@/lib/server/session';

/** Sign-in steps that end in a session: the tokens go into httpOnly cookies, never to page scripts. */
const sessionSteps: Record<string, string> = {
  totp: '/v1/auth/login/totp',
  recovery: '/v1/auth/login/recovery',
  'passkey-verify': '/v1/auth/login/passkey/verify',
};

/** Steps whose API answer is passed through unchanged (no tokens in them). */
const passThroughSteps: Record<string, string> = {
  password: '/v1/auth/login/password',
  'passkey-options': '/v1/auth/login/passkey/options',
};

async function callApi(request: NextRequest, path: string, body: unknown, accessToken?: string) {
  return fetch(`${apiUrl()}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...forwardedHeaders(request),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body ?? {}),
    cache: 'no-store',
  });
}

export async function POST(request: NextRequest, context: { params: Promise<{ step: string }> }) {
  const { step } = await context.params;
  const jar = await cookies();

  if (step === 'logout') {
    const accessToken = jar.get(ACCESS_COOKIE)?.value;
    if (accessToken) await callApi(request, '/v1/auth/logout', {}, accessToken).catch(() => undefined);
    const response = new NextResponse(null, { status: 204 });
    clearSession(response.cookies);
    return response;
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const passThrough = passThroughSteps[step];
  if (passThrough) {
    const upstream = await callApi(request, passThrough, body);
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }

  const sessionPath = sessionSteps[step];
  if (!sessionPath)
    return NextResponse.json({ error: { code: 'not_found', message: 'Unknown step' } }, { status: 404 });
  const upstream = await callApi(request, sessionPath, {
    ...body,
    deviceName: deviceName(request.headers.get('user-agent')),
  });
  if (!upstream.ok) {
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const tokens = (await upstream.json()) as TokenResponse;
  const response = NextResponse.json({ user: tokens.user, recoveryUsed: tokens.recoveryUsed ?? false });
  writeSession(response.cookies, tokens);
  return response;
}
