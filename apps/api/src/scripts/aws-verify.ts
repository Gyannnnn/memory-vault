import { createHash, randomUUID } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetBucketCorsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketLocationCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketOwnershipControlsCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetPublicAccessBlockCommand,
  HeadObjectCommand,
  ListBucketIntelligentTieringConfigurationsCommand,
  ListBucketsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { DeleteMessageCommand, GetQueueAttributesCommand, ReceiveMessageCommand } from '@aws-sdk/client-sqs';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { awsEnv } from '../env';
import { createS3Client, createSqsClient } from '../storage/aws';

type Outcome = 'pass' | 'fail' | 'warn';
const results: { outcome: Outcome; label: string; detail?: string }[] = [];

function record(outcome: Outcome, label: string, detail?: string) {
  results.push({ outcome, label, ...(detail ? { detail } : {}) });
  const mark = outcome === 'pass' ? '✓' : outcome === 'warn' ? '!' : '✗';
  console.log(`${mark} ${label}${detail ? `\n    ${detail}` : ''}`);
}

async function check(label: string, guide: string, run: () => Promise<string | true>): Promise<void> {
  try {
    const result = await run();
    if (result === true) record('pass', label);
    else record('fail', label, `${result} — see guide ${guide}`);
  } catch (error) {
    const name = (error as { name?: string }).name ?? 'Error';
    const message = error instanceof Error ? error.message : String(error);
    record('fail', label, `${name}: ${message} — see guide ${guide}`);
  }
}

let config: ReturnType<typeof awsEnv>;
try {
  config = awsEnv();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error('\nFill these in from docs/setup/phase-0-aws-setup.md §F.');
  process.exit(1);
}
const s3 = createS3Client(config);
const sqs = createSqsClient(config);
const Bucket = config.S3_BUCKET;
const errorName = (error: unknown) => (error as { name?: string }).name ?? '';

console.log(`Checking bucket ${Bucket} and queue in ${config.AWS_REGION}\n`);

await check('credentials belong to the memory-vault-app IAM user', 'E1–E3', async () => {
  const sts = new STSClient({
    region: config.AWS_REGION,
    credentials: { accessKeyId: config.AWS_ACCESS_KEY_ID, secretAccessKey: config.AWS_SECRET_ACCESS_KEY },
  });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  return identity.Arn?.endsWith(':user/memory-vault-app')
    ? true
    : `these keys belong to ${identity.Arn}; use the memory-vault-app user's keys`;
});

await check('credentials cannot list the account’s buckets (least privilege)', 'E2', async () => {
  try {
    await s3.send(new ListBucketsCommand({}));
    return 'the key can list every bucket in the account, so it has more than the app policy';
  } catch (error) {
    return errorName(error) === 'AccessDenied' ? true : `unexpected ${errorName(error)}`;
  }
});

await check('bucket is in ap-south-1', 'B1', async () => {
  const location = await s3.send(new GetBucketLocationCommand({ Bucket }));
  return location.LocationConstraint === config.AWS_REGION
    ? true
    : `bucket is in ${location.LocationConstraint ?? 'us-east-1'}`;
});

await check('Block Public Access: all four settings on', 'B1', async () => {
  const { PublicAccessBlockConfiguration: block } = await s3.send(
    new GetPublicAccessBlockCommand({ Bucket }),
  );
  const all =
    block?.BlockPublicAcls &&
    block.IgnorePublicAcls &&
    block.BlockPublicPolicy &&
    block.RestrictPublicBuckets;
  return all ? true : 'not every Block Public Access setting is on';
});

await check('ACLs disabled (bucket owner enforced)', 'B1', async () => {
  const { OwnershipControls } = await s3.send(new GetBucketOwnershipControlsCommand({ Bucket }));
  return OwnershipControls?.Rules?.[0]?.ObjectOwnership === 'BucketOwnerEnforced' ? true : 'ACLs are enabled';
});

await check('versioning enabled', 'B1', async () => {
  const { Status } = await s3.send(new GetBucketVersioningCommand({ Bucket }));
  return Status === 'Enabled' ? true : `versioning is ${Status ?? 'off'}`;
});

