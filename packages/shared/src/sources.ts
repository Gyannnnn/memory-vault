import { z } from 'zod';

export const sourceIdSchema = z
  .string()
  .regex(/^[a-z0-9-]+:[a-z0-9._-]+$/, 'expected "<device>:<label>", for example laptop:s21fe');

export type SourceId = z.infer<typeof sourceIdSchema>;

export type SourceDevice = 'laptop' | 'phone' | 'web' | 'mobile' | 's3-direct' | (string & {});

export function deviceOf(sourceId: SourceId): SourceDevice {
  return sourceId.slice(0, sourceId.indexOf(':'));
}

export function isPhoneSource(sourceId: SourceId): boolean {
  return deviceOf(sourceId) === 'phone';
}
