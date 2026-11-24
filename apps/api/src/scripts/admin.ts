import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { Command } from 'commander';
import qrcode from 'qrcode-terminal';
import { emailSchema, passwordSchema } from '@memory-vault/shared';
import { AuthService } from '../auth/service';
import { closeContext, createContext } from '../context';
import { createDb } from '../db';
import { env } from '../env';
import { geocodeAllAssets, parsePlaces, readGeonames, savePlaces } from '../places/geonames';
import { runCatalogExport, runDatabaseBackup, runIntegrityCheck } from '../workers/maintenance';
import { createJobs } from '../workers/queues';
import { rebuildIndex } from '../workers/rebuild';

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
    const systemZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezone = (await ask(`Time zone for photos without one [${systemZone}]: `)) || systemZone;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    } catch {
      throw new Error(`Unknown time zone ${timezone}; use an IANA name like Asia/Kolkata`);
    }
    const password = await ask('Password (12+ characters): ', { hidden: true });
    passwordSchema.parse(password);
    if ((await ask('Repeat password: ', { hidden: true })) !== password)
      throw new Error('Passwords do not match');

    await withAuth(async (auth) => {
      const { userId, totpSecret, totpUri } = await auth.createUser({
        email,
        displayName,
        password,
        timezone,
      });
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
    await withContext(async (context) => {
      const user = await context.db.user.findUniqueOrThrow({ where: { email } });
      printRecoveryCodes(await new AuthService(context).generateRecoveryCodes(user.id));
    });
  });

async function withContext<T>(
  work: (context: Awaited<ReturnType<typeof createContext>>) => Promise<T>,
): Promise<T> {
  const context = await createContext(env());
  try {
    return await work(context);
  } finally {
    await closeContext(context);
  }
}

program
  .command('integrity')
  .description('Check that every database record has its S3 object and every original in S3 is recorded')
  .action(async () => {
    const report = await withContext((context) => runIntegrityCheck(context));
    for (const user of report.users) {
      console.log(
        `${user.userId}: ${user.assetsInDatabase} recorded, ${user.objectsInS3} in S3, ${user.missingInS3.length} missing, ${user.sizeMismatches.length} size mismatches, ${user.unrecordedInS3.length} unrecorded`,
      );
    }
    console.log(
      report.healthy ? 'Healthy.' : 'Problems found; details saved under system/integrity/ in the bucket.',
    );
    process.exitCode = report.healthy ? 0 : 1;
  });

program
  .command('backup')
  .description('Dump the database and upload it to S3 now')
  .action(async () => {
    console.log((await withContext((context) => runDatabaseBackup(context))).join('\n'));
  });

program
  .command('catalog')
  .description('Export the catalogue of every file and its locations to S3 now')
  .action(async () => {
    console.log((await withContext((context) => runCatalogExport(context))).join('\n'));
  });

program
  .command('rebuild-index')
  .description("Rebuild a user's library index from S3 alone (after losing the database)")
  .requiredOption('--user-id <uuid>', 'the user id from the bucket prefix users/<uuid>/')
  .option('--email <email>', 'create the account with this email if it does not exist yet')
  .action(async (options: { userId: string; email?: string }) => {
    await withContext(async (context) => {
      const exists = await context.db.user.findUnique({ where: { id: options.userId } });
      if (!exists) {
        if (!options.email) throw new Error('The account does not exist; pass --email to create it');
        const password = await ask('New password (12+ characters): ', { hidden: true });
        passwordSchema.parse(password);
        const auth = new AuthService(context);
        const { totpSecret, totpUri } = await auth.createUser({
          email: emailSchema.parse(options.email),
          displayName: options.email,
          password,
          userId: options.userId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        qrcode.generate(totpUri, { small: true });
        console.log(`Authenticator key: ${totpSecret}`);
        await auth.confirmTotp(options.userId, await ask('6-digit code from the app: '));
        printRecoveryCodes(await auth.generateRecoveryCodes(options.userId));
      }
      const jobs = createJobs(context.redis);
      try {
        const result = await rebuildIndex({ ...context, jobs }, options.userId, (message) =>
          console.log(message),
        );
        console.log(`Adopted ${result.adopted} originals and restored ${result.locations} locations.`);
      } finally {
        await jobs.close();
      }
    });
  });

program
  .command('load-places')
  .description('Load GeoNames place names (CC BY 4.0) and name the place of every photo with GPS')
  .option(
    '--from <dir>',
    'read cities1000.zip, admin1CodesASCII.txt and countryInfo.txt from this folder instead of downloading',
  )
  .action(async (options: { from?: string }) => {
    const config = env();
    if (!config.DATABASE_MIGRATE_URL)
      throw new Error('DATABASE_MIGRATE_URL is needed: places are written by the owner role');
    console.log(
      options.from ? `Reading GeoNames files from ${options.from}` : 'Downloading GeoNames (about 10 MB)…',
    );
    const files = await readGeonames(options.from);
    const places = parsePlaces(files.cities, files.admin1, files.countries);
    console.log(`Saving ${places.length.toLocaleString()} places…`);
    const owner = createDb(config.DATABASE_MIGRATE_URL);
    try {
      await savePlaces(owner, places);
      const { withGps, placed } = await geocodeAllAssets(owner);
      console.log(
        `Done. ${placed.toLocaleString()} of ${withGps.toLocaleString()} files with GPS now have a place name.`,
      );
    } finally {
      await owner.$disconnect();
    }
  });

program
  .command('geocode')
  .description('Name the place of every photo with GPS from the loaded places (no download)')
  .action(async () => {
    const config = env();
    if (!config.DATABASE_MIGRATE_URL) throw new Error('DATABASE_MIGRATE_URL is needed');
    const owner = createDb(config.DATABASE_MIGRATE_URL);
    try {
      const [loaded] = await owner.$queryRaw<{ count: number }[]>`SELECT count(*)::int AS count FROM places`;
      if (!loaded?.count) throw new Error('No places loaded yet: run `pnpm vault-admin load-places` first');
      const { withGps, placed } = await geocodeAllAssets(owner);
      console.log(
        `${placed.toLocaleString()} of ${withGps.toLocaleString()} files with GPS have a place name.`,
      );
    } finally {
      await owner.$disconnect();
    }
  });

program.parseAsync().catch((error: unknown) => {
  console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