await check('default encryption is SSE-S3', 'B1', async () => {
  const result = await s3.send(new GetBucketEncryptionCommand({ Bucket }));
  const algorithm =
    result.ServerSideEncryptionConfiguration?.Rules?.[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
  return algorithm === 'AES256' ? true : `default encryption is ${algorithm ?? 'not set'}`;
});

await check(
  'lifecycle rules (multipart cleanup, old versions, Intelligent-Tiering, test/)',
  'C1',
  async () => {
    const { Rules = [] } = await s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }));
    const enabled = Rules.filter((rule) => rule.Status === 'Enabled');
    const wholeBucket = (rule: (typeof Rules)[number]) => !rule.Filter?.Prefix && !rule.Filter?.And;
    const missing: string[] = [];
    if (!enabled.some((rule) => rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7)) {
      missing.push('rule 1 (incomplete multipart uploads, 7 days)');
    }
    if (
      !enabled.some((rule) => wholeBucket(rule) && rule.NoncurrentVersionExpiration?.NoncurrentDays === 30)
    ) {
      missing.push('rule 2 (noncurrent versions, 30 days)');
    }
    if (
      !enabled.some((rule) =>
        rule.Transitions?.some(
          (transition) => transition.StorageClass === 'INTELLIGENT_TIERING' && transition.Days === 0,
        ),
      )
    ) {
      missing.push('rule 3 (Intelligent-Tiering after 0 days)');
    }
    if (!enabled.some((rule) => rule.Filter?.Prefix === 'test/' && rule.Expiration?.Days === 1)) {
      missing.push('rule 4 (test/ expires after 1 day)');
    }
    return missing.length === 0 ? true : `missing ${missing.join(', ')}`;
  },
);

await check('bucket policy denies non-TLS access', 'C2', async () => {
  const { Policy } = await s3.send(new GetBucketPolicyCommand({ Bucket }));
  const statements =
    (JSON.parse(Policy ?? '{}') as { Statement?: Record<string, unknown>[] }).Statement ?? [];
  const deniesInsecure = statements.some(
    (statement) =>
      statement.Effect === 'Deny' &&
      JSON.stringify(statement.Condition ?? {}).includes('aws:SecureTransport'),
  );
  return deniesInsecure ? true : 'no Deny statement on aws:SecureTransport';
});

await check('CORS allows PUT and exposes ETag', 'C3', async () => {
  const { CORSRules = [] } = await s3.send(new GetBucketCorsCommand({ Bucket }));
  const ok = CORSRules.some(
    (rule) =>
      rule.AllowedMethods?.includes('PUT') && rule.ExposeHeaders?.some((h) => h.toLowerCase() === 'etag'),
  );
  return ok ? true : 'no CORS rule with PUT and ETag';
});

await check('Intelligent-Tiering stays on instant tiers (no Deep Archive)', 'C1 note', async () => {
  const { IntelligentTieringConfigurationList = [] } = await s3.send(
    new ListBucketIntelligentTieringConfigurationsCommand({ Bucket }),
  );
  const archiving = IntelligentTieringConfigurationList.filter((item) => item.Status === 'Enabled');
  if (archiving.length > 0) {
    record(
      'warn',
      'an Intelligent-Tiering archive configuration is enabled: old originals will need restores',
    );
  }
  return true;
});

let queueArn = '';
await check('SQS queue: DLQ, 15-min visibility, long polling, SSE-SQS', 'D2', async () => {
  if (!config.SQS_S3_EVENTS_QUEUE_URL) return 'SQS_S3_EVENTS_QUEUE_URL is empty';
  const { Attributes = {} } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl: config.SQS_S3_EVENTS_QUEUE_URL, AttributeNames: ['All'] }),
  );
  queueArn = Attributes.QueueArn ?? '';
  const problems: string[] = [];
  if (!Attributes.RedrivePolicy) problems.push('no dead-letter queue');
  if (Number(Attributes.VisibilityTimeout) < 900)
    problems.push(`visibility timeout ${Attributes.VisibilityTimeout}s`);
  if (Number(Attributes.ReceiveMessageWaitTimeSeconds) < 20) problems.push('receive wait time below 20s');
  if (Attributes.SqsManagedSseEnabled !== 'true') problems.push('SSE-SQS not enabled');
  return problems.length === 0 ? true : problems.join(', ');
});

