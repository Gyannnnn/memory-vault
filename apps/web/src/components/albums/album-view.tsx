'use client';

import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ImageMinus,
  ImageUp,
  Loader2,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { sectionsByMonth } from '@/components/media/sections';
import { VirtualGallery } from '@/components/media/virtual-gallery';
import { PageHeader } from '@/components/page-header';
import { SelectionProvider } from '@/components/selection/selection';
import { BarAction, SelectionBar, useZipDownload } from '@/components/selection/selection-bar';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { PhotoViewer } from '@/components/viewer/photo-viewer';
import { usePhotoParam } from '@/components/viewer/use-photo-param';
import { errorMessage } from '@/lib/api';
import { libraryQueries } from '@/lib/library';
import { albums, setFavorite } from '@/lib/organise';
import { useMounted } from '@/lib/use-mounted';
import { AlbumNameDialog } from './album-name-dialog';

const items = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`;

function AlbumsTrail() {
  return (
    <>
      <Link
        href="/albums"
        aria-label="Back to Albums"
        className="-ml-2 grid size-9 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-ink/[0.04] hover:text-ink sm:hidden"
      >
        <ChevronLeft className="size-5" aria-hidden="true" />
      </Link>
      <nav aria-label="Album path" className="hidden shrink-0 items-center gap-1.5 text-lg sm:flex">
        <Link href="/albums" className="rounded-sm text-ink-muted transition-colors hover:text-ink">
          Albums
        </Link>
        <ChevronRight className="size-4 text-ink-subtle" aria-hidden="true" />
      </nav>
    </>
  );
}

/** One album's photos, or every favourite when `albumId` is null. */
export function AlbumView({ albumId }: { albumId: string | null }) {
  const mounted = useMounted();
  const router = useRouter();
  const queryClient = useQueryClient();
  const viewer = usePhotoParam();
  const zip = useZipDownload();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const album = useQuery({ ...libraryQueries.album(albumId ?? ''), enabled: albumId !== null });
  const results = useInfiniteQuery(
    libraryQueries.search(albumId ? { album: albumId, limit: 300 } : { favorite: '1', limit: 300 }),
  );
  const tiles = useMemo(() => results.data?.pages.flatMap((page) => page.items) ?? [], [results.data]);
  const sections = useMemo(() => sectionsByMonth(tiles), [tiles]);
  const total = results.data?.pages[0]?.total;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = results;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const name = albumId ? album.data?.name : 'Favourites';
  const missing = albumId !== null && album.isError;

  const removeFromHere = async (ids: string[], clear: () => void) => {
    try {
      if (albumId) {
        const removed = await albums.removeItems(queryClient, albumId, ids);
        toast.success(`Removed ${items(removed)} from ${name ?? 'the album'}`);
      } else {
        await setFavorite(queryClient, ids, false);
        toast.success(`Removed ${items(ids.length)} from Favourites`);
      }
      clear();
    } catch (error) {
      toast.error('Nothing was removed', { description: errorMessage(error) });
    }
  };

  const deleteAlbum = async () => {
    if (!albumId) return;
    setBusy(true);
    try {
      await albums.remove(queryClient, albumId);
      toast.success(`Deleted the album “${name}”`, { description: 'Its photos are still in your library.' });
      router.push('/albums');
    } catch (error) {
      toast.error('The album wasn’t deleted', { description: errorMessage(error) });
      setBusy(false);
    }
  };

  if (missing) {
    return (
      <div role="alert" className="px-4 py-16 text-center sm:px-8">
        <p className="font-medium">This album couldn’t be opened</p>
        <p className="mt-1 text-sm text-ink-muted">It may have been deleted.</p>
        <Link
          href="/albums"
          className="mt-4 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
        >
          All albums
        </Link>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title={name ?? ' '}
        trail={<AlbumsTrail />}
        description={total === undefined ? undefined : items(total)}
        actions={
          albumId && (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={zip.busy || total === 0}
                onClick={() => void zip.download({ albumId })}
                aria-label="Download album"
              >
                {zip.busy ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Download aria-hidden="true" />
                )}
                <span className="max-sm:hidden">Download</span>
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label="More album actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onSelect={() => setRenaming(true)}>
                    <Pencil aria-hidden="true" /> Rename
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
                    <Trash2 aria-hidden="true" /> Delete album
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          )
        }
      />

      <div className="px-4 pt-2 pb-16 sm:px-8">
        {results.isPending ? (
          <div className="grid grid-cols-3 gap-1 pt-6 sm:grid-cols-5" aria-label="Loading">
            {Array.from({ length: 10 }, (_, index) => (
              <Skeleton key={index} className="aspect-square rounded-none" />
            ))}
          </div>
        ) : results.isError ? (
          <div role="alert" className="py-16 text-center">
            <p className="font-medium">These photos couldn’t be loaded</p>
            <button
              type="button"
              onClick={() => void results.refetch()}
              className="mt-3 min-h-11 text-sm font-medium underline underline-offset-4"
            >
              Try again
            </button>
          </div>
        ) : tiles.length === 0 ? (
          <div className="py-24 text-center">
            <p className="text-lg font-medium">{albumId ? 'This album is empty' : 'No favourites yet'}</p>
            <p className="mx-auto mt-1.5 max-w-sm text-sm text-ink-muted">
              {albumId
                ? 'Select photos in Photos, Search or Folders, then choose Add to album.'
                : 'Tap the heart on a photo, or select some and choose Add to Favourites.'}
            </p>
          </div>
        ) : (
          <SelectionProvider tiles={tiles}>
            <VirtualGallery sections={sections} onOpen={viewer.open} onEndReached={loadMore} />
            <SelectionBar
              actions={(selection) => (
                <>
                  {albumId && selection.selected.size === 1 && (
                    <BarAction
                      label="Use as cover"
                      onClick={() => {
                        const [id] = [...selection.selected];
                        albums.setCover(queryClient, albumId, id!).then(
                          () => {
                            toast.success('Cover changed');
                            selection.clear();
                          },
                          (error: unknown) =>
                            toast.error('The cover wasn’t changed', { description: errorMessage(error) }),
                        );
                      }}
                    >
                      <ImageUp />
                    </BarAction>
                  )}
                  <BarAction
                    label={albumId ? 'Remove from album' : 'Remove from Favourites'}
                    onClick={() => void removeFromHere([...selection.selected], selection.clear)}
                  >
                    <ImageMinus />
                  </BarAction>
                </>
              )}
            />
          </SelectionProvider>
        )}
        {isFetchingNextPage && (
          <Loader2 className="mx-auto mt-6 size-5 animate-spin text-ink-muted" aria-label="Loading more" />
        )}
      </div>

      {mounted && viewer.photoId && (
        <PhotoViewer
          items={tiles}
          currentId={viewer.photoId}
          onShow={viewer.show}
          onClose={viewer.close}
          onNearEdge={(direction) => direction === 'next' && loadMore()}
        />
      )}

      <AlbumNameDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename album"
        initial={name ?? ''}
        submitLabel="Save"
        onSubmit={async (next) => {
          await albums.rename(queryClient, albumId!, next);
          setRenaming(false);
        }}
      />

      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the album “{name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the album goes. Its {total === undefined ? '' : `${items(total)} `}stay in your library.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void deleteAlbum();
              }}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Delete album
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
