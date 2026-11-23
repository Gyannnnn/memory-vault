import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

type Env = Map<string, string>;

function parse(text: string): Env {
  const env: Env = new Map();
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env.set(match[1]!, match[2]!);
  }
  return env;
}

function ensureEnvFile(dir: string): { path: string; env: Env } {
  const path = join(root, dir, '.env');
  const examplePath = join(root, dir, '.env.example');
  if (!existsSync(path)) {
    writeFileSync(path, readFileSync(examplePath, 'utf8'), { mode: 0o600 });
    console.log(`created ${join(dir, '.env')}`);
  }
  return { path, env: parse(readFileSync(path, 'utf8')) };
}

function fill(path: string, values: Record<string, string>): void {
  const current = parse(readFileSync(path, 'utf8'));
  let text = readFileSync(path, 'utf8');
  const filled: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (current.get(key)) continue;
    if (current.has(key)) {
      text = text.replace(new RegExp(`^${key}=.*$`, 'm'), () => `${key}=${value}`);
    } else {
      text += `${text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
    }
    filled.push(key);
  }
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  if (filled.length > 0) console.log(`  ${path.replace(`${root}/`, '')}: set ${filled.join(', ')}`);
}

const secret = (bytes = 32) => randomBytes(bytes).toString('base64url');
const b64 = (pem: string) => Buffer.from(pem).toString('base64');

const rootEnv = ensureEnvFile('.');
fill(rootEnv.path, {
  POSTGRES_PASSWORD: secret(),
  VAULT_APP_DB_PASSWORD: secret(),
  REDIS_PASSWORD: secret(),
  VAULT_STAGING_DIR: join(homedir(), 'vault-staging'),
});
const compose = parse(readFileSync(rootEnv.path, 'utf8'));

const api = ensureEnvFile('apps/api');
const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const pathMap = [
  compose.get('VAULT_LAPTOP_SOURCE_DIR')
    ? `${compose.get('VAULT_LAPTOP_SOURCE_DIR')}=/mnt/sources/laptop`
    : '',
  compose.get('VAULT_STAGING_DIR') ? `${compose.get('VAULT_STAGING_DIR')}=/mnt/sources/staging` : '',
]
  .filter(Boolean)
  .join(';');
const apiValues: Record<string, string> = {
  DATABASE_URL: `postgresql://vault_app:${compose.get('VAULT_APP_DB_PASSWORD')}@localhost:5432/vault`,
  DATABASE_MIGRATE_URL: `postgresql://vault:${compose.get('POSTGRES_PASSWORD')}@localhost:5432/vault`,
  REDIS_URL: `redis://:${compose.get('REDIS_PASSWORD')}@localhost:6379`,
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
};
if (!api.env.get('JWT_PRIVATE_KEY') && !api.env.get('JWT_PUBLIC_KEY')) {
  apiValues.JWT_PRIVATE_KEY = b64(privateKey);
  apiValues.JWT_PUBLIC_KEY = b64(publicKey);
}
if (pathMap) apiValues.LOCAL_PATH_MAP = pathMap;
fill(api.path, apiValues);

const cli = ensureEnvFile('apps/cli');
fill(cli.path, { VAULT_STAGING_DIR: compose.get('VAULT_STAGING_DIR') ?? '' });

console.log('done — existing values were left untouched');
