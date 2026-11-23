import { randomUUID } from 'node:crypto';
import { importPKCS8, importSPKI, jwtVerify, SignJWT, type CryptoKey } from 'jose';

const AUDIENCE = 'memory-vault';
export const ACCESS_TOKEN_SECONDS = 10 * 60;
const MFA_TOKEN_SECONDS = 5 * 60;

export interface TokenKeys {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  issuer: string;
}

const pem = (base64: string) => Buffer.from(base64, 'base64').toString('utf8');

export async function loadTokenKeys(
  privateKeyB64: string,
  publicKeyB64: string,
  issuer: string,
): Promise<TokenKeys> {
  return {
    privateKey: await importPKCS8(pem(privateKeyB64), 'EdDSA'),
    publicKey: await importSPKI(pem(publicKeyB64), 'EdDSA'),
    issuer,
  };
}

export async function signAccessToken(
  keys: TokenKeys,
  claims: { userId: string; sessionId: string },
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + ACCESS_TOKEN_SECONDS * 1000);
  const token = await new SignJWT({ sid: claims.sessionId, typ: 'access' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(claims.userId)
    .setIssuer(keys.issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(keys.privateKey);
  return { token, expiresAt };
}

export async function verifyAccessToken(
  keys: TokenKeys,
  token: string,
): Promise<{ userId: string; sessionId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: keys.issuer,
      audience: AUDIENCE,
      algorithms: ['EdDSA'],
    });
    if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string')
      return null;
    return { userId: payload.sub, sessionId: payload.sid };
  } catch {
    return null;
  }
}

/** Proof that the password step passed; exchanged together with a TOTP code for a session. */
export async function signMfaToken(keys: TokenKeys, userId: string): Promise<string> {
  return new SignJWT({ typ: 'mfa' })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(userId)
    .setJti(randomUUID())
    .setIssuer(keys.issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${MFA_TOKEN_SECONDS}s`)
    .sign(keys.privateKey);
}

export async function verifyMfaToken(
  keys: TokenKeys,
  token: string,
): Promise<{ userId: string; tokenId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, keys.publicKey, {
      issuer: keys.issuer,
      audience: AUDIENCE,
      algorithms: ['EdDSA'],
    });
    if (payload.typ !== 'mfa' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string')
      return null;
    return { userId: payload.sub, tokenId: payload.jti };
  } catch {
    return null;
  }
}
