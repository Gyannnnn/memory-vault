import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { SessionSummary, TokenResponse } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { newId, type Db } from '../db';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../http/errors';
import { audit, type RequestMeta } from './audit';
import { consume, reset } from './rate-limits';
import {
  burnVerifyTime,
  decrypt,
  encrypt,
  generateRecoveryCode,
  hashSecret,
  normalizeRecoveryCode,
  randomToken,
  sha256Hex,
  verifySecret,
} from './secrets';
import { signAccessToken, signMfaToken, verifyMfaToken } from './tokens';
import { newTotpSecret, totpUri, verifyTotp } from './totp';

const REFRESH_TOKEN_DAYS = 30;
const SESSION_MAX_DAYS = 365;
const RECOVERY_CODE_COUNT = 10;
const CHALLENGE_SECONDS = 300;
const DAY = 24 * 60 * 60 * 1000;

type AuthContext = Pick<AppContext, 'db' | 'redis' | 'keys' | 'env' | 'limits'>;
type AuthMethod = 'password+totp' | 'recovery-code' | 'passkey';

interface StoredChallenge {
  challenge: string;
  kind: 'register' | 'login';
  userId?: string;
}

export const revokedSessionKey = (sessionId: string) => `revoked-session:${sessionId}`;

export class AuthService {
  constructor(private readonly ctx: AuthContext) {}

  private get db(): Db {
    return this.ctx.db;
  }

  // ─── Accounts ──────────────────────────────────────────────────────────────

