'use client';

import { formatBytes, type TrashItem, type TrashPage } from '@memory-vault/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, RotateCcw, Trash2, TriangleAlert, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { MediaTile, tileLabel } from '@/components/media/media-tile';
import { PageHeader } from '@/components/page-header';
import { SelectionProvider, useSelection } from '@/components/selection/selection';
import { BarAction } from '@/components/selection/selection-bar';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PhotoViewer } from '@/components/viewer/photo-viewer';
import { usePhotoParam } from '@/components/viewer/use-photo-param';
import { api, errorMessage } from '@/lib/api';
import { trash } from '@/lib/organise';
import { useMounted } from '@/lib/use-mounted';
import { useTrash } from './use-trash';

const DAY_MS = 86_400_000;
const items = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`;

/** "12 days left", "Last day", or "Deleting" once it's due. */
function timeLeft(item: TrashItem, now: number): string {
  const left = Date.parse(item.purgeAt) - now;
  if (left <= 0) return item.purgeError ? 'Waiting to delete' : 'Deleting';
  const days = Math.ceil(left / DAY_MS);
  return days <= 1 ? 'Last day' : `${days} days left`;
}

/** Restore or delete now, for what's selected. */
function TrashBar({ onDelete }: { onDelete: (ids: string[]) => void }) {
  const selection = useSelection();
  const { restore } = useTrash();
  if (!selection?.active) return null;
  const ids = [...selection.selected];
  return (
    <div
      role="toolbar"
      aria-label="Selected items"
      className="fixed inset-x-4 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-md items-center gap-1 rounded-full border bg-surface-raised p-1.5 shadow-lg md:bottom-4 md:left-[calc(var(--sidebar)+1rem)]"
    >
      <BarAction label="Clear selection (Esc)" onClick={selection.clear}>
        <X />
      </BarAction>
      <p aria-live="polite" className="min-w-0 flex-1 truncate px-1 text-sm font-medium tabular-nums">
        {ids.length.toLocaleString()}
        <span className="max-sm:sr-only"> selected</span>
      </p>
      <Button
        variant="ghost"
        className="rounded-full"
        onClick={() => void restore(ids).then((done) => done && selection.clear())}
      >
        <RotateCcw aria-hidden="true" /> Restore
      </Button>
      <Button className="rounded-full" variant="destructive" onClick={() => onDelete(ids)}>
        <Trash2 aria-hidden="true" /> <span className="max-sm:hidden">Delete now</span>
        <span className="sm:hidden">Delete</span>
      </Button>
    </div>
  );
}

export function TrashView() {
  const mounted = useMounted();
  const queryClient = useQueryClient();
  const viewer = usePhotoParam();
  const [deleting, setDeleting] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  // One clock per render of the list is plenty for "days left".
  const [now] = useState(() => Date.now());

  const list = useInfiniteQuery({
    queryKey: ['trash'],
    queryFn: ({ pageParam }) =>
      api<TrashPage>(`/trash?limit=200${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // Something due is being deleted by the worker: check back until it's gone.
    refetchInterval: (query) => ((query.state.data?.pages[0]?.summary?.due ?? 0) > 0 ? 10_000 : false),
  });
  const tiles = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const summary = list.data?.pages[0]?.summary;

  const deleteNow = async () => {
    if (!deleting) return;
    setBusy(true);
    try {
      const requested = await trash.deleteNow(queryClient, deleting);
      toast(`Deleting ${items(requested)}`, { description: 'They leave Trash in a moment.' });
      setDeleting(null);
    } catch (error) {
      toast.error('Nothing was deleted', { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Trash"
        description={
          summary && summary.count > 0 ? `${items(summary.count)} · ${formatBytes(summary.bytes)}` : undefined
        }
      />

      <div className="px-4 py-5 sm:px-8">
        <p className="text-sm text-ink-muted">Items are deleted for good 30 days after you move them here.</p>

        {summary?.problem && summary.due > 0 && (
          <div
            role="status"
            className="mt-4 flex max-w-3xl gap-3 rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
            <div>
              <p className="font-medium">{items(summary.due)} waiting to be deleted</p>
              <p className="mt-0.5 text-ink-muted">{summary.problem}</p>
            </div>
          </div>
        )}

        {list.isPending ? (
          <ul
            className="mt-6 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6"
            aria-label="Loading Trash"
          >
            {Array.from({ length: 12 }, (_, index) => (
              <li key={index}>
                <Skeleton className="aspect-square rounded-md" />
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <div role="alert" className="py-16 text-center">
            <p className="font-medium">Trash couldn’t be loaded</p>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="mt-3 min-h-11 text-sm font-medium underline underline-offset-4"
            >
              Try again
            </button>
          </div>
        ) : tiles.length === 0 ? (
          <div className="py-24 text-center">
            <Trash2 className="mx-auto size-6 text-ink-subtle" strokeWidth={1.6} aria-hidden="true" />
            <p className="mt-4 text-lg font-medium">Trash is empty</p>
          </div>
        ) : (
          <SelectionProvider tiles={tiles}>
            <ul className="mt-6 grid grid-cols-3 gap-x-2 gap-y-4 pb-16 sm:grid-cols-4 lg:grid-cols-6 2xl:grid-cols-8">
              {tiles.map((item) => (
                <li key={item.id}>
                  <MediaTile
                    tile={item}
                    onOpen={viewer.open}
                    className="aspect-square rounded-md"
                    style={{ height: 'auto' }}
                    sizes="(min-width: 1024px) 200px, 33vw"
                    label={`${tileLabel(item)}, ${timeLeft(item, now)}`}
                  />
                  <p
                    className={
                      item.purgeError
                        ? 'mt-1.5 truncate text-xs text-warning'
                        : 'mt-1.5 truncate text-xs text-ink-muted tabular-nums'
                    }
                  >
                    {timeLeft(item, now)}
                  </p>
                </li>
              ))}
            </ul>
            {list.hasNextPage && (
              <div className="flex justify-center pb-16">
                <Button
                  variant="outline"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Show more
                </Button>
              </div>
            )}
            <TrashBar onDelete={setDeleting} />
          </SelectionProvider>
        )}
      </div>

      {mounted && viewer.photoId && (
        <PhotoViewer items={tiles} currentId={viewer.photoId} onShow={viewer.show} onClose={viewer.close} />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {items(deleting?.length ?? 0)} for good?</AlertDialogTitle>
            <AlertDialogDescription>You can’t restore them from Trash after this.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep in Trash</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void deleteNow();
              }}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Delete for good
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
