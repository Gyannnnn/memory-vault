import type { AppContext } from '../context';
import { withUser } from '../db';
import type { StreamDetails } from '../workers/transcode';
import { MediaUrlSigner } from './media-urls';

export const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';

interface Rendition {
  short: number;
  width: number;
  height: number;
  details: StreamDetails;
}

/** The master playlist: one entry per rendition, smallest first, each a relative URI. */
export function masterPlaylist(renditions: Rendition[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const { short, width, height, details } of renditions) {
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${details.bandwidth},AVERAGE-BANDWIDTH=${details.averageBandwidth},` +
        `RESOLUTION=${width}x${height},CODECS="${details.codecs}",FRAME-RATE=${details.frameRate.toFixed(3)}`,
      `stream/${short}.m3u8`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** A rendition's playlist with its file name swapped for a short-lived link to the file in S3. */
export function mediaPlaylist(details: StreamDetails, url: string): string {
  return details.playlist
    .split('\n')
    .map((line) => {
      if (line === details.fileName) return url;
      if (line.startsWith('#EXT-X-MAP:')) return line.replace(`URI="${details.fileName}"`, `URI="${url}"`);
      return line;
    })
    .join('\n');
}

/**
 * HLS for the web player. The playlists come from the API (signed in, row-level security);
 * the video bytes come straight from S3 through presigned links the player reads by range.
 */
export class StreamService {
  private readonly urls: MediaUrlSigner;

  constructor(private readonly ctx: Pick<AppContext, 'db' | 's3' | 'env'>) {
    this.urls = new MediaUrlSigner(ctx);
  }

  private renditions(userId: string, assetId: string) {
    return withUser(this.ctx.db, userId, (tx) =>
      tx.derivative.findMany({
        where: { assetId, userId, variant: { startsWith: 'hls-' }, asset: { deletedAt: null } },
        select: { variant: true, s3Key: true, width: true, height: true, details: true },
      }),
    );
  }

  async master(userId: string, assetId: string): Promise<string | null> {
    const rows = await this.renditions(userId, assetId);
    const renditions = rows
      .map((row) => ({
        short: Number(row.variant.slice(4)),
        width: row.width,
        height: row.height,
        details: row.details as unknown as StreamDetails | null,
      }))
      .filter((row): row is Rendition => Number.isInteger(row.short) && row.details !== null)
      .sort((a, b) => a.short - b.short);
    return renditions.length > 0 ? masterPlaylist(renditions) : null;
  }

  async media(userId: string, assetId: string, short: number): Promise<string | null> {
    const row = (await this.renditions(userId, assetId)).find((entry) => entry.variant === `hls-${short}`);
    const details = row?.details as unknown as StreamDetails | null | undefined;
    if (!row || !details) return null;
    return mediaPlaylist(details, await this.urls.object(row.s3Key));
  }
}
