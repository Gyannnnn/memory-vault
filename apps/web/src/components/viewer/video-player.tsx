'use client';

import '@vidstack/react/player/styles/default/theme.css';
import '@vidstack/react/player/styles/default/layouts/video.css';
import type { AssetDetail } from '@memory-vault/shared';
import {
  isHLSProvider,
  MediaPlayer,
  MediaProvider,
  Poster,
  type MediaProviderAdapter,
} from '@vidstack/react';
import { DefaultVideoLayout, defaultLayoutIcons } from '@vidstack/react/player/layouts/default';
import Hls from 'hls.js';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

/** Where the browser fetches a video's HLS master playlist (through the signed-in gateway). */
export const streamUrl = (assetId: string) => `/api/v1/assets/${assetId}/stream.m3u8`;

/**
 * Plays a video: the adaptive stream when its streaming versions exist, otherwise the
 * original file. If the stream fails it falls back to the original; if that can't play
 * either (an HEVC original without a stream yet), it says so and links to the file.
 */
export function VideoPlayer({ detail, poster }: { detail: AssetDetail; poster: string | undefined }) {
  const [source, setSource] = useState<'stream' | 'original' | 'failed'>(
    detail.stream ? 'stream' : 'original',
  );
  const ratio = detail.width && detail.height ? detail.width / detail.height : 16 / 9;

  if (source === 'failed') {
    return (
      <div className="max-w-sm px-6 text-center">
        <p className="font-medium">This video can’t play in the browser yet</p>
        <p className="mt-1 text-sm text-ink-muted">
          {detail.stream
            ? 'The stream didn’t load. Check your connection and try again.'
            : 'A version that plays in the browser is being made.'}
        </p>
        <a
          href={detail.originalUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium underline-offset-4 hover:underline"
        >
          Open the original <ExternalLink className="size-4" aria-hidden="true" />
        </a>
      </div>
    );
  }

  const onProviderChange = (provider: MediaProviderAdapter | null) => {
    // Use the bundled hls.js: by default the player would fetch it from a public CDN.
    if (isHLSProvider(provider)) {
      provider.library = Hls;
      provider.config = { maxBufferLength: 30, startLevel: -1, capLevelToPlayerSize: true };
    }
  };

  return (
    // The player fits the stage like object-fit: contain, whatever the video's shape.
    <div className="grid size-full place-items-center" style={{ containerType: 'size' }}>
      <MediaPlayer
        key={source}
        className="vault-player overflow-hidden rounded-md bg-black"
        style={{ width: `min(100cqw, calc(100cqh * ${ratio}))`, aspectRatio: `${ratio}` }}
        title={detail.name}
        src={
          source === 'stream'
            ? { src: streamUrl(detail.id), type: 'application/x-mpegurl' }
            : { src: detail.originalUrl, type: detail.mimeType as 'video/mp4' }
        }
        autoPlay
        playsInline
        onProviderChange={onProviderChange}
        onError={() => setSource(source === 'stream' ? 'original' : 'failed')}
      >
        <MediaProvider>{poster && <Poster className="vds-poster" src={poster} alt="" />}</MediaProvider>
        {/* No Cast button: casting would load Google's SDK into the page and hand the video to another device. */}
        <DefaultVideoLayout icons={defaultLayoutIcons} slots={{ googleCastButton: null }} />
      </MediaPlayer>
    </div>
  );
}
