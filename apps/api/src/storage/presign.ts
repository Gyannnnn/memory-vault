import type { S3Client } from '@aws-sdk/client-s3';
import { S3RequestPresigner } from '@aws-sdk/s3-request-presigner';
import { HttpRequest } from '@smithy/protocol-http';
import type { AwsEnv } from '../env';

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

const rfc3986 = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Presigns a PUT whose listed headers are part of the signature. The client must
 * send exactly these headers, so S3 checks the SHA-256 it was told to expect and
 * rejects anything else.
 */
export class Presigner {
  private readonly presigner: S3RequestPresigner;

  constructor(
    s3: S3Client,
    private readonly config: Pick<AwsEnv, 'AWS_REGION' | 'S3_BUCKET' | 'S3_ENDPOINT' | 'S3_FORCE_PATH_STYLE'>,
  ) {
    this.presigner = new S3RequestPresigner({ ...s3.config });
  }

  private target(key: string): { protocol: string; hostname: string; port?: number; path: string } {
    const encodedKey = key.split('/').map(rfc3986).join('/');
    if (this.config.S3_ENDPOINT) {
      const endpoint = new URL(this.config.S3_ENDPOINT);
      const port = endpoint.port ? Number(endpoint.port) : undefined;
      return this.config.S3_FORCE_PATH_STYLE
        ? {
            protocol: endpoint.protocol,
            hostname: endpoint.hostname,
            ...(port ? { port } : {}),
            path: `/${this.config.S3_BUCKET}/${encodedKey}`,
          }
        : {
            protocol: endpoint.protocol,
            hostname: `${this.config.S3_BUCKET}.${endpoint.hostname}`,
            ...(port ? { port } : {}),
            path: `/${encodedKey}`,
          };
    }
    return {
      protocol: 'https:',
      hostname: `${this.config.S3_BUCKET}.s3.${this.config.AWS_REGION}.amazonaws.com`,
      path: `/${encodedKey}`,
    };
  }

  async put(input: {
    key: string;
    headers: Record<string, string>;
    query?: Record<string, string>;
    expiresInSeconds: number;
  }): Promise<SignedRequest> {
    return this.sign('PUT', input);
  }

  /**
   * Presigns a GET. Pass the same `signingDate` for a while (e.g. the start of the
   * hour) and the URL stays identical, so browsers can cache what it points to.
   */
  async get(input: {
    key: string;
    query?: Record<string, string>;
    expiresInSeconds: number;
    signingDate?: Date;
  }): Promise<string> {
    return (await this.sign('GET', { ...input, headers: {} })).url;
  }

  private async sign(
    method: 'GET' | 'PUT',
    input: {
      key: string;
      headers: Record<string, string>;
      query?: Record<string, string>;
      expiresInSeconds: number;
      signingDate?: Date;
    },
  ): Promise<SignedRequest> {
    const target = this.target(input.key);
    const host = target.port ? `${target.hostname}:${target.port}` : target.hostname;
    const headers = Object.fromEntries(
      Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const request = new HttpRequest({
      method,
      protocol: target.protocol,
      hostname: target.hostname,
      ...(target.port ? { port: target.port } : {}),
      path: target.path,
      query: input.query ?? {},
      headers: { ...headers, host },
    });
    const signed = await this.presigner.presign(request, {
      expiresIn: input.expiresInSeconds,
      unhoistableHeaders: new Set(Object.keys(headers)),
      ...(input.signingDate ? { signingDate: input.signingDate } : {}),
    });
    const query = Object.entries(signed.query ?? {})
      .flatMap(([name, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) =>
          item === null ? rfc3986(name) : `${rfc3986(name)}=${rfc3986(item)}`,
        ),
      )
      .join('&');
    return { url: `${target.protocol}//${host}${target.path}?${query}`, headers };
  }
}
