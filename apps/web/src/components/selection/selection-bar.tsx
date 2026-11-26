'use client';

import type { CreateDownloadRequest } from '@memory-vault/shared';
import { formatBytes } from '@memory-vault/shared';
import { useQueryClient } from '@tanstack/react-query';
import { BookPlus, Download, Heart, Loader2, Trash2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AddToAlbumDialog } from '@/components/albums/add-to-album';
import { useTrash } from '@/components/trash/use-trash';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { errorMessage } from '@/lib/api';
import { startDownload } from '@/lib/downloads';
import { setFavorite } from '@/lib/organise';
import { useSelection, type Selection } from './selection';

/** Starts a zip download and says what's coming, or why it couldn't. */
export function useZipDownload() {
  const [busy, setBusy] = useState(false);
  const download = async (request: CreateDownloadRequest) => {
    setBusy(true);
    try {
      const summary = await startDownload(request);
      toast.success(`Downloading ${summary.fileName}`, {
        description: `${summary.fileCount.toLocaleString()} ${summary.fileCount === 1 ? 'file' : 'files'}, ${formatBytes(summary.totalBytes)}. Your browser shows the progress.`,
      });
      return true;
    } catch (error) {
      toast.error('The download couldn’t start', { description: errorMessage(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, download };
}

const MAX_FILES = 5000;

/** An icon button with its name in a tooltip. */
export function BarAction({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

const count = (value: number) => `${value.toLocaleString()} ${value === 1 ? 'item' : 'items'}`;

/**
 * Floats at the bottom while tiles are selected: how many, then favourite, add to an album,
 * anything the page adds (`actions`), and download as a zip.
 */
export function SelectionBar({ actions }: { actions?: (selection: Selection) => ReactNode }) {
  const selection = useSelection();
  const queryClient = useQueryClient();
  const trash = useTrash();
  const { busy, download } = useZipDownload();
  const [adding, setAdding] = useState<string[] | null>(null);
  if (!selection?.active) return null;
  const ids = [...selection.selected];
  const tiles = selection.selectedTiles();
  const allFavourite = tiles.length > 0 && tiles.every((tile) => tile.favorite);

  const favourite = () => {
    const next = !allFavourite;
    setFavorite(queryClient, ids, next).then(
      () =>
        toast.success(
          next ? `Added ${count(ids.length)} to Favourites` : `Removed ${count(ids.length)} from Favourites`,
        ),
      (error: unknown) => toast.error('Favourites weren’t changed', { description: errorMessage(error) }),
    );
  };

  return (
    <>
      <div
        role="toolbar"
        aria-label="Selected items"
        className="fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-lg items-center gap-0.5 rounded-full border bg-surface-raised p-1.5 shadow-lg md:bottom-4 md:left-[calc(var(--sidebar)+1rem)]"
      >
        <BarAction label="Clear selection (Esc)" onClick={selection.clear}>
          <X />
        </BarAction>
        <p aria-live="polite" className="min-w-0 flex-1 truncate px-1 text-sm font-medium tabular-nums">
          {ids.length.toLocaleString()}
          <span className="max-sm:sr-only"> selected</span>
        </p>
        <BarAction label={allFavourite ? 'Remove from Favourites' : 'Add to Favourites'} onClick={favourite}>
          <Heart className={allFavourite ? 'fill-current' : undefined} />
        </BarAction>
        <BarAction label="Add to album" onClick={() => setAdding(ids)}>
          <BookPlus />
        </BarAction>
        {actions?.(selection)}
        <BarAction
          label="Move to Trash"
          onClick={() => void trash.move(ids).then((moved) => moved && selection.clear())}
        >
          <Trash2 />
        </BarAction>
        <Button
          className="ml-1 rounded-full max-sm:size-10 max-sm:px-0"
          disabled={busy}
          aria-label="Download"
          onClick={() => {
            if (ids.length > MAX_FILES) {
              toast.error(`Download up to ${MAX_FILES.toLocaleString()} at a time`, {
                description: 'Select fewer, or download the whole folder or album.',
              });
              return;
            }
            void download({ assetIds: ids }).then((started) => started && selection.clear());
          }}
        >
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
          <span className="max-sm:hidden">Download</span>
        </Button>
      </div>
      <AddToAlbumDialog
        assetIds={adding ?? []}
        open={adding !== null}
        onOpenChange={(open) => !open && setAdding(null)}
        onAdded={selection.clear}
      />
    </>
  );
}
