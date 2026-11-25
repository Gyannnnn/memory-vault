'use client';

/* eslint-disable @next/next/no-img-element -- images are presigned S3 WebP derivatives, already sized */
import type { AssetTile } from '@memory-vault/shared';
import { clampAspect } from '@memory-vault/shared';
import { Check, FileText, Film, Image as ImageIcon, Loader, Music, Play } from 'lucide-react';
import { memo, useRef, useState, type CSSProperties } from 'react';
import { useSelection } from '@/components/selection/selection';
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
 * One photo or video in a grid: a button that opens it (or, while selecting, picks it), and
 * in a selectable grid a round tick in the corner that selects it. The two are siblings, as
 * buttons can't nest. On touch screens a long press selects too.
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
  const touch = useRef(false);
  const selection = useSelection();
  const selected = selection?.isSelected(tile.id) ?? false;
  const selecting = selection?.active ?? false;
  const image = failed ? null : sources(tile);
  const name = label ?? tileLabel(tile);

  return (
    <div
      className={cn(
        'group relative overflow-hidden bg-surface-sunken',
        selected && 'bg-selection',
        className,
      )}
      style={{ width: width ?? '100%', height: height ?? '100%', ...style }}
    >
      <button
        type="button"
        onPointerDown={(event) => {
          touch.current = event.pointerType === 'touch';
        }}
        onContextMenu={(event) => {
          // Long press on a phone selects (the browser reports it as a context menu).
          if (!selection || !touch.current) return;
          event.preventDefault();
          selection.toggle(tile.id);
        }}
        onClick={(event) =>
          selecting && selection ? selection.toggle(tile.id, { range: event.shiftKey }) : onOpen(tile.id)
        }
        aria-label={name}
        aria-pressed={selecting ? selected : undefined}
        data-asset-id={tile.id}
        className={cn(
          'absolute inset-0 block size-full outline-none transition-transform duration-(--duration-fast) ease-(--ease-standard)',
          'focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
          selected && 'scale-[0.88] overflow-hidden rounded-md motion-reduce:scale-100',
        )}
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
              !selecting && 'group-hover:scale-[1.02] motion-reduce:group-hover:scale-100',
            )}
          />
        ) : (
          <Placeholder tile={tile} />
        )}
        {tile.kind === 'video' && (
          <span className="pointer-events-none absolute right-1.5 bottom-1.5 inline-flex items-center gap-1 rounded-sm bg-scrim px-1.5 py-0.5 text-xs font-medium text-ink-inverse tabular-nums dark:text-ink">
            <Play className="size-3 fill-current" aria-hidden="true" />
            {tile.durationMs ? formatClock(tile.durationMs) : null}
          </span>
        )}
        <span className="pointer-events-none absolute inset-0 bg-ink/0 transition-colors duration-(--duration-fast) group-hover:bg-ink/5" />
      </button>
      {selection && (
        <button
          type="button"
          onClick={(event) => selection.toggle(tile.id, { range: event.shiftKey })}
          aria-label={selected ? `Deselect ${name}` : `Select ${name}`}
          aria-pressed={selected}
          className={cn(
            'absolute top-0 left-0 z-10 grid size-10 place-items-center outline-none transition-opacity duration-(--duration-fast)',
            'focus-visible:opacity-100 [&:focus-visible>span]:outline-2 [&:focus-visible>span]:outline-offset-2 [&:focus-visible>span]:outline-focus',
            selecting || selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
        >
          <span
            className={cn(
              'grid size-5 place-items-center rounded-full border-2 shadow-sm',
              selected ? 'border-focus bg-focus text-white' : 'border-white bg-black/25',
            )}
          >
            {selected && <Check className="size-3.5" strokeWidth={3} aria-hidden="true" />}
          </span>
        </button>
      )}
    </div>
  );
});
