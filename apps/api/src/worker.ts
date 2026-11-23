import { Queue, Worker } from 'bullmq';
import { closeContext, createContext, createRedis } from './context';
import { env } from './env';
import { createSqsClient } from './storage/aws';
import { processIngest } from './workers/ingest';
import { runCatalogExport, runDatabaseBackup, runIntegrityCheck } from './workers/maintenance';
import { exiftool } from './workers/media-tools';
import { createJobs, QUEUE, type IngestJob } from './workers/queues';
import { consumeS3Events } from './workers/s3-events';

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

const events = config.SQS_S3_EVENTS_QUEUE_URL
  ? consumeS3Events({ ...context, jobs }, createSqsClient(config), stop.signal)
  : Promise.resolve();
context.logger.info(
  { s3Events: Boolean(config.SQS_S3_EVENTS_QUEUE_URL) },
  'worker started: ingest, maintenance schedule, S3 events',
);

const shutdown = async () => {
  stop.abort();
  await Promise.allSettled([ingest.close(), maintenance.close(), schedule.close(), events]);
  await exiftool.end();
  connection.disconnect();
  await closeContext(context);
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
