import type { MediaUrls } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { thumbKey } from '../storage/keys';
import { Presigner } from '../storage/presign';

const WINDOW_SECONDS = 60 * 60;
/** Whenever a link is handed out, it stays valid for at least two more hours. */
const EXPIRES_SECONDS = 3 * WINDOW_SECONDS;

/**
 * Short-lived links straight to S3. Every link signed in the same hour is identical,
 * so the browser's cache keeps working while links still expire.
 */
export class MediaUrlSigner {
  private readonly presigner: Presigner;

  constructor(ctx: Pick<AppContext, 's3' | 'env'>) {
    this.presigner = new Presigner(ctx.s3, ctx.env);
  }

  private window(): Date {
    const now = Date.now();
    return new Date(now - (now % (WINDOW_SECONDS * 1000)));
  }

  private sign(key: string, query?: Record<string, string>): Promise<string> {
    return this.presigner.get({
      key,
      expiresInSeconds: EXPIRES_SECONDS,
      signingDate: this.window(),
      ...(query ? { query } : {}),
    });
  }

  derivative(userId: string, sha256: string, variant: 'sm' | 'md' | 'lg'): Promise<string> {
    return this.sign(thumbKey(userId, sha256, variant));
  }

  async thumbs(userId: string, sha256: string): Promise<MediaUrls> {
    const [sm, md] = await Promise.all([
      this.derivative(userId, sha256, 'sm'),
      this.derivative(userId, sha256, 'md'),
    ]);
    return { sm, md };
  }

  /** The original, shown in the browser where it can be (video, JPEG) under its original name. */
  original(asset: { s3Key: string; mimeType: string; originalName: string }): Promise<string> {
    const ascii = asset.originalName.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return this.sign(asset.s3Key, {
      'response-content-type': asset.mimeType,
      'response-content-disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(asset.originalName)}`,
    });
  }
}
