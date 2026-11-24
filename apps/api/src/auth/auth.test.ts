import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bearer, createHarness, PASSWORD, signIn, signUp, type Harness } from '../../test/helpers';
import { SoftAuthenticator } from '../../test/soft-authenticator';
import { currentTotpCode, verifyTotp } from './totp';

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});
afterAll(async () => {
  await harness.close();
});
beforeEach(async () => {
  await harness.reset();
});

const api = () => request(harness.app);

describe('password + TOTP sign-in', () => {
  it('issues tokens only after both factors and the access token works', async () => {
    const user = await signUp(harness, 'a@example.com');
    const me = await api().get('/v1/me').set(bearer(user.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('a@example.com');
  });

  it('rejects a wrong password without revealing whether the account exists', async () => {
    await signUp(harness, 'a@example.com');
    const wrong = await api()
      .post('/v1/auth/login/password')
      .send({ email: 'a@example.com', password: 'nope' });
    const missing = await api()
      .post('/v1/auth/login/password')
      .send({ email: 'b@example.com', password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(wrong.body.error.message).toBe(missing.body.error.message);
  });

  it('rejects a replayed TOTP code', async () => {
    const user = await signUp(harness, 'a@example.com');
    const step = await api().post('/v1/auth/login/password').send({ email: user.email, password: PASSWORD });
    const replay = await api()
      .post('/v1/auth/login/totp')
      .send({ mfaToken: step.body.mfaToken, code: currentTotpCode(user.totpSecret), deviceName: 'replay' });
    expect(replay.status).toBe(401);
  });

  it('locks an account after repeated wrong passwords', async () => {
    await signUp(harness, 'a@example.com');
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await api()
        .post('/v1/auth/login/password')
        .send({ email: 'a@example.com', password: 'nope' });
      statuses.push(response.status);
    }
    expect(statuses.slice(0, 4).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    const correct = await api()
      .post('/v1/auth/login/password')
      .send({ email: 'a@example.com', password: PASSWORD });
    expect(correct.status).toBe(429);
  });
});

describe('recovery codes', () => {
  it('each code signs in exactly once, with spacing and case ignored', async () => {
    const user = await signUp(harness, 'a@example.com');
    const code = user.recoveryCodes[0]!;
    const sloppy = code.toLowerCase().replace(/-/g, ' ');
    const first = await api()
      .post('/v1/auth/login/recovery')
      .send({ email: user.email, recoveryCode: sloppy, deviceName: 'new phone' });
    expect(first.status).toBe(200);
    expect(first.body.recoveryUsed).toBe(true);
    const second = await api()
      .post('/v1/auth/login/recovery')
      .send({ email: user.email, recoveryCode: code, deviceName: 'again' });
    expect(second.status).toBe(401);
    const other = await api()
      .post('/v1/auth/login/recovery')
      .send({ email: user.email, recoveryCode: user.recoveryCodes[1], deviceName: 'third' });
    expect(other.status).toBe(200);
  });

  it('stores only hashes', async () => {
    const user = await signUp(harness, 'a@example.com');
    const rows = await harness.ctx.db.recoveryCode.findMany({ where: { userId: user.userId } });
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.hash.startsWith('$argon2id$')).toBe(true);
      expect(user.recoveryCodes.some((code) => row.hash.includes(code))).toBe(false);
    }
  });
});

describe('sessions', () => {
  it('rotates refresh tokens and revokes the session when an old one is reused', async () => {
    const user = await signUp(harness, 'a@example.com');
    const rotated = await api().post('/v1/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(rotated.status).toBe(200);
    expect(rotated.body.refreshToken).not.toBe(user.refreshToken);

    // Outside the 30-second grace window an old token means it was copied.
    await harness.ctx.redis.flushdb();
    await harness.ctx.db.refreshToken.updateMany({
      where: { sessionId: user.sessionId, usedAt: { not: null } },
      data: { usedAt: new Date(Date.now() - 60_000) },
    });
    const reuse = await api().post('/v1/auth/refresh').send({ refreshToken: user.refreshToken });
    expect(reuse.status).toBe(401);
    const afterReuse = await api().post('/v1/auth/refresh').send({ refreshToken: rotated.body.refreshToken });
    expect(afterReuse.status).toBe(401);
    const access = await api().get('/v1/me').set(bearer(rotated.body.accessToken));
    expect(access.status).toBe(401);
    const events = await harness.ctx.db.auditEvent.findMany({
      where: { type: 'auth.refresh_reuse_detected' },
    });
    expect(events).toHaveLength(1);
  });

  it('answers simultaneous refreshes with the same tokens instead of revoking the session', async () => {
    const user = await signUp(harness, 'a@example.com');
    const [first, second, third] = await Promise.all(
      [1, 2, 3].map(() => api().post('/v1/auth/refresh').send({ refreshToken: user.refreshToken })),
    );
    expect([first!.status, second!.status, third!.status]).toEqual([200, 200, 200]);
    expect(
      new Set([first!.body.refreshToken, second!.body.refreshToken, third!.body.refreshToken]).size,
    ).toBe(1);
    expect((await api().get('/v1/me').set(bearer(first!.body.accessToken))).status).toBe(200);
    const next = await api().post('/v1/auth/refresh').send({ refreshToken: first!.body.refreshToken });
    expect(next.status).toBe(200);
  });

  it('signing out a device stops its access token immediately', async () => {
    const user = await signUp(harness, 'a@example.com');
    const laptop = await signIn(harness, user.email, user.totpSecret).catch(async () => {
      await harness.ctx.db.totpCredential.update({
        where: { userId: user.userId },
        data: { lastUsedStep: null },
      });
      return signIn(harness, user.email, user.totpSecret);
    });
    const list = await api().get('/v1/auth/sessions').set(bearer(user.accessToken));
    expect(list.body.sessions).toHaveLength(2);
    const remove = await api().delete(`/v1/auth/sessions/${laptop.sessionId}`).set(bearer(user.accessToken));
    expect(remove.status).toBe(204);
    expect((await api().get('/v1/me').set(bearer(laptop.accessToken))).status).toBe(401);
    expect((await api().get('/v1/me').set(bearer(user.accessToken))).status).toBe(200);
  });

  it('rejects requests without a valid token', async () => {
    expect((await api().get('/v1/me')).status).toBe(401);
    expect((await api().get('/v1/me').set(bearer('not-a-token'))).status).toBe(401);
  });
});

describe('passkeys', () => {
  it('registers a passkey and signs in with it, rejecting a counter that goes backwards', async () => {
    const user = await signUp(harness, 'a@example.com');
    const authenticator = new SoftAuthenticator();

    const options = await api().post('/v1/auth/passkeys/register/options').set(bearer(user.accessToken));
    expect(options.status).toBe(200);
    const registered = await api()
      .post('/v1/auth/passkeys/register/verify')
      .set(bearer(user.accessToken))
      .send({
        challengeId: options.body.challengeId,
        response: authenticator.register(options.body.options),
        nickname: 'Pixel',
      });
    expect(registered.status).toBe(201);

    const login = await api().post('/v1/auth/login/passkey/options');
    const verified = await api()
      .post('/v1/auth/login/passkey/verify')
      .send({
        challengeId: login.body.challengeId,
        response: authenticator.authenticate(login.body.options),
        deviceName: 'phone',
      });
    expect(verified.status).toBe(200);
    expect(verified.body.user.email).toBe('a@example.com');

    const cloned = await api().post('/v1/auth/login/passkey/options');
    const replayed = await api()
      .post('/v1/auth/login/passkey/verify')
      .send({
        challengeId: cloned.body.challengeId,
        response: authenticator.authenticate(cloned.body.options, 1),
        deviceName: 'clone',
      });
    expect(replayed.status).toBe(401);
  });

  it('refuses a challenge that was already used', async () => {
    const user = await signUp(harness, 'a@example.com');
    const authenticator = new SoftAuthenticator();
    const options = await api().post('/v1/auth/passkeys/register/options').set(bearer(user.accessToken));
    const body = {
      challengeId: options.body.challengeId,
      response: authenticator.register(options.body.options),
      nickname: 'Key',
    };
    expect(
      (await api().post('/v1/auth/passkeys/register/verify').set(bearer(user.accessToken)).send(body)).status,
    ).toBe(201);
    expect(
      (await api().post('/v1/auth/passkeys/register/verify').set(bearer(user.accessToken)).send(body)).status,
    ).toBe(401);
  });
});

describe('security settings (step-up required)', () => {
  const nextStepCode = (secret: string) => currentTotpCode(secret, Date.now() + 30_000);

  it('regenerates recovery codes only with the password and a second factor', async () => {
    const user = await signUp(harness, 'a@example.com');
    const wrong = await api()
      .post('/v1/auth/recovery-codes')
      .set(bearer(user.accessToken))
      .send({ password: 'wrong password!!', code: nextStepCode(user.totpSecret) });
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('step_up_failed');

    const viaRecovery = await api()
      .post('/v1/auth/recovery-codes')
      .set(bearer(user.accessToken))
      .send({ password: PASSWORD, recoveryCode: user.recoveryCodes[0] });
    expect(viaRecovery.status).toBe(200);
    expect(viaRecovery.body.codes).toHaveLength(10);

    const oldCode = await api()
      .post('/v1/auth/login/recovery')
      .send({ email: user.email, recoveryCode: user.recoveryCodes[1], deviceName: 'x' });
    expect(oldCode.status).toBe(401);
    const newCode = await api()
      .post('/v1/auth/login/recovery')
      .send({ email: user.email, recoveryCode: viaRecovery.body.codes[0], deviceName: 'x' });
    expect(newCode.status).toBe(200);
  });

  it('replaces the authenticator only after a code from the new one is confirmed', async () => {
    const user = await signUp(harness, 'a@example.com');
    const started = await api()
      .post('/v1/auth/totp/enroll')
      .set(bearer(user.accessToken))
      .send({ password: PASSWORD, recoveryCode: user.recoveryCodes[0] });
    expect(started.status).toBe(200);
    const newSecret = started.body.secret as string;
    expect(started.body.uri).toContain('otpauth://totp/');

    const bad = await api()
      .post('/v1/auth/totp/confirm')
      .set(bearer(user.accessToken))
      .send({ code: '000000' });
    expect(bad.status).toBe(400);
    const confirmed = await api()
      .post('/v1/auth/totp/confirm')
      .set(bearer(user.accessToken))
      .send({ code: currentTotpCode(newSecret) });
    expect(confirmed.status).toBe(204);

    const stored = await harness.ctx.db.totpCredential.findUniqueOrThrow({ where: { userId: user.userId } });
    expect(
      verifyTotp(newSecret, nextStepCode(newSecret), stored.lastUsedStep, Date.now() + 30_000),
    ).not.toBeNull();
    const password = await api()
      .post('/v1/auth/login/password')
      .send({ email: user.email, password: PASSWORD });
    const oldApp = await api()
      .post('/v1/auth/login/totp')
      .send({ mfaToken: password.body.mfaToken, code: nextStepCode(user.totpSecret), deviceName: 'x' });
    expect(oldApp.status).toBe(401);
  });

  it('renames a passkey only for its owner', async () => {
    const user = await signUp(harness, 'a@example.com');
    const other = await signUp(harness, 'b@example.com');
    const authenticator = new SoftAuthenticator();
    const options = await api().post('/v1/auth/passkeys/register/options').set(bearer(user.accessToken));
    const created = await api()
      .post('/v1/auth/passkeys/register/verify')
      .set(bearer(user.accessToken))
      .send({
        challengeId: options.body.challengeId,
        response: authenticator.register(options.body.options),
        nickname: 'Key',
      });
    const id = created.body.id as string;
    expect(
      (await api().patch(`/v1/auth/passkeys/${id}`).set(bearer(other.accessToken)).send({ nickname: 'Mine' }))
        .status,
    ).toBe(404);
    expect(
      (
        await api()
          .patch(`/v1/auth/passkeys/${id}`)
          .set(bearer(user.accessToken))
          .send({ nickname: 'YubiKey 5C' })
      ).status,
    ).toBe(204);
    const list = await api().get('/v1/auth/passkeys').set(bearer(user.accessToken));
    expect(list.body.passkeys[0].nickname).toBe('YubiKey 5C');
  });

  it('describes only the signed-in account', async () => {
    const user = await signUp(harness, 'a@example.com');
    await signUp(harness, 'b@example.com');
    expect((await api().get('/v1/auth/me')).status).toBe(401);
    const me = await api().get('/v1/auth/me').set(bearer(user.accessToken));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      id: user.userId,
      email: user.email,
      passkeyCount: 0,
      recoveryCodesLeft: 10,
    });
    expect(me.body.totpEnrolledAt).not.toBeNull();
  });
});
