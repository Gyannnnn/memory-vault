import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 } as const;

export const hashSecret = (secret: string) => argon2.hash(secret, ARGON2_OPTIONS);

export async function verifySecret(hash: string, secret: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, secret);
  } catch {
    return false;
  }
}

/** Equalises timing when an account doesn't exist, so responses don't reveal which emails are registered. */
let dummyHash: Promise<string> | undefined;
export async function burnVerifyTime(secret: string): Promise<void> {
  dummyHash ??= hashSecret('memory-vault-dummy-password');
  await verifySecret(await dummyHash, secret);
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256Hex = (value: string) => createHash('sha256').update(value).digest('hex');

/** AES-256-GCM with a random 12-byte nonce; output is nonce ‖ tag ‖ ciphertext. */
export function encrypt(plaintext: Buffer, keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(sealed: Uint8Array, keyBase64: string): Buffer {
  const buffer = Buffer.from(sealed);
  const key = Buffer.from(keyBase64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
  decipher.setAuthTag(buffer.subarray(12, 28));
  return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]);
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 20 Crockford base32 characters = 100 bits, shown as XXXXX-XXXXX-XXXXX-XXXXX. */
export function generateRecoveryCode(): string {
  const characters = Array.from({ length: 20 }, () => CROCKFORD[randomInt(CROCKFORD.length)]!).join('');
  return characters.match(/.{5}/g)!.join('-');
}

export function normalizeRecoveryCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}
