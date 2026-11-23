import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createApiClient, type StoredTokens, type TokenStore } from '@memory-vault/api-client';
import { config } from '../config';

const credentialsPath = () =>
  join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'memory-vault', 'credentials.json');

interface CredentialsFile {
  apiUrl: string;
  tokens: StoredTokens;
}

/** Tokens live in a 0600 file and are replaced atomically, so a crash never leaves a half-written refresh token. */
export const fileTokenStore: TokenStore = {
  load() {
    const path = credentialsPath();
    if (!existsSync(path)) return null;
    const file = JSON.parse(readFileSync(path, 'utf8')) as CredentialsFile;
    return file.apiUrl === config.apiUrl ? file.tokens : null;
  },
  save(tokens) {
    const path = credentialsPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ apiUrl: config.apiUrl, tokens } satisfies CredentialsFile), {
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  },
  clear() {
    rmSync(credentialsPath(), { force: true });
  },
};

export const deviceName = () => `vault CLI on ${hostname()}`;

export function apiClient() {
  return createApiClient({ baseUrl: config.apiUrl, tokens: fileTokenStore, userAgent: 'memory-vault-cli' });
}
