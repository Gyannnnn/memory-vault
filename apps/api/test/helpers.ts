import type { Express } from 'express';
import request from 'supertest';
import { AuthService } from '../src/auth/service';
import { currentTotpCode } from '../src/auth/totp';
import { closeContext, createContext, type AppContext } from '../src/context';
import { createDb, type Db } from '../src/db';
import { env, resetEnvForTests } from '../src/env';
import { createApp } from '../src/http/app';
import type { IngestJob, Jobs } from '../src/workers/queues';

export const PASSWORD = 'correct horse battery staple';

export class FakeJobs implements Jobs {
  readonly ingested: IngestJob[] = [];
  ingest(job: IngestJob): Promise<void> {
    this.ingested.push(job);
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export interface Harness {
  ctx: AppContext;
  app: Express;
  jobs: FakeJobs;
  auth: AuthService;
  /** Owner connection (bypasses row-level security): for fixtures such as reference data. */
  owner: Db;
  reset(): Promise<void>;
  close(): Promise<void>;
}

const TABLES = [
  'usage_snapshots',
  'upload_sessions',
  'asset_origins',
  'file_entries',
  'folders',
  'derivatives',
  'assets',
  'audit_events',
  'refresh_tokens',
  'sessions',
  'passkeys',
  'recovery_codes',
  'totp_credentials',
  'password_credentials',
  'users',
  'places',
];

export async function createHarness(): Promise<Harness> {
  resetEnvForTests();
  const jobs = new FakeJobs();
  const ctx = await createContext(env(), { jobs });
  const owner = createDb(env().DATABASE_MIGRATE_URL!);
  return {
    ctx,
    app: createApp(ctx),
    jobs,
    auth: new AuthService(ctx),
    owner,
    async reset() {
      await owner.$executeRawUnsafe(`TRUNCATE ${TABLES.join(', ')} CASCADE`);
      await ctx.redis.flushdb();
      jobs.ingested.length = 0;
    },
    async close() {
      await owner.$disconnect();
      await closeContext(ctx);
    },
  };
}

export interface SignedInUser {
  userId: string;
  email: string;
  totpSecret: string;
  recoveryCodes: string[];
  accessToken: string;
  refreshToken: string;
  sessionId: string;
}

export async function signUp(harness: Harness, email: string): Promise<SignedInUser> {
  const { userId, totpSecret } = await harness.auth.createUser({
    email,
    displayName: email,
    password: PASSWORD,
  });
  await harness.auth.confirmTotp(userId, currentTotpCode(totpSecret));
  // Confirming used this time step; clear it so the sign-in below can use a fresh code.
  await harness.ctx.db.totpCredential.update({ where: { userId }, data: { lastUsedStep: null } });
  const recoveryCodes = await harness.auth.generateRecoveryCodes(userId);
  const tokens = await signIn(harness, email, totpSecret);
  return { userId, email, totpSecret, recoveryCodes, ...tokens };
}

export async function signIn(harness: Harness, email: string, totpSecret: string) {
  const password = await request(harness.app)
    .post('/v1/auth/login/password')
    .send({ email, password: PASSWORD });
  if (password.status !== 200) throw new Error(`password step failed: ${password.status} ${password.text}`);
  const totp = await request(harness.app)
    .post('/v1/auth/login/totp')
    .send({ mfaToken: password.body.mfaToken, code: currentTotpCode(totpSecret), deviceName: 'test' });
  if (totp.status !== 200) throw new Error(`totp step failed: ${totp.status} ${totp.text}`);
  return totp.body as { accessToken: string; refreshToken: string; sessionId: string };
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
