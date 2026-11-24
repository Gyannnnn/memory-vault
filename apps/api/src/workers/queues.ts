import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

export interface IngestJob {
  userId: string;
  assetId: string;
  localPath?: string;
}

export interface TranscodeJob {
  userId: string;
  assetId: string;
  localPath?: string;
}

export interface Jobs {
  ingest(job: IngestJob): Promise<void>;
  /** Streaming versions of a video. `priority`: lower runs first: 1 is kept for short motion clips, 2 is a video with a local copy, 3 one that must be downloaded. */
  transcode(job: TranscodeJob, options?: { priority?: number }): Promise<void>;
  /** The playable clip of a motion photo (same queue as videos; short). */
  motion(job: TranscodeJob): Promise<void>;
  close(): Promise<void>;
}

export const QUEUE = {
  ingest: 'ingest',
  transcode: 'transcode',
  maintenance: 'maintenance',
} as const;

export function createJobs(connection: Redis): Jobs {
  const ingest = new Queue<IngestJob>(QUEUE.ingest, { connection });
  const transcode = new Queue<TranscodeJob>(QUEUE.transcode, { connection });
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
    async transcode(job, options = {}) {
      await transcode.add('transcode', job, {
        jobId: `transcode-${job.assetId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 1000,
        removeOnFail: false,
        ...(options.priority ? { priority: options.priority } : {}),
      });
    },
    async motion(job) {
      await transcode.add('motion', job, {
        jobId: `motion-${job.assetId}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 1000,
        removeOnFail: false,
        // Clips are seconds long: ahead of the video backlog.
        priority: 1,
      });
    },
    async close() {
      await Promise.all([ingest.close(), transcode.close()]);
    },
  };
}
