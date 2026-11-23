import { Router } from 'express';
import { z } from 'zod';
import {
  passkeyLoginVerifyRequest,
  passkeyRegisterVerifyRequest,
  passwordLoginRequest,
  recoveryLoginRequest,
  refreshRequest,
  totpLoginRequest,
} from '@memory-vault/shared';
import type { AppContext } from '../context';
import { authOf, requestMeta, requireAuth } from '../http/auth-middleware';
import { parse } from '../http/errors';
import { AuthService } from './service';

export function authRoutes(ctx: AppContext): Router {
  const router = Router();
  const auth = new AuthService(ctx);
  const signedIn = requireAuth(ctx);

  router.post('/login/password', async (request, response) => {
    const input = parse(passwordLoginRequest, request.body);
    const { mfaToken } = await auth.passwordLogin(input, requestMeta(request));
    response.json({ mfaRequired: true, mfaToken });
  });

  router.post('/login/totp', async (request, response) => {
    response.json(await auth.totpLogin(parse(totpLoginRequest, request.body), requestMeta(request)));
  });

  router.post('/login/recovery', async (request, response) => {
    response.json(await auth.recoveryLogin(parse(recoveryLoginRequest, request.body), requestMeta(request)));
  });

  router.post('/login/passkey/options', async (request, response) => {
    response.json(await auth.passkeyLoginOptions(requestMeta(request)));
  });

  router.post('/login/passkey/verify', async (request, response) => {
    response.json(
      await auth.verifyPasskeyLogin(parse(passkeyLoginVerifyRequest, request.body), requestMeta(request)),
    );
  });

  router.post('/refresh', async (request, response) => {
    const { refreshToken } = parse(refreshRequest, request.body);
    response.json(await auth.refresh(refreshToken, requestMeta(request)));
  });

  router.post('/logout', signedIn, async (request, response) => {
    const { userId, sessionId } = authOf(request);
    await auth.revokeSession(userId, sessionId, 'logout', requestMeta(request));
    response.status(204).end();
  });

  router.get('/sessions', signedIn, async (request, response) => {
    const { userId, sessionId } = authOf(request);
    response.json({ sessions: await auth.listSessions(userId, sessionId) });
  });

  router.delete('/sessions/:id', signedIn, async (request, response) => {
    const { userId } = authOf(request);
    const id = parse(z.uuid(), request.params.id);
    await auth.revokeSession(userId, id, 'signed_out_by_user', requestMeta(request));
    response.status(204).end();
  });

  router.post('/passkeys/register/options', signedIn, async (request, response) => {
    response.json(await auth.passkeyRegistrationOptions(authOf(request).userId));
  });

  router.post('/passkeys/register/verify', signedIn, async (request, response) => {
    const input = parse(passkeyRegisterVerifyRequest, request.body);
    response
      .status(201)
      .json(await auth.verifyPasskeyRegistration(authOf(request).userId, input, requestMeta(request)));
  });

  router.get('/passkeys', signedIn, async (request, response) => {
    response.json({ passkeys: await auth.listPasskeys(authOf(request).userId) });
  });

  router.delete('/passkeys/:id', signedIn, async (request, response) => {
    await auth.removePasskey(
      authOf(request).userId,
      parse(z.uuid(), request.params.id),
      requestMeta(request),
    );
    response.status(204).end();
  });

  return router;
}
