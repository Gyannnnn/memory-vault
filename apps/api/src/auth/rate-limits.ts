import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { tooManyRequests } from '../http/errors';

export type RateLimits = ReturnType<typeof createRateLimits>;

export function createRateLimits(redis: Redis, prefix = 'rl') {
  const limiter = (name: string, points: number, duration: number, blockDuration = 0) =>
    new RateLimiterRedis({
      storeClient: redis,
      keyPrefix: `${prefix}:${name}`,
      points,
      duration,
      blockDuration,
    });
  return {
    loginByIp: limiter('login-ip', 30, 15 * 60),
    loginByAccount: limiter('login-account', 5, 15 * 60, 15 * 60),
    mfaByUser: limiter('mfa-user', 5, 5 * 60, 15 * 60),
    recoveryByAccount: limiter('recovery-account', 5, 60 * 60, 60 * 60),
    refreshByIp: limiter('refresh-ip', 120, 60),
    passkeyByIp: limiter('passkey-ip', 30, 15 * 60),
    /** Wrong passwords on one share link from one address. */
    shareUnlock: limiter('share-unlock', 10, 15 * 60, 15 * 60),
    /** Everything a visitor asks of share links, per address. */
    shareByIp: limiter('share-ip', 600, 60),
  };
}

export async function consume(limiter: RateLimiterRedis, key: string): Promise<void> {
  try {
    await limiter.consume(key);
  } catch (error) {
    if (error instanceof RateLimiterRes) throw tooManyRequests(Math.ceil(error.msBeforeNext / 1000));
    throw error;
  }
}

export async function reset(limiter: RateLimiterRedis, key: string): Promise<void> {
  await limiter.delete(key);
}
