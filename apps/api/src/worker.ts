import { Queue, Worker } from 'bullmq';
import { closeContext, createContext, createRedis } from './context';
import { env } from './env';
import { purgeTrash } from './library/trash';
import { createSqsClient } from './storage/aws';
import { processIngest } from './workers/ingest';
import { runCatalogExport, runDatabaseBackup, runIntegrityCheck } from './workers/maintenance';
import { exiftool } from './workers/media-tools';
import { createJobs, QUEUE, type IngestJob, type TranscodeJob } from './workers/queues';
import { consumeS3Events } from './workers/s3-events';
import { processMotion } from './workers/motion';
import { processTranscode } from './workers/transcode';

const config = env();
const context = await createContext(config);
const jobs = createJobs(context.redis);
context.jobs = jobs;
const connection = createRedis(config.REDIS_URL);
const stop = new AbortController();

const ingest = new Worker<IngestJob>(QUEUE.ingest, async (job) => processIngest(context, job.data), {
  connection,
  concurrency: Number(process.env.INGEST_CONCURRENCY ?? 2),
});
ingest.on('failed', (job, error) =>
  context.logger.error(
    { assetId: job?.data.assetId, attempts: job?.attemptsMade, err: error },
    'ingest failed',
  ),
);

// ffmpeg uses every core already; one video at a time keeps the computer usable.
const transcode = new Worker<TranscodeJob>(
  QUEUE.transcode,
  async (job) =>
    job.name === 'motion' ? processMotion(context, job.data) : processTranscode(context, job.data),
  {
    connection,
    concurrency: Number(process.env.TRANSCODE_CONCURRENCY ?? 1),
  },
);
transcode.on('failed', (job, error) =>
  context.logger.error(
    { assetId: job?.data.assetId, attempts: job?.attemptsMade, err: error },
    'transcode failed',
  ),
);

const maintenance = new Worker(
  QUEUE.maintenance,
  async (job) => {
    switch (job.name) {
      case 'integrity':
        return { healthy: (await runIntegrityCheck(context)).healthy };
      case 'db-backup':
        return runDatabaseBackup(context);
      case 'catalog-export':
        return runCatalogExport(context);
      case 'trash-purge': {
        // Scheduled: everyone's Trash; "Delete now": that user's.
        const userId = (job.data as { userId?: string } | undefined)?.userId;
        return purgeTrash(context, userId ? { userId } : {});
      }
      default:
        throw new Error(`unknown maintenance job ${job.name}`);
    }
  },
  { connection, concurrency: 1 },
);

const schedule = new Queue(QUEUE.maintenance, { connection });
await schedule.upsertJobScheduler('integrity-weekly', { pattern: '0 30 20 * * 6' }, { name: 'integrity' });
await schedule.upsertJobScheduler('db-backup-daily', { pattern: '0 0 20 * * *' }, { name: 'db-backup' });
await schedule.upsertJobScheduler('catalog-daily', { pattern: '0 30 21 * * *' }, { name: 'catalog-export' });
// 03:30 in India, after the catalogue: items 30 days in Trash are deleted for good.
await schedule.upsertJobScheduler('trash-purge-daily', { pattern: '0 0 22 * * *' }, { name: 'trash-purge' });

const events = config.SQS_S3_EVENTS_QUEUE_URL
  ? consumeS3Events({ ...context, jobs }, createSqsClient(config), stop.signal)
  : Promise.resolve();
context.logger.info(
  { s3Events: Boolean(config.SQS_S3_EVENTS_QUEUE_URL) },
  'worker started: ingest, transcode, maintenance schedule, S3 events',
);

const shutdown = async () => {
  stop.abort();
  await Promise.allSettled([
    ingest.close(),
    transcode.close(),
    maintenance.close(),
    schedule.close(),
    events,
  ]);
  await exiftool.end();
  connection.disconnect();
  await closeContext(context);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
