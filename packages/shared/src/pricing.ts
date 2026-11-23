/** S3 prices for ap-south-1 from the AWS public price list, fetched 2026-11-23. */
export const s3Pricing = {
  region: 'ap-south-1',
  fetchedOn: '2026-11-23',
  intelligentTiering: {
    frequentPerGbMonth: 0.025,
    infrequentPerGbMonth: 0.0138,
    archiveInstantPerGbMonth: 0.005,
    deepArchivePerGbMonth: 0.002,
    monitoringPerThousandObjects: 0.0025,
    putPerThousand: 0.005,
    getPerThousand: 0.0004,
    minMonitoredObjectBytes: 128 * 1024,
  },
} as const;

const GB = 1024 ** 3;

export interface StorageCostEstimate {
  firstMonth: number;
  idleAfterThirtyDays: number;
  idleAfterNinetyDays: number;
  uploadRequests: number;
}

export function estimateStorageCost(input: {
  bytes: number;
  objects: number;
  monitoredObjects?: number;
  multipartParts?: number;
}): StorageCostEstimate {
  const it = s3Pricing.intelligentTiering;
  const gb = input.bytes / GB;
  const monitoring = ((input.monitoredObjects ?? input.objects) / 1000) * it.monitoringPerThousandObjects;
  const putRequests = input.objects * 2 + (input.multipartParts ?? 0);
  return {
    firstMonth: gb * it.frequentPerGbMonth + monitoring,
    idleAfterThirtyDays: gb * it.infrequentPerGbMonth + monitoring,
    idleAfterNinetyDays: gb * it.archiveInstantPerGbMonth + monitoring,
    uploadRequests: (putRequests / 1000) * it.putPerThousand,
  };
}

/** Rough wall-clock upload time: payload at ~90% of line rate plus a small per-file overhead. */
export function estimateUploadSeconds(bytes: number, files: number, megabitsPerSecond: number): number {
  const payload = (bytes * 8) / (megabitsPerSecond * 1_000_000 * 0.9);
  return payload + files * 0.05;
}
