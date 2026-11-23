import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '../..');

const envFile = join(cliRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

function fromEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

export const config = {
  apiUrl: fromEnv('VAULT_API_URL') ?? 'http://localhost:4000',
  dataDir: fromEnv('VAULT_DATA_DIR') ?? join(homedir(), '.local/share/memory-vault'),
  stagingDir: fromEnv('VAULT_STAGING_DIR') ?? join(homedir(), 'vault-staging'),
  reportsDir: fromEnv('VAULT_REPORTS_DIR') ?? join(repoRoot, 'reports'),
  adbPath: fromEnv('VAULT_ADB_PATH'),
};

export const manifestPath = () => join(config.dataDir, 'manifest.db');
