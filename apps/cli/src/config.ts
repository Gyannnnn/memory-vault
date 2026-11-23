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
  mlUrl: fromEnv('VAULT_ML_URL') ?? 'http://127.0.0.1:8090',
  containerPathMap: fromEnv('VAULT_CONTAINER_PATH_MAP') ?? '',
};

/** Where a host path appears inside the Docker services (sources are mounted read-only). */
export function containerPath(hostPath: string): string | null {
  for (const pair of config.containerPathMap.split(';').filter(Boolean)) {
    const [host, container] = pair.split('=');
    if (host && container && (hostPath === host || hostPath.startsWith(`${host}/`))) {
      return `${container}${hostPath.slice(host.length)}`;
    }
  }
  return null;
}

export const manifestPath = () => join(config.dataDir, 'manifest.db');
