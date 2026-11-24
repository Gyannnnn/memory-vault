import { S3Client } from '@aws-sdk/client-s3';
import { SQSClient } from '@aws-sdk/client-sqs';
import type { AwsEnv } from '../env';

/**
 * Credentials are passed explicitly from .env. The SDK's default provider chain
 * is never consulted, so an unrelated profile in ~/.aws can't be picked up.
 */
function credentials(config: AwsEnv) {
  if (!config.AWS_ACCESS_KEY_ID || !config.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set in apps/api/.env');
  }
  return { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY };
}

/**
 * The SDK waits forever by default. A connection that stalls mid-download (a flaky line,
 * a sleeping laptop) would then hold a worker slot for good; with these limits the request
 * fails instead and the job is retried.
 */
export const S3_TIMEOUTS = { connectionMs: 10_000, idleSocketMs: 120_000 } as const;

export function createS3Client(
  config: AwsEnv,
  timeouts: { connectionMs: number; idleSocketMs: number } = S3_TIMEOUTS,
): S3Client {
  return new S3Client({
    region: config.AWS_REGION,
    credentials: credentials(config),
    ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT } : {}),
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    requestHandler: { connectionTimeout: timeouts.connectionMs, socketTimeout: timeouts.idleSocketMs },
    // Checksums are always set explicitly (SHA-256); without this the SDK adds its
    // own CRC32 headers, which break presigned uploads.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

export function createSqsClient(config: AwsEnv): SQSClient {
  return new SQSClient({ region: config.AWS_REGION, credentials: credentials(config) });
}
