import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { revokedSessionKey } from '../auth/service';
import { verifyAccessToken } from '../auth/tokens';
import type { AppContext } from '../context';
import { unauthorized } from './errors';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: { userId: string; sessionId: string };
    }
  }
}

export function requireAuth(ctx: Pick<AppContext, 'keys' | 'redis'>): RequestHandler {
  return async (request: Request, _response: Response, next: NextFunction) => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const claims = token ? await verifyAccessToken(ctx.keys, token) : null;
    if (!claims) throw unauthorized();
    if (await ctx.redis.exists(revokedSessionKey(claims.sessionId)))
      throw unauthorized('This session was signed out');
    request.auth = claims;
    next();
  };
}

export function authOf(request: Request): { userId: string; sessionId: string } {
  if (!request.auth) throw unauthorized();
  return request.auth;
}

export function requestMeta(request: Request) {
  return { ip: request.ip, userAgent: request.get('user-agent') };
}
