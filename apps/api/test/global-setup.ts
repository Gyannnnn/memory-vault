import { execFileSync } from 'node:child_process';
import {
  CreateBucketCommand,
  PutBucketCorsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { testEnv } from './test-env';

export default async function setup(): Promise<void> {
  const env = testEnv();
  execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, ...env },
    stdio: 'pipe',
  });
  const s3 = new S3Client({
    region: env.AWS_REGION,
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
  });
  try {
    await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
      throw new Error('S3 test gateway unavailable (docker compose --profile test up -d s3-test)', {
        cause: error,
      });
    }
  }
  await s3.send(
    new PutBucketVersioningCommand({ Bucket: env.S3_BUCKET, VersioningConfiguration: { Status: 'Enabled' } }),
  );
  // The same browser rule as the real bucket (docs/setup/phase-0-aws-setup.md), plus the
  // port a second, throwaway web server uses: the player and uploads talk to S3 directly.
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: env.S3_BUCKET,
      CORSConfiguration: {
        CORSRules: [
          {
            AllowedMethods: ['GET', 'HEAD', 'PUT'],
            AllowedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3001'],
            AllowedHeaders: ['*'],
            ExposeHeaders: ['ETag', 'x-amz-checksum-sha256', 'x-amz-version-id'],
            MaxAgeSeconds: 3600,
          },
        ],
      },
    }),
  );
  s3.destroy();
}
