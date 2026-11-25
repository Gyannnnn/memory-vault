'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 WebP derivatives */
import type { MediaUrls } from '@memory-vault/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookImage, Heart, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { libraryQueries } from '@/lib/library';
import { albums } from '@/lib/organise';
import { AlbumNameDialog } from './album-name-dialog';

const items = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`;

function AlbumCard({
  href,
  name,
  count,
  cover,
  empty: Empty,
}: {
  href: string;
  name: string;
  count: number;
  cover: MediaUrls | null;
  empty: typeof BookImage;
}) {
  return (
    <li>
      <Link
        href={href}
        className="group block rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
      >
        <span className="relative grid aspect-square place-items-center overflow-hidden rounded-lg bg-surface-sunken ring-1 ring-border/60 ring-inset">
          {cover ? (
            <img
              src={cover.md}
              alt=""
              loading="lazy"
              className="size-full object-cover transition-transform duration-(--duration-slow) group-hover:scale-[1.03] motion-reduce:group-hover:scale-100"
            />
          ) : (
            <Empty className="size-7 text-ink-subtle" strokeWidth={1.6} aria-hidden="true" />
          )}
        </span>
        <span className="mt-2 block truncate text-sm font-medium">{name}</span>
        <span className="block text-xs text-ink-muted tabular-nums">{items(count)}</span>
      </Link>
    </li>
  );
}

export function AlbumsView() {
  const list = useQuery(libraryQueries.albums());
  const queryClient = useQueryClient();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const count = list.data?.albums.length;

  return (
    <>
      <PageHeader
        title="Albums"
        description={
          count === undefined ? undefined : `${count.toLocaleString()} ${count === 1 ? 'album' : 'albums'}`
        }
        actions={
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" /> New album
          </Button>
        }
      />

      <div className="px-4 py-6 sm:px-8">
        {list.isPending ? (
          <ul
            className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
            aria-label="Loading albums"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <li key={index}>
                <Skeleton className="aspect-square rounded-lg" />
                <Skeleton className="mt-2 h-4 w-2/3" />
              </li>
            ))}
          </ul>
        ) : list.isError ? (
          <div role="alert" className="py-16 text-center">
            <p className="font-medium">Your albums couldn’t be loaded</p>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="mt-3 min-h-11 text-sm font-medium underline underline-offset-4"
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              <AlbumCard
                href="/albums/favorites"
                name="Favourites"
                count={list.data.favorites.count}
                cover={list.data.favorites.cover}
                empty={Heart}
              />
              {list.data.albums.map((album) => (
                <AlbumCard
                  key={album.id}
                  href={`/albums/${album.id}`}
                  name={album.name}
                  count={album.count}
                  cover={album.cover}
                  empty={BookImage}
                />
              ))}
            </ul>
            {list.data.albums.length === 0 && (
              <p className="mt-10 max-w-sm text-sm text-ink-muted">
                Select photos in Photos, Search or Folders, then choose Add to album.
              </p>
            )}
          </>
        )}
      </div>

      <AlbumNameDialog
        open={creating}
        onOpenChange={setCreating}
        title="New album"
        submitLabel="Create"
        onSubmit={async (name) => {
          const album = await albums.create(queryClient, name);
          setCreating(false);
          router.push(`/albums/${album.id}`);
        }}
      />
    </>
  );
}