await check('bucket sends object-created events under users/ to the queue', 'D3', async () => {
  const config_ = await s3.send(new GetBucketNotificationConfigurationCommand({ Bucket }));
  const match = (config_.QueueConfigurations ?? []).find(
    (queue) =>
      queue.QueueArn === queueArn &&
      queue.Events?.includes('s3:ObjectCreated:*') &&
      queue.Filter?.Key?.FilterRules?.some(
        (rule) => rule.Name?.toLowerCase() === 'prefix' && rule.Value === 'users/',
      ),
  );
  return match ? true : 'no event notification for s3:ObjectCreated:* with prefix users/ to this queue';
});

const body = `memory-vault verify ${new Date().toISOString()}`;
const sha256 = createHash('sha256').update(body).digest('base64');
const probeKey = `users/_verify/inbox/${randomUUID()}.txt`;

await check('upload with SHA-256 checksum into Intelligent-Tiering, read back and verify', 'E2', async () => {
  await s3.send(
    new PutObjectCommand({
      Bucket,
      Key: probeKey,
      Body: body,
      ChecksumSHA256: sha256,
      StorageClass: 'INTELLIGENT_TIERING',
      ContentType: 'text/plain',
    }),
  );
  const head = await s3.send(new HeadObjectCommand({ Bucket, Key: probeKey, ChecksumMode: 'ENABLED' }));
  if (head.ChecksumSHA256 !== sha256) return `S3 reports checksum ${head.ChecksumSHA256}`;
  if (head.StorageClass !== 'INTELLIGENT_TIERING') return `stored as ${head.StorageClass ?? 'STANDARD'}`;
  if (head.ServerSideEncryption !== 'AES256') return `encryption ${head.ServerSideEncryption}`;
  const object = await s3.send(new GetObjectCommand({ Bucket, Key: probeKey }));
  return (await object.Body?.transformToString()) === body ? true : 'downloaded content differs';
});

await check('S3 event for the test object arrives on the queue', 'D2–D3', async () => {
  if (!config.SQS_S3_EVENTS_QUEUE_URL) return 'SQS_S3_EVENTS_QUEUE_URL is empty';
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: config.SQS_S3_EVENTS_QUEUE_URL,
        WaitTimeSeconds: 10,
        MaxNumberOfMessages: 10,
        VisibilityTimeout: 30,
      }),
    );
    for (const message of Messages) {
      const isProbe = message.Body?.includes(probeKey) ?? false;
      const isTestEvent = message.Body?.includes('"s3:TestEvent"') ?? false;
      if (isProbe || isTestEvent) {
        await sqs.send(
          new DeleteMessageCommand({
            QueueUrl: config.SQS_S3_EVENTS_QUEUE_URL,
            ReceiptHandle: message.ReceiptHandle,
          }),
        );
      }
      if (isProbe) return true;
    }
  }
  return 'no event within 60 seconds';
});

await check('app user may delete inbox objects (cleans up the test object)', 'E2', async () => {
  await s3.send(new DeleteObjectCommand({ Bucket, Key: probeKey }));
  return true;
});

await check('app user cannot delete originals', 'E2', async () => {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket, Key: 'users/_verify/originals/does-not-exist' }));
    return 'delete on originals/ was allowed; add the NeverDeleteOriginals statement';
  } catch (error) {
    return errorName(error) === 'AccessDenied' ? true : `unexpected ${errorName(error)}`;
  }
});

const failed = results.filter((result) => result.outcome === 'fail').length;
console.log(
  failed === 0
    ? '\nAll checks passed. AWS is ready.'
    : `\n${failed} check(s) failed. Fix them using the guide sections shown.`,
);
process.exitCode = failed === 0 ? 0 : 1;
