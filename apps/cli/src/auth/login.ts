import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { emailSchema, formatBytes } from '@memory-vault/shared';
import { apiClient, deviceName, fileTokenStore } from './credentials';

export async function prompt(question: string, options: { hidden?: boolean } = {}): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  const pending = rl.question(question);
  muted = Boolean(options.hidden);
  const answer = await pending;
  rl.close();
  if (options.hidden) process.stdout.write('\n');
  return answer.trim();
}

export async function login(options: { recovery?: boolean }): Promise<void> {
  const api = apiClient();
  const email = emailSchema.parse(await prompt('Email: '));
  if (options.recovery) {
    const code = await prompt('Recovery code: ', { hidden: true });
    const session = await api.loginWithRecoveryCode(email, code, deviceName());
    console.log(`Signed in as ${session.user.email} with a recovery code. That code no longer works.`);
    console.log('Generate fresh codes soon: pnpm vault-admin recovery-codes <email>');
    return;
  }
  const password = await prompt('Password: ', { hidden: true });
  const { mfaToken } = await api.loginWithPassword(email, password);
  const code = await prompt('6-digit code from your authenticator app: ');
  const session = await api.loginWithTotp(mfaToken, code, deviceName());
  const me = await api.me();
  console.log(
    `Signed in as ${session.user.email}. Using ${formatBytes(Number(me.storageUsedBytes))} of ${formatBytes(Number(me.storageQuotaBytes))}.`,
  );
}

export async function logout(): Promise<void> {
  if (!fileTokenStore.load()) {
    console.log('Not signed in.');
    return;
  }
  await apiClient()
    .logout()
    .catch(() => fileTokenStore.clear());
  console.log('Signed out on this computer.');
}
