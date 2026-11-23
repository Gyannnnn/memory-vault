import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export interface IngestJob {
  userId: string;
  assetId: string;
  localPath?: string;
}

export interface Jobs {
  ingest(job: IngestJob): Promise<void>;
  close(): Promise<void>;
}

export const QUEUE = {
  ingest: 'ingest',
  maintenance: 'maintenance',
} as const;

export function createJobs(connection: Redis): Jobs {
  const ingest = new Queue<IngestJob>(QUEUE.ingest, { connection });
  return {
    async ingest(job) {
      await ingest.add('ingest', job, {
        jobId: `ingest-${job.assetId}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      });
    },
    async close() {
      await ingest.close();
    },
  };
}