  async createUser(input: {
    email: string;
    displayName: string;
    password: string;
    timezone?: string;
    userId?: string;
  }): Promise<{
    userId: string;
    totpSecret: string;
    totpUri: string;
  }> {
    const existing = await this.db.user.findUnique({ where: { email: input.email } });
    if (existing) throw conflict('An account with this email already exists');
    const userId = input.userId ?? newId();
    const totpSecret = newTotpSecret();
    const passwordHash = await hashSecret(input.password);
    await this.db.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: userId,
          email: input.email,
          displayName: input.displayName,
          timezone: input.timezone ?? 'UTC',
          storageQuotaBytes: this.ctx.env.DEFAULT_QUOTA_BYTES,
        },
      });
      await tx.passwordCredential.create({ data: { userId, hash: passwordHash } });
      await tx.totpCredential.create({
        data: {
          userId,
          secretCiphertext: Uint8Array.from(
            encrypt(Buffer.from(totpSecret), this.ctx.env.DATA_ENCRYPTION_KEY),
          ),
        },
      });
      await audit(tx, { userId, type: 'user.created' });
    });
    return { userId, totpSecret, totpUri: totpUri(totpSecret, input.email) };
  }

  async confirmTotp(userId: string, code: string): Promise<void> {
    const credential = await this.db.totpCredential.findUnique({ where: { userId } });
    if (!credential) throw notFound('No authenticator is being set up');
    const secret = decrypt(credential.secretCiphertext, this.ctx.env.DATA_ENCRYPTION_KEY).toString();
    const step = verifyTotp(secret, code, credential.lastUsedStep);
    if (step === null)
      throw badRequest('That code is not valid. Check the time on your phone and try again.');
    await this.db.totpCredential.update({
      where: { userId },
      data: { confirmedAt: new Date(), lastUsedStep: step },
    });
    await audit(this.db, { userId, type: 'auth.totp_enrolled' });
  }

  /** Replaces all recovery codes. The plain codes are returned once and never stored. */
  async generateRecoveryCodes(userId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const hashes = await Promise.all(codes.map((code) => hashSecret(normalizeRecoveryCode(code))));
    await this.db.$transaction(async (tx) => {
      await tx.recoveryCode.deleteMany({ where: { userId } });
      await tx.recoveryCode.createMany({ data: hashes.map((hash) => ({ id: newId(), userId, hash })) });
      await audit(tx, { userId, type: 'auth.recovery_codes_generated' });
    });
    return codes;
  }

  // ─── Sign-in ───────────────────────────────────────────────────────────────

  async passwordLogin(
    input: { email: string; password: string },
    meta: RequestMeta,
  ): Promise<{ mfaToken: string }> {
    await consume(this.ctx.limits.loginByIp, meta.ip ?? 'unknown');
    await consume(this.ctx.limits.loginByAccount, input.email);
    const user = await this.db.user.findUnique({
      where: { email: input.email },
      include: { password: true, totp: true },
    });
    if (!user?.password) {
      await burnVerifyTime(input.password);
      throw unauthorized('Email or password is incorrect');
    }
    if (!(await verifySecret(user.password.hash, input.password))) {
      await audit(this.db, {
        userId: user.id,
        type: 'auth.login_failed',
        meta,
        metadata: { step: 'password' },
      });
      throw unauthorized('Email or password is incorrect');
    }
    if (user.status !== 'active') throw forbidden('This account is not active');
    if (!user.totp?.confirmedAt) {
      throw new HttpError(
        403,
        'mfa_not_enrolled',
        'Two-factor authentication must be set up for this account',
      );
    }
    await reset(this.ctx.limits.loginByAccount, input.email);
    return { mfaToken: await signMfaToken(this.ctx.keys, user.id) };
  }

  async totpLogin(
    input: { mfaToken: string; code: string; deviceName: string },
    meta: RequestMeta,
  ): Promise<TokenResponse> {
    const claim = await verifyMfaToken(this.ctx.keys, input.mfaToken);
    if (!claim) throw unauthorized('The sign-in attempt expired. Start again.');
    await consume(this.ctx.limits.mfaByUser, claim.userId);
    const used = await this.ctx.redis.set(`mfa-used:${claim.tokenId}`, '1', 'EX', 600, 'NX');
    const credential = await this.db.totpCredential.findUnique({ where: { userId: claim.userId } });
    if (!credential?.confirmedAt) throw unauthorized();
    const secret = decrypt(credential.secretCiphertext, this.ctx.env.DATA_ENCRYPTION_KEY).toString();
    const step = verifyTotp(secret, input.code, credential.lastUsedStep);
    if (step === null || used === null) {
      if (used !== null) await this.ctx.redis.del(`mfa-used:${claim.tokenId}`);
      await audit(this.db, {
        userId: claim.userId,
        type: 'auth.login_failed',
        meta,
        metadata: { step: 'totp' },
      });
      throw unauthorized('That code is not valid');
    }
    const claimed = await this.db.totpCredential.updateMany({
      where: {
        userId: claim.userId,
        OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
      },
      data: { lastUsedStep: step },
    });
    if (claimed.count === 0) throw unauthorized('That code was already used');
    await reset(this.ctx.limits.mfaByUser, claim.userId);
    return this.issueSession(claim.userId, input.deviceName, 'password+totp', meta);
  }

  async recoveryLogin(
    input: { email: string; recoveryCode: string; deviceName: string },
    meta: RequestMeta,
  ): Promise<TokenResponse> {
    await consume(this.ctx.limits.loginByIp, meta.ip ?? 'unknown');
    await consume(this.ctx.limits.recoveryByAccount, input.email);
    const normalized = normalizeRecoveryCode(input.recoveryCode);
    const user = await this.db.user.findUnique({
      where: { email: input.email },
      include: { recoveryCodes: { where: { usedAt: null } } },
    });
    if (!user || user.status !== 'active') {
      await burnVerifyTime(normalized);
      throw unauthorized('That recovery code is not valid');
    }
    for (const code of user.recoveryCodes) {
      if (!(await verifySecret(code.hash, normalized))) continue;
      const claimed = await this.db.recoveryCode.updateMany({
        where: { id: code.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (claimed.count === 0) break;
      const remaining = user.recoveryCodes.length - 1;
      await audit(this.db, {
        userId: user.id,
        type: 'auth.recovery_code_used',
        meta,
        metadata: { remaining },
      });
      await reset(this.ctx.limits.recoveryByAccount, input.email);
      return {
        ...(await this.issueSession(user.id, input.deviceName, 'recovery-code', meta)),
        recoveryUsed: true,
      };
    }
    await audit(this.db, {
      userId: user.id,
      type: 'auth.login_failed',
      meta,
      metadata: { step: 'recovery' },
    });
    throw unauthorized('That recovery code is not valid');
  }

  // ─── Sessions ──────────────────────────────────────────────────────────────

  private async issueSession(
    userId: string,
    deviceName: string,
    method: AuthMethod,
    meta: RequestMeta,
  ): Promise<TokenResponse> {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    const sessionId = newId();
    const refreshToken = randomToken();
    const refreshTokenExpiresAt = new Date(Date.now() + REFRESH_TOKEN_DAYS * DAY);
    await this.db.$transaction(async (tx) => {
      await tx.session.create({
        data: {
          id: sessionId,
          userId,
          deviceName,
          userAgent: meta.userAgent?.slice(0, 500) ?? null,
          ipAddress: meta.ip ?? null,
          authMethod: method,
          expiresAt: new Date(Date.now() + SESSION_MAX_DAYS * DAY),
        },
      });
      await tx.refreshToken.create({
        data: { hash: sha256Hex(refreshToken), sessionId, expiresAt: refreshTokenExpiresAt },
      });
      await audit(tx, { userId, type: 'auth.login', meta, metadata: { method, sessionId, deviceName } });
    });
    const access = await signAccessToken(this.ctx.keys, { userId, sessionId });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken,
      refreshTokenExpiresAt: refreshTokenExpiresAt.toISOString(),
      sessionId,
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }

  /**
   * Rotates a refresh token. Each token works once; presenting an already-used
   * token means it was copied, so the whole session is revoked.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<TokenResponse> {
    await consume(this.ctx.limits.refreshByIp, meta.ip ?? 'unknown');
    const hash = sha256Hex(refreshToken);
    const now = new Date();
    const claimed = await this.db.refreshToken.updateMany({
      where: { hash, usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    const record = await this.db.refreshToken.findUnique({
      where: { hash },
      include: { session: { include: { user: true } } },
    });
    if (!record) throw unauthorized('Sign in again');
    const { session } = record;
    if (claimed.count === 0) {
      if (record.usedAt && !session.revokedAt) {
        await this.revokeSession(session.userId, session.id, 'refresh_token_reuse');
        await audit(this.db, {
          userId: session.userId,
          type: 'auth.refresh_reuse_detected',
          meta,
          metadata: { sessionId: session.id },
        });
      }
      throw unauthorized('Sign in again');
    }
    if (session.revokedAt || session.expiresAt <= now || session.user.status !== 'active') {
      throw unauthorized('Sign in again');
    }
    const next = randomToken();
    const nextExpiresAt = new Date(
      Math.min(now.getTime() + REFRESH_TOKEN_DAYS * DAY, session.expiresAt.getTime()),
    );
    await this.db.$transaction([
      this.db.refreshToken.create({
        data: { hash: sha256Hex(next), sessionId: session.id, expiresAt: nextExpiresAt },
      }),
      this.db.session.update({
        where: { id: session.id },
        data: { lastUsedAt: now, ipAddress: meta.ip ?? session.ipAddress },
      }),
    ]);
    const access = await signAccessToken(this.ctx.keys, { userId: session.userId, sessionId: session.id });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt.toISOString(),
      refreshToken: next,
      refreshTokenExpiresAt: nextExpiresAt.toISOString(),
      sessionId: session.id,
      user: { id: session.user.id, email: session.user.email, displayName: session.user.displayName },
    };
  }

  async revokeSession(userId: string, sessionId: string, reason: string, meta?: RequestMeta): Promise<void> {
    const result = await this.db.session.updateMany({
      where: { id: sessionId, userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason },
    });
    if (result.count === 0) {
      const exists = await this.db.session.findFirst({ where: { id: sessionId, userId } });
      if (!exists) throw notFound('Session not found');
      return;
    }
    await this.ctx.redis.set(revokedSessionKey(sessionId), '1', 'EX', 15 * 60);
    await audit(this.db, {
      userId,
      type: 'auth.session_revoked',
      ...(meta ? { meta } : {}),
      metadata: { sessionId, reason },
    });
  }

  async listSessions(userId: string, currentSessionId: string): Promise<SessionSummary[]> {
    const sessions = await this.db.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastUsedAt: 'desc' },
    });
    return sessions.map((session) => ({
      id: session.id,
      deviceName: session.deviceName,
      authMethod: session.authMethod,
      createdAt: session.createdAt.toISOString(),
      lastUsedAt: session.lastUsedAt.toISOString(),
      current: session.id === currentSessionId,
    }));
  }

  // ─── Passkeys ──────────────────────────────────────────────────────────────

  private async storeChallenge(value: StoredChallenge): Promise<string> {
    const challengeId = newId();
    await this.ctx.redis.set(`webauthn:${challengeId}`, JSON.stringify(value), 'EX', CHALLENGE_SECONDS);
    return challengeId;
  }

  private async takeChallenge(challengeId: string, kind: StoredChallenge['kind']): Promise<StoredChallenge> {
    const raw = await this.ctx.redis.getdel(`webauthn:${challengeId}`);
    const stored = raw ? (JSON.parse(raw) as StoredChallenge) : null;
    if (!stored || stored.kind !== kind) throw unauthorized('The passkey request expired. Try again.');
    return stored;
  }

  async passkeyRegistrationOptions(userId: string) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId }, include: { passkeys: true } });
    const options = await generateRegistrationOptions({
      rpName: this.ctx.env.WEBAUTHN_RP_NAME,
      rpID: this.ctx.env.WEBAUTHN_RP_ID,
      userName: user.email,
      userDisplayName: user.displayName,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: user.passkeys.map((passkey) => ({
        id: passkey.credentialId,
        transports: passkey.transports,
      })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challengeId = await this.storeChallenge({ challenge: options.challenge, kind: 'register', userId });
    return { challengeId, options };
  }

  async verifyPasskeyRegistration(
    userId: string,
    input: { challengeId: string; response: Record<string, unknown>; nickname: string },
    meta: RequestMeta,
  ): Promise<{ id: string }> {
    const stored = await this.takeChallenge(input.challengeId, 'register');
    if (stored.userId !== userId) throw unauthorized('The passkey request expired. Try again.');
    const verification = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.ctx.env.WEBAUTHN_ORIGINS,
      expectedRPID: this.ctx.env.WEBAUTHN_RP_ID,
      requireUserVerification: true,
    }).catch((error: unknown) => {
      throw badRequest(
        `Passkey could not be verified: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    });
    if (!verification.verified) throw badRequest('Passkey could not be verified');
    const info = verification.registrationInfo;
    const id = newId();
    await this.db.passkey.create({
      data: {
        id,
        userId,
        credentialId: info.credential.id,
        publicKey: Uint8Array.from(info.credential.publicKey),
        counter: BigInt(info.credential.counter),
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        nickname: input.nickname,
        aaguid: info.aaguid,
      },
    });
    await audit(this.db, {
      userId,
      type: 'auth.passkey_added',
      meta,
      metadata: { passkeyId: id, nickname: input.nickname },
    });
    return { id };
  }

  async passkeyLoginOptions(meta: RequestMeta) {
    await consume(this.ctx.limits.passkeyByIp, meta.ip ?? 'unknown');
    const options = await generateAuthenticationOptions({
      rpID: this.ctx.env.WEBAUTHN_RP_ID,
      userVerification: 'required',
    });
    const challengeId = await this.storeChallenge({ challenge: options.challenge, kind: 'login' });
    return { challengeId, options };
  }

  async verifyPasskeyLogin(
    input: { challengeId: string; response: Record<string, unknown>; deviceName: string },
    meta: RequestMeta,
  ): Promise<TokenResponse> {
    const stored = await this.takeChallenge(input.challengeId, 'login');
    const response = input.response as unknown as AuthenticationResponseJSON;
    const passkey = await this.db.passkey.findUnique({
      where: { credentialId: String(response.id ?? '') },
      include: { user: true },
    });
    if (!passkey || passkey.user.status !== 'active') throw unauthorized('This passkey is not registered');
    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.ctx.env.WEBAUTHN_ORIGINS,
      expectedRPID: this.ctx.env.WEBAUTHN_RP_ID,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(passkey.publicKey),
        counter: Number(passkey.counter),
        transports: passkey.transports,
      },
      requireUserVerification: true,
    }).catch(() => null);
    if (!verification?.verified) {
      await audit(this.db, {
        userId: passkey.userId,
        type: 'auth.login_failed',
        meta,
        metadata: { step: 'passkey' },
      });
      throw unauthorized('Passkey sign-in failed');
    }
    const newCounter = BigInt(verification.authenticationInfo.newCounter);
    // A counter that doesn't increase means the authenticator may have been cloned.
    if ((passkey.counter > 0n || newCounter > 0n) && newCounter <= passkey.counter) {
      await audit(this.db, {
        userId: passkey.userId,
        type: 'auth.login_failed',
        meta,
        metadata: { step: 'passkey-counter' },
      });
      throw unauthorized('Passkey sign-in failed');
    }
    await this.db.passkey.update({
      where: { id: passkey.id },
      data: { counter: newCounter, lastUsedAt: new Date() },
    });
    return this.issueSession(passkey.userId, input.deviceName, 'passkey', meta);
  }

  async listPasskeys(userId: string) {
    const passkeys = await this.db.passkey.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
    return passkeys.map((passkey) => ({
      id: passkey.id,
      nickname: passkey.nickname,
      deviceType: passkey.deviceType,
      backedUp: passkey.backedUp,
      createdAt: passkey.createdAt.toISOString(),
      lastUsedAt: passkey.lastUsedAt?.toISOString() ?? null,
    }));
  }

  async removePasskey(userId: string, passkeyId: string, meta: RequestMeta): Promise<void> {
    const result = await this.db.passkey.deleteMany({ where: { id: passkeyId, userId } });
    if (result.count === 0) throw notFound('Passkey not found');
    await audit(this.db, { userId, type: 'auth.passkey_removed', meta, metadata: { passkeyId } });
  }
}
