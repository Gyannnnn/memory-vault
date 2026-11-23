import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Command } from 'commander';
import qrcode from 'qrcode-terminal';
import { emailSchema, passwordSchema } from '@memory-vault/shared';
import { AuthService } from '../auth/service';
import { closeContext, createContext } from '../context';
import { env } from '../env';

async function ask(question: string, options: { hidden?: boolean } = {}): Promise<string> {
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

async function withAuth<T>(work: (auth: AuthService) => Promise<T>): Promise<T> {
  const context = await createContext(env());
  try {
    return await work(new AuthService(context));
  } finally {
    await closeContext(context);
  }
}

function printRecoveryCodes(codes: string[]): void {
  console.log('\nRecovery codes — print these and keep them somewhere safe and offline.');
  console.log('Each works once and lets you in even without your password, phone or email.\n');
  codes.forEach((code, index) => console.log(`  ${String(index + 1).padStart(2)}. ${code}`));
  console.log('\nThey are shown only now.\n');
}

const program = new Command().name('vault-admin').description('Memory Vault administration');

program
  .command('create-user')
  .description('Create an account with password, authenticator app and recovery codes')
  .action(async () => {
    const email = emailSchema.parse(await ask('Email: '));
    const displayName = (await ask('Display name: ')) || email;
    const password = await ask('Password (12+ characters): ', { hidden: true });
    passwordSchema.parse(password);
    if ((await ask('Repeat password: ', { hidden: true })) !== password)
      throw new Error('Passwords do not match');

    await withAuth(async (auth) => {
      const { userId, totpSecret, totpUri } = await auth.createUser({ email, displayName, password });
      console.log('\nScan this with your authenticator app (e.g. Aegis, 2FAS, Google Authenticator):\n');
      qrcode.generate(totpUri, { small: true });
      console.log(`Or enter the key manually: ${totpSecret.match(/.{1,4}/g)!.join(' ')}\n`);
      for (let attempt = 1; ; attempt += 1) {
        try {
          await auth.confirmTotp(userId, await ask('6-digit code from the app: '));
          break;
        } catch (error) {
          if (attempt >= 5) throw error;
          console.log(error instanceof Error ? error.message : String(error));
        }
      }
      printRecoveryCodes(await auth.generateRecoveryCodes(userId));
      console.log(`Account ${email} is ready. Sign in from the CLI with: pnpm vault login`);
    });
  });

program
  .command('recovery-codes')
  .description('Replace all recovery codes for an account (old ones stop working)')
  .argument('<email>')
  .action(async (rawEmail: string) => {
    const email = emailSchema.parse(rawEmail);
    await withAuth(async (auth) => {
      const context = await createContext(env());
      try {
        const user = await context.db.user.findUniqueOrThrow({ where: { email } });
        printRecoveryCodes(await auth.generateRecoveryCodes(user.id));
      } finally {
        await closeContext(context);
      }
    });
  });

program.parseAsync().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
