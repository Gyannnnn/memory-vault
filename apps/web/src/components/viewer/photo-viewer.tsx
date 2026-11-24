'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 images, already sized */
import type { AssetDetail, AssetTile } from '@memory-vault/shared';
import { clampAspect } from '@memory-vault/shared';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Info,
  Loader,
  Loader2,
  Minus,
  Plus,
  X,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatWallTime } from '@/lib/format';
import { libraryQueries } from '@/lib/library';
import { cn } from '@/lib/utils';
import { InfoPanel } from './info-panel';
import { VideoPlayer } from './video-player';
import { ZoomStage, type ZoomControls } from './zoom-stage';

const BROWSER_IMAGES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);
const INFO_KEY = 'viewer-info-open';

function readInfoPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(INFO_KEY) === '1' && window.matchMedia('(min-width: 768px)').matches;
  } catch {
    return false;
  }
}

function ToolbarButton({
  label,
  onClick,
  children,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon-lg" onClick={onClick} aria-label={label} aria-pressed={pressed}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Whether the viewer shows the original because the file has no preview yet. */
function showsOriginal(tile: AssetTile, detail: AssetDetail | undefined): boolean {
  return (
    tile.kind !== 'video' &&
    tile.pending &&
    !tile.thumb &&
    detail !== undefined &&
    !detail.preview &&
    BROWSER_IMAGES.has(detail.mimeType)
  );
}

function OpenOriginal({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="mt-4 inline-flex min-h-11 items-center gap-2 text-sm font-medium text-ink underline-offset-4 hover:underline"
    >
      Open the original <ExternalLink className="size-4" aria-hidden="true" />
    </a>
  );
}

/**
 * The original file, for a photo whose preview hasn't been made yet. Browsers apply the
 * EXIF rotation themselves; the natural size tells the stage its shape.
 */
function OriginalImage({
  detail,
  onNaturalSize,
}: {
  detail: AssetDetail;
  onNaturalSize?: (width: number, height: number) => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <div className="grid size-full place-items-center px-6 text-center text-ink-muted">
        <div>
          <p className="font-medium text-ink">{detail.name}</p>
          <p className="mt-1 text-sm">
            The original couldn’t be shown here, and its preview isn’t ready yet.
          </p>
          <OpenOriginal href={detail.originalUrl} />
        </div>
      </div>
    );
  }
  return (
    <div className="relative size-full">
      {!loaded && (
        <Loader2
          className="absolute inset-0 m-auto size-6 animate-spin text-ink-muted"
          aria-label="Loading the original"
        />
      )}
      <img
        src={detail.originalUrl}
        alt=""
        draggable={false}
        onLoad={(event) => {
          setLoaded(true);
          onNaturalSize?.(event.currentTarget.naturalWidth, event.currentTarget.naturalHeight);
        }}
        onError={() => setFailed(true)}
        className={cn(
          'absolute inset-0 size-full object-contain transition-opacity duration-(--duration-base)',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

/** Photo, video or file, shown as large as it fits. */
function Media({
  tile,
  detail,
  zoomed,
  onNaturalSize,
}: {
  tile: AssetTile;
  detail: AssetDetail | undefined;
  zoomed: boolean;
  onNaturalSize?: (width: number, height: number) => void;
}) {
  const [largeLoaded, setLargeLoaded] = useState(false);

  if (tile.kind === 'video') {
    if (!detail) return <Loader2 className="size-6 animate-spin text-ink-muted" aria-label="Loading" />;
    return <VideoPlayer key={detail.id} detail={detail} poster={detail.preview?.lg ?? tile.thumb?.md} />;
  }

  const preview = tile.thumb?.md;
  const large = detail?.preview?.lg;
  const original = zoomed && detail && BROWSER_IMAGES.has(detail.mimeType) ? detail.originalUrl : null;
  if (!preview && !large) {
    if (detail && showsOriginal(tile, detail))
      return <OriginalImage detail={detail} onNaturalSize={onNaturalSize} />;
    if (tile.pending && !detail)
      return <Loader2 className="size-6 animate-spin text-ink-muted" aria-label="Loading" />;
    return (
      <div className="px-6 text-center text-ink-muted">
        {tile.pending ? (
          <Loader className="mx-auto size-10" aria-hidden="true" />
        ) : (
          <FileText className="mx-auto size-12" aria-hidden="true" />
        )}
        <p className="mt-3 font-medium text-ink">{tile.name}</p>
        <p className="mt-1 text-sm">
          {tile.pending
            ? 'Its preview is still being made and appears here when it’s ready.'
            : 'No preview for this file.'}
        </p>
        {detail && <OpenOriginal href={detail.originalUrl} />}
      </div>
    );
  }
  return (
    <div className="relative size-full">
      {preview && (
        <img src={preview} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />
      )}
      {large && (
        <img
          src={original ?? large}
          alt=""
          draggable={false}
          onLoad={() => setLargeLoaded(true)}
          className={cn(
            'absolute inset-0 size-full object-contain transition-opacity duration-(--duration-base)',
            largeLoaded ? 'opacity-100' : 'opacity-0',
          )}
        />
      )}
    </div>
  );
}

export interface PhotoViewerProps {
  /** The list being browsed, in order. The current photo may be missing (opened from a link). */
  items: AssetTile[];
  currentId: string;
  onShow: (id: string) => void;
  onClose: () => void;
  /** Near either end of `items`: load more in that direction if there is any. */
  onNearEdge?: (direction: 'previous' | 'next') => void;
}

export function PhotoViewer({ items, currentId, onShow, onClose, onNearEdge }: PhotoViewerProps) {
  const index = items.findIndex((item) => item.id === currentId);
  const detail = useQuery(libraryQueries.asset(currentId));
  const tile: AssetTile | undefined = index >= 0 ? items[index] : detail.data;
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;
  const [infoOpen, setInfoOpen] = useState(readInfoPreference);
  const [scale, setScale] = useState(1);
  const zoom = useRef<ZoomControls>(null);

  const go = useCallback((target: AssetTile | undefined) => target && onShow(target.id), [onShow]);
  const toggleInfo = useCallback(() => {
    setInfoOpen((open) => {
      try {
        window.localStorage.setItem(INFO_KEY, open ? '0' : '1');
      } catch {
        /* private mode: the choice just isn't remembered */
      }
      return !open;
    });
  }, []);

  useEffect(() => {
    if (index < 0 || !onNearEdge) return;
    if (index >= items.length - 3) onNearEdge('next');
    if (index <= 2) onNearEdge('previous');
  }, [index, items.length, onNearEdge]);

  // Warm the neighbours so moving feels instant.
  useEffect(() => {
    for (const neighbour of [previous, next]) {
      if (neighbour?.thumb) new Image().src = neighbour.thumb.md;
    }
  }, [previous, next]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      // Inside the video player its own shortcuts apply (arrows seek, i is picture-in-picture).
      if (event.target instanceof Element && event.target.closest('[data-media-player]')) return;
      if (event.key === 'ArrowLeft') go(previous);
      else if (event.key === 'ArrowRight') go(next);
      else if (event.key === 'i') toggleInfo();
      else if (event.key === '+' || event.key === '=') zoom.current?.zoom(1);
      else if (event.key === '-') zoom.current?.zoom(-1);
      else if (event.key === '0') zoom.current?.zoom(0);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, previous, next, toggleInfo]);

  const title = tile ? formatWallTime(tile.localAt) : 'Loading';
  const place = detail.data?.location?.place;
  // Files not processed yet have no size on record: the original's natural size fits the stage.
  const [natural, setNatural] = useState<{ id: string; aspect: number } | null>(null);
  const aspect = useMemo(() => {
    if (!tile) return 1;
    if (tile.width && tile.height) return clampAspect(tile.width, tile.height);
    return natural?.id === tile.id ? natural.aspect : 1;
  }, [tile, natural]);
  const onNaturalSize = useCallback(
    (width: number, height: number) => {
      if (tile && width > 0 && height > 0) setNatural({ id: tile.id, aspect: clampAspect(width, height) });
    },
    [tile],
  );
  const position = index >= 0 ? `${index + 1} of ${items.length}` : null;
  const original = tile ? showsOriginal(tile, detail.data) : false;
  const zoomable = tile && tile.kind !== 'video' && (tile.thumb || detail.data?.preview || original);

  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-theme="dark"
          aria-describedby={undefined}
          // Focus the viewer itself, not its first button: arrows and Esc work at once and no
          // tooltip pops up on open.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex flex-col bg-background text-ink outline-none md:flex-row"
        >
          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <header className="flex h-14 shrink-0 items-center gap-2 px-2 sm:px-3">
              <ToolbarButton label="Close (Esc)" onClick={onClose}>
                <X />
              </ToolbarButton>
              <div className="min-w-0 flex-1">
                <DialogPrimitive.Title className="truncate text-sm font-medium">
                  {title}
                </DialogPrimitive.Title>
                <p className="truncate text-xs text-ink-muted">
                  {[place ? [place.name, place.country].filter(Boolean).join(', ') : null, position]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {zoomable && (
                <>
                  <ToolbarButton label="Zoom out (−)" onClick={() => zoom.current?.zoom(-1)}>
                    <Minus />
                  </ToolbarButton>
                  <ToolbarButton label="Zoom in (+)" onClick={() => zoom.current?.zoom(1)}>
                    <Plus />
                  </ToolbarButton>
                </>
              )}
              {detail.data && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="icon-lg" asChild>
                      <a href={detail.data.downloadUrl} aria-label="Download the original">
                        <Download />
                      </a>
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Download the original</TooltipContent>
                </Tooltip>
              )}
              <ToolbarButton label="Details (i)" onClick={toggleInfo} pressed={infoOpen}>
                <Info />
              </ToolbarButton>
            </header>

            <div className="relative flex min-h-0 flex-1">
              {tile ? (
                tile.kind === 'video' || !zoomable ? (
                  <div className="flex min-h-0 flex-1 items-center justify-center p-2 sm:p-4">
                    <Media key={tile.id} tile={tile} detail={detail.data} zoomed={false} />
                  </div>
                ) : (
                  <ZoomStage
                    key={tile.id}
                    aspect={aspect}
                    onSwipe={(direction) => go(direction === 'next' ? next : previous)}
                    onSwipeDown={onClose}
                    onZoomChange={setScale}
                    controls={zoom}
                  >
                    <Media
                      tile={tile}
                      detail={detail.data}
                      zoomed={scale > 1.5}
                      onNaturalSize={onNaturalSize}
                    />
                  </ZoomStage>
                )
              ) : detail.isError ? (
                <div className="m-auto text-center">
                  <p className="font-medium">This photo can’t be shown</p>
                  <p className="mt-1 text-sm text-ink-muted">
                    It may have been deleted, or the link is wrong.
                  </p>
                </div>
              ) : (
                <Loader2 className="m-auto size-6 animate-spin text-ink-muted" aria-label="Loading" />
              )}

              {original && (
                <p className="pointer-events-none absolute bottom-3 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 truncate rounded-full bg-scrim/80 px-3 py-1.5 text-xs text-ink-muted">
                  Showing the original while its preview is made
                </p>
              )}
              {previous && (
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => go(previous)}
                  aria-label="Previous (←)"
                  className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-scrim/60 hover:bg-scrim max-sm:hidden"
                >
                  <ChevronLeft />
                </Button>
              )}
              {next && (
                <Button
                  variant="ghost"
                  size="icon-lg"
                  onClick={() => go(next)}
                  aria-label="Next (→)"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-scrim/60 hover:bg-scrim max-sm:hidden"
                >
                  <ChevronRight />
                </Button>
              )}
            </div>
            {/* Phones: visible buttons as well as swiping. */}
            <nav aria-label="Move between photos" className="flex justify-between px-2 pb-2 sm:hidden">
              <Button variant="ghost" size="lg" onClick={() => go(previous)} disabled={!previous}>
                <ChevronLeft /> Previous
              </Button>
              <Button variant="ghost" size="lg" onClick={() => go(next)} disabled={!next}>
                Next <ChevronRight />
              </Button>
            </nav>
          </div>

          {infoOpen && <InfoPanel detail={detail.data} loading={detail.isPending} onClose={toggleInfo} />}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
