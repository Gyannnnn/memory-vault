'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 WebP derivatives */
import type { AlbumSummary } from '@memory-vault/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookImage, Loader2, Plus, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { errorMessage } from '@/lib/api';
import { libraryQueries } from '@/lib/library';
import { albums } from '@/lib/organise';
import { cn } from '@/lib/utils';

const items = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`;

/** Puts the given photos into an existing album or a new one. */
export function AddToAlbumDialog({
  assetIds,
  open,
  onOpenChange,
  onAdded,
}: {
  assetIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(560px,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-md">
        <div className="flex h-14 shrink-0 items-center border-b px-5 pr-12">
          <DialogTitle className="text-base">Add to album</DialogTitle>
          <DialogDescription className="sr-only">{items(assetIds.length)} selected</DialogDescription>
        </div>
        {open && (
          <Picker
            assetIds={assetIds}
            onDone={() => {
              onOpenChange(false);
              onAdded?.();
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Picker({ assetIds, onDone }: { assetIds: string[]; onDone: () => void }) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const list = useQuery(libraryQueries.albums());
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const all = list.data?.albums;
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (all ?? []).filter((album) => !needle || album.name.toLowerCase().includes(needle));
  }, [all, filter]);

  const confirm = (album: Pick<AlbumSummary, 'id' | 'name'>, added: number) => {
    toast.success(added === 0 ? `Already in ${album.name}` : `Added ${items(added)} to ${album.name}`, {
      action: { label: 'View', onClick: () => router.push(`/albums/${album.id}`) },
    });
    onDone();
  };

  const add = async (album: AlbumSummary) => {
    setBusy(album.id);
    try {
      confirm(album, await albums.add(queryClient, album.id, assetIds));
    } catch (error) {
      toast.error('The photos weren’t added', { description: errorMessage(error) });
      setBusy(null);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy('new');
    try {
      const album = await albums.create(queryClient, trimmed, assetIds);
      confirm(album, album.count);
    } catch (error) {
      toast.error('The album wasn’t created', { description: errorMessage(error) });
      setBusy(null);
    }
  };

  const noAlbums = list.isSuccess && (all?.length ?? 0) === 0;

  return (
    <>
      <div className={cn('shrink-0 space-y-3 p-4', !noAlbums && 'border-b')}>
        {creating || noAlbums ? (
          <form onSubmit={(event) => void create(event)} className="flex gap-2">
            <label htmlFor="new-album" className="sr-only">
              New album name
            </label>
            <Input
              id="new-album"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="New album name"
              maxLength={200}
              autoFocus
              autoComplete="off"
              className="h-10"
            />
            <Button type="submit" disabled={!name.trim() || busy !== null}>
              {busy === 'new' ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
              Create
            </Button>
          </form>
        ) : (
          <Button variant="outline" className="w-full justify-start" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" /> New album
          </Button>
        )}
        {(all?.length ?? 0) > 6 && (
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-subtle"
              aria-hidden="true"
            />
            <label htmlFor="album-filter" className="sr-only">
              Find an album
            </label>
            <Input
              id="album-filter"
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Find an album"
              autoComplete="off"
              className="h-10 pl-9"
            />
          </div>
        )}
      </div>

      <div className={cn('min-h-0 flex-1 overflow-y-auto p-2', noAlbums && 'hidden')}>
        {list.isPending ? (
          <div className="space-y-2 p-2" aria-label="Loading albums">
            {Array.from({ length: 4 }, (_, index) => (
              <Skeleton key={index} className="h-12" />
            ))}
          </div>
        ) : list.isError ? (
          <p role="alert" className="p-3 text-sm text-ink-muted">
            Your albums couldn’t be loaded.
          </p>
        ) : shown.length === 0 && !noAlbums ? (
          <p className="p-3 text-sm text-ink-muted">No album called “{filter.trim()}”.</p>
        ) : (
          <ul>
            {shown.map((album) => (
              <li key={album.id}>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void add(album)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-md p-2 text-left transition-colors duration-(--duration-fast)',
                    'hover:bg-ink/[0.04] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus disabled:opacity-60',
                  )}
                >
                  <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-surface-sunken">
                    {album.cover ? (
                      <img src={album.cover.sm} alt="" className="size-full object-cover" />
                    ) : (
                      <BookImage className="size-5 text-ink-subtle" aria-hidden="true" />
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{album.name}</span>
                    <span className="block text-xs text-ink-muted tabular-nums">{items(album.count)}</span>
                  </span>
                  {busy === album.id && (
                    <Loader2 className="size-4 animate-spin text-ink-muted" aria-label="Adding" />
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
