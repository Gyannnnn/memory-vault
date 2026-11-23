import { Secret, TOTP } from 'otpauth';

const PERIOD_SECONDS = 30;

function totp(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: 'Memory Vault',
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD_SECONDS,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export function totpUri(secretBase32: string, label: string): string {
  return totp(secretBase32, label).toString();
}

export function currentTotpCode(secretBase32: string, timestamp = Date.now()): string {
  return totp(secretBase32, '').generate({ timestamp });
}

/**
 * Returns the time step the code belongs to, or null. A step at or before
 * `lastUsedStep` is rejected so a code can't be replayed within its window.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastUsedStep: bigint | null,
  timestamp = Date.now(),
): bigint | null {
  const delta = totp(secretBase32, '').validate({ token: code, window: 1, timestamp });
  if (delta === null) return null;
  const step = BigInt(Math.floor(timestamp / 1000 / PERIOD_SECONDS) + delta);
  if (lastUsedStep !== null && step <= lastUsedStep) return null;
  return step;
}
