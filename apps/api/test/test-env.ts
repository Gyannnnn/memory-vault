import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function rootEnv(): Record<string, string> {
  const path = join(repoRoot, '.env');
  if (!existsSync(path))
    throw new Error('Run `pnpm secrets:init` and `docker compose --profile test up -d` first');
  return Object.fromEntries(
    readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => /^([A-Z0-9_]+)=(.*)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => [match[1]!, match[2]!]),
  );
}

const keys = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export function testEnv(): Record<string, string> {
  const root = rootEnv();
  const pgPort = root.VAULT_PG_PORT ?? '5433';
  const redisPort = root.VAULT_REDIS_PORT ?? '6379';
  return {
    NODE_ENV: 'test',
    API_PUBLIC_URL: 'http://localhost:4000',
    DATABASE_URL: `postgresql://vault_app:${root.VAULT_APP_DB_PASSWORD}@localhost:${pgPort}/vault_test`,
    DATABASE_MIGRATE_URL: `postgresql://vault:${root.POSTGRES_PASSWORD}@localhost:${pgPort}/vault_test`,
    REDIS_URL: `redis://:${root.REDIS_PASSWORD}@localhost:${redisPort}/1`,
    AWS_REGION: 'ap-south-1',
    S3_BUCKET: 'vault-test',
    S3_ENDPOINT: 'http://localhost:7070',
    S3_FORCE_PATH_STYLE: 'true',
    SQS_S3_EVENTS_QUEUE_URL: '',
    AWS_ACCESS_KEY_ID: 'test-access-key',
    AWS_SECRET_ACCESS_KEY: 'test-secret-key',
    JWT_PRIVATE_KEY: Buffer.from(keys.privateKey).toString('base64'),
    JWT_PUBLIC_KEY: Buffer.from(keys.publicKey).toString('base64'),
    DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_RP_NAME: 'Memory Vault',
    WEBAUTHN_ORIGINS: 'http://localhost:3000',
    SIGNUP_MODE: 'closed',
    DEFAULT_QUOTA_BYTES: String(10 * 1024 ** 3),
    LOCAL_PATH_MAP: '',
  };
}
