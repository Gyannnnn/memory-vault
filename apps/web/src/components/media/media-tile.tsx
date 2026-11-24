'use client';

/* eslint-disable @next/next/no-img-element -- images are presigned S3 WebP derivatives, already sized */
import type { AssetTile } from '@memory-vault/shared';
import { clampAspect } from '@memory-vault/shared';
import { FileText, Film, Image as ImageIcon, Loader, Music, Play } from 'lucide-react';
import { memo, useState, type CSSProperties } from 'react';
import { formatClock, formatWallTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const kindLabels: Record<AssetTile['kind'], string> = {
  photo: 'Photo',
  raw: 'RAW photo',
  video: 'Video',
  audio: 'Audio',
  document: 'Document',
  other: 'File',
};

export function tileLabel(tile: AssetTile): string {
  const label = `${kindLabels[tile.kind]}, ${formatWallTime(tile.localAt)}`;
  return tile.pending ? `${label}, preview still being made` : label;
}

/** srcset widths: each derivative's longest side is 400 or 1080 px. */
function sources(tile: AssetTile): { src: string; srcSet: string } | null {
  if (!tile.thumb) return null;
  const aspect = clampAspect(tile.width, tile.height);
  const widthAt = (side: number) => Math.round(aspect >= 1 ? side : side * aspect);
  return {
    src: tile.thumb.sm,
    srcSet: `${tile.thumb.sm} ${widthAt(400)}w, ${tile.thumb.md} ${widthAt(1080)}w`,
  };
}

/** No preview: a loader while one is being made, otherwise what kind of file it is. */
function Placeholder({ tile }: { tile: AssetTile }) {
  const Icon = tile.pending
    ? Loader
    : tile.kind === 'video'
      ? Film
      : tile.kind === 'document'
        ? FileText
        : tile.kind === 'audio'
          ? Music
          : ImageIcon;
  return (
    <span
      className="absolute inset-0 grid place-items-center text-ink-subtle"
      title={tile.pending ? 'Preview still being made' : undefined}
    >
      <Icon className="size-5" aria-hidden="true" />
    </span>
  );
}

/**
 * One photo or video in a grid. A button, so it is reachable and opens with the keyboard;
 * the image itself is decorative because the button carries the label.
 */
export const MediaTile = memo(function MediaTile({
  tile,
  width,
  height,
  onOpen,
  className,
  style,
  label,
  sizes,
}: {
  tile: AssetTile;
  /** Pixel size; leave out to size the tile with CSS (then pass `sizes`). */
  width?: number;
  height?: number;
  sizes?: string;
  onOpen: (id: string) => void;
  className?: string;
  style?: CSSProperties;
  label?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const image = failed ? null : sources(tile);

  return (
    <button
      type="button"
      onClick={() => onOpen(tile.id)}
      aria-label={label ?? tileLabel(tile)}
      data-asset-id={tile.id}
      className={cn(
        'group relative block overflow-hidden bg-surface-sunken outline-none',
        'focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
        className,
      )}
      style={{ width: width ?? '100%', height: height ?? '100%', ...style }}
    >
      {image ? (
        <img
          src={image.src}
          srcSet={image.srcSet}
          sizes={sizes ?? (width ? `${Math.ceil(width)}px` : '200px')}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          className={cn(
            'size-full object-cover transition-[opacity,transform] duration-(--duration-base) ease-(--ease-standard)',
            loaded ? 'opacity-100' : 'opacity-0',
            'group-hover:scale-[1.02] motion-reduce:group-hover:scale-100',
          )}
        />
      ) : (
        <Placeholder tile={tile} />
      )}
      {tile.kind === 'video' && (
        <span className="pointer-events-none absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-sm bg-scrim px-1.5 py-0.5 text-[11px] font-medium text-ink-inverse tabular-nums dark:text-ink">
          <Play className="size-3 fill-current" aria-hidden="true" />
          {tile.durationMs ? formatClock(tile.durationMs) : null}
        </span>
      )}
      <span className="pointer-events-none absolute inset-0 bg-ink/0 transition-colors duration-(--duration-fast) group-hover:bg-ink/5" />
    </button>
  );
});
