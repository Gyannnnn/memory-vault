import type { S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import pino, { type Logger } from 'pino';
import { createRateLimits, type RateLimits } from './auth/rate-limits';
import { loadTokenKeys, type TokenKeys } from './auth/tokens';
import { createDb, type Db } from './db';
import type { AppEnv } from './env';
import { createS3Client } from './storage/aws';
import type { Jobs } from './workers/queues';

export interface AppContext {
  env: AppEnv;
  db: Db;
  redis: Redis;
  s3: S3Client;
  keys: TokenKeys;
  limits: RateLimits;
  logger: Logger;
  jobs?: Jobs | undefined;
}

export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

export function createLogger(env: Pick<AppEnv, 'NODE_ENV'>): Logger {
  return pino({
    level: env.NODE_ENV === 'test' ? 'silent' : 'info',
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.refreshToken',
      '*.recoveryCode',
    ],
  });
}

export async function createContext(env: AppEnv, overrides: Partial<AppContext> = {}): Promise<AppContext> {
  const redis = overrides.redis ?? createRedis(env.REDIS_URL);
  return {
    env,
    db: overrides.db ?? createDb(env.DATABASE_URL),
    redis,
    s3: overrides.s3 ?? createS3Client(env),
    keys:
      overrides.keys ?? (await loadTokenKeys(env.JWT_PRIVATE_KEY, env.JWT_PUBLIC_KEY, env.API_PUBLIC_URL)),
    limits: overrides.limits ?? createRateLimits(redis),
    logger: overrides.logger ?? createLogger(env),
    jobs: overrides.jobs,
  };
}

export async function closeContext(context: AppContext): Promise<void> {
  await context.jobs?.close();
  await context.db.$disconnect();
  context.redis.disconnect();
  context.s3.destroy();
}
