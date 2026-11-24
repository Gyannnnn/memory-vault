import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createS3Client } from './aws';

// A storage endpoint that sends the start of a file and then goes silent, like a
// connection that stalls mid-download.
let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': '100000' });
    response.write(Buffer.alloc(1000));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('S3 client', () => {
  it('gives up on a download that stalls instead of waiting forever', async () => {
    const s3 = createS3Client(
      {
        AWS_REGION: 'ap-south-1',
        S3_BUCKET: 'vault',
        S3_ENDPOINT: endpoint,
        S3_FORCE_PATH_STYLE: true,
        SQS_S3_EVENTS_QUEUE_URL: undefined,
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
      },
      { connectionMs: 1000, idleSocketMs: 500 },
    );
    const started = Date.now();
    const object = await s3.send(new GetObjectCommand({ Bucket: 'vault', Key: 'original.jpg' }));
    const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
    await expect(pipeline(object.Body as Readable, sink)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
    s3.destroy();
  });
});
