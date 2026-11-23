import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

export async function sha256Stream(stream: Readable, onBytes?: (bytes: number) => void): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    onBytes?.(buffer.length);
  }
  return hash.digest('hex');
}

export function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

export function base64ToHex(base64: string): string {
  return Buffer.from(base64, 'base64').toString('hex');
}
