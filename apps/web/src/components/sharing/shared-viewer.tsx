'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 images, already sized */
import type { AssetTile, SharedAsset } from '@memory-vault/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Download, Loader2, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { VideoPlayer } from '@/components/viewer/video-player';
import { formatWallTime } from '@/lib/format';
import { shareApi, sharePath } from '@/lib/share-client';

export const sharedAssetQuery = (token: string, id: string) => ({
  queryKey: ['share', token, 'asset', id],
  queryFn: () => shareApi<SharedAsset>(token, `/assets/${id}`),
  staleTime: 45 * 60_000,
});

/** A shared photo or video, filling the space it's given. */
export function SharedMedia({ token, tile }: { token: string; tile: AssetTile }) {
  const detail = useQuery(sharedAssetQuery(token, tile.id));
  if (tile.kind === 'video') {
    if (!detail.data)
      return <Loader2 className="m-auto size-6 animate-spin text-ink-muted" aria-label="Loading" />;
    return (
      <VideoPlayer
        key={tile.id}
        detail={{ ...detail.data, originalUrl: null }}
        poster={detail.data.preview?.lg ?? tile.thumb?.md}
        stream={sharePath(token, `/assets/${tile.id}/stream.m3u8`)}
      />
    );
  }
  const src = detail.data?.preview?.lg ?? tile.thumb?.md;
  return src ? (
    <img
      src={src}
      alt={formatWallTime(tile.localAt)}
      className="m-auto max-h-full max-w-full object-contain"
    />
  ) : (
    <p className="m-auto text-sm text-ink-muted">No preview for this file yet.</p>
  );
}

/** Full-screen viewer for a share link: move through the shared items, save one if allowed. */
export function SharedViewer({
  token,
  items,
  currentId,
  onShow,
  onClose,
  onNearEnd,
}: {
  token: string;
  items: AssetTile[];
  currentId: string;
  onShow: (id: string) => void;
  onClose: () => void;
  onNearEnd?: () => void;
}) {
  const index = items.findIndex((item) => item.id === currentId);
  const tile = items[index];
  const previous = index > 0 ? items[index - 1] : undefined;
  const next = index >= 0 && index < items.length - 1 ? items[index + 1] : undefined;
  const detail = useQuery({ ...sharedAssetQuery(token, currentId), enabled: Boolean(tile) });
  const go = useCallback((target: AssetTile | undefined) => target && onShow(target.id), [onShow]);

  useEffect(() => {
    if (index >= items.length - 3) onNearEnd?.();
  }, [index, items.length, onNearEnd]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof Element && event.target.closest('[data-media-player]')) return;
      if (event.key === 'ArrowLeft') go(previous);
      else if (event.key === 'ArrowRight') go(next);
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, previous, next]);

  if (!tile) return null;
  return (
    <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          data-theme="dark"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
          tabIndex={-1}
          className="fixed inset-0 z-50 flex flex-col bg-background text-ink outline-none"
        >
          <header className="flex h-14 shrink-0 items-center gap-2 px-2 sm:px-3">
            <Button variant="ghost" size="icon-lg" onClick={onClose} aria-label="Close (Esc)">
              <X />
            </Button>
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="truncate text-sm font-medium">
                {formatWallTime(tile.localAt)}
              </DialogPrimitive.Title>
              <p className="text-xs text-ink-muted tabular-nums">
                {index + 1} of {items.length}
              </p>
            </div>
            {detail.data?.downloadUrl && (
              <Button variant="ghost" size="icon-lg" asChild>
                <a href={detail.data.downloadUrl} aria-label="Download the original">
                  <Download />
                </a>
              </Button>
            )}
          </header>
          <div className="relative flex min-h-0 flex-1 p-2 sm:px-16">
            <SharedMedia token={token} tile={tile} />
            <Button
              variant="ghost"
              size="icon-lg"
              className="absolute top-1/2 left-2 -translate-y-1/2 rounded-full bg-scrim/40 max-sm:hidden"
              onClick={() => go(previous)}
              disabled={!previous}
              aria-label="Previous (←)"
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-lg"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded-full bg-scrim/40 max-sm:hidden"
              onClick={() => go(next)}
              disabled={!next}
              aria-label="Next (→)"
            >
              <ChevronRight />
            </Button>
          </div>
          <nav aria-label="Move between photos" className="flex justify-between px-2 pb-2 sm:hidden">
            <Button variant="ghost" size="lg" onClick={() => go(previous)} disabled={!previous}>
              <ChevronLeft /> Previous
            </Button>
            <Button variant="ghost" size="lg" onClick={() => go(next)} disabled={!next}>
              Next <ChevronRight />
            </Button>
          </nav>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
