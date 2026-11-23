import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const envFile = join(apiRoot, '.env');
if (process.env.NODE_ENV !== 'test' && existsSync(envFile)) process.loadEnvFile(envFile);

const nonEmpty = z.string().trim().min(1);
const boolish = z
  .enum(['true', 'false', '1', '0', ''])
  .default('false')
  .transform((value) => value === 'true' || value === '1');

const awsSchema = z.object({
  AWS_REGION: nonEmpty.default('ap-south-1'),
  S3_BUCKET: nonEmpty,
  S3_ENDPOINT: z
    .url()
    .optional()
    .or(z.literal('').transform(() => undefined)),
  S3_FORCE_PATH_STYLE: boolish,
  SQS_S3_EVENTS_QUEUE_URL: z.string().trim().optional(),
  AWS_ACCESS_KEY_ID: nonEmpty,
  AWS_SECRET_ACCESS_KEY: nonEmpty,
});

const base64Key = (bytes: number) =>
  nonEmpty.refine((value) => Buffer.from(value, 'base64').length === bytes, `must be ${bytes} bytes, base64`);

const appSchema = awsSchema.extend({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(4000),
  API_PUBLIC_URL: z.url().default('http://localhost:4000'),
  DATABASE_URL: nonEmpty,
  DATABASE_MIGRATE_URL: z.string().optional(),
  REDIS_URL: nonEmpty,
  JWT_PRIVATE_KEY: nonEmpty,
  JWT_PUBLIC_KEY: nonEmpty,
  DATA_ENCRYPTION_KEY: base64Key(32),
  WEBAUTHN_RP_ID: nonEmpty.default('localhost'),
  WEBAUTHN_RP_NAME: nonEmpty.default('Memory Vault'),
  WEBAUTHN_ORIGINS: nonEmpty
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim())),
  SIGNUP_MODE: z.enum(['closed', 'invite', 'open']).default('closed'),
  DEFAULT_QUOTA_BYTES: z.coerce.bigint().default(1n << 40n),
  LOCAL_PATH_MAP: z.string().default(''),
});

export type AwsEnv = z.infer<typeof awsSchema>;
export type AppEnv = z.infer<typeof appSchema>;

function parse<T extends z.ZodType>(schema: T, label: string): z.infer<T> {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`${label} configuration is incomplete (apps/api/.env):\n${problems.join('\n')}`);
  }
  return result.data;
}

let appEnv: AppEnv | undefined;

export function env(): AppEnv {
  appEnv ??= parse(appSchema, 'API');
  return appEnv;
}

export function awsEnv(): AwsEnv {
  return parse(awsSchema, 'AWS');
}

export function resetEnvForTests(): void {
  appEnv = undefined;
}
