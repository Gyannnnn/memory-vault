'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 WebP derivatives */
import type { FolderFile } from '@memory-vault/shared';
import { formatBytes } from '@memory-vault/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ChevronLeft, ChevronRight, Download, Folder, FolderOpen, Loader2, Share2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MediaTile, tileLabel } from '@/components/media/media-tile';
import { PageHeader } from '@/components/page-header';
import { ShareDialog } from '@/components/sharing/share-dialog';
import { SelectionProvider } from '@/components/selection/selection';
import { SelectionBar, useZipDownload } from '@/components/selection/selection-bar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PhotoViewer } from '@/components/viewer/photo-viewer';
import { usePhotoParam } from '@/components/viewer/use-photo-param';
import { libraryQueries } from '@/lib/library';
import { useMounted } from '@/lib/use-mounted';

const count = (value: number, one: string, many: string) =>
  `${value.toLocaleString()} ${value === 1 ? one : many}`;

/**
 * The folders above this one, before its name in the page bar: the whole path from 640 px
 * (the middle folded into "…" when it is deep), a single step back on a phone.
 */
function FolderTrail({ path }: { path: { id: string; name: string }[] }) {
  const ancestors = path.slice(0, -1);
  const parent = ancestors.at(-1);
  const shown = ancestors.length > 2 ? ancestors.slice(-2) : ancestors;
  const step = <ChevronRight className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />;
  const link = 'truncate rounded-sm text-ink-muted transition-colors hover:text-ink';

  return (
    <>
      <Link
        href={parent ? `/folders/${parent.id}` : '/folders'}
        aria-label={`Back to ${parent?.name ?? 'Folders'}`}
        className="-ml-2 grid size-9 shrink-0 place-items-center rounded-md text-ink-muted hover:bg-ink/[0.04] hover:text-ink sm:hidden"
      >
        <ChevronLeft className="size-5" aria-hidden="true" />
      </Link>
      <nav aria-label="Folder path" className="hidden min-w-0 shrink-[10] text-lg sm:block">
        <ol className="flex min-w-0 items-center gap-1.5">
          <li className="flex shrink-0 items-center gap-1.5">
            <Link href="/folders" className={link}>
              Folders
            </Link>
            {step}
          </li>
          {shown.length < ancestors.length && (
            <li className="flex shrink-0 items-center gap-1.5 text-ink-subtle">
              <span aria-label={`${ancestors.length - shown.length} more folders`}>…</span>
              {step}
            </li>
          )}
          {shown.map((part) => (
            <li key={part.id} className="flex min-w-0 items-center gap-1.5">
              <Link href={`/folders/${part.id}`} className={link}>
                {part.name}
              </Link>
              {step}
            </li>
          ))}
        </ol>
      </nav>
    </>
  );
}

/** Files as a uniform grid of squares with names, only the visible rows in the page. */
function FileGrid({
  files,
  onOpen,
  onEndReached,
}: {
  files: FolderFile[];
  onOpen: (id: string) => void;
  onEndReached: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [scrollMargin, setScrollMargin] = useState(0);
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      setWidth(element.clientWidth);
      setScrollMargin(Math.round(element.getBoundingClientRect().top + window.scrollY));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, []);

  const gap = width < 640 ? 8 : 12;
  const columns = Math.max(2, Math.floor((width + gap) / ((width < 640 ? 110 : 168) + gap)));
  const cell = width ? (width - gap * (columns - 1)) / columns : 0;
  const rowHeight = cell + 40;
  const rows = Math.ceil(files.length / columns);

  const virtualizer = useWindowVirtualizer({
    count: rows,
    estimateSize: () => rowHeight,
    overscan: 4,
    scrollMargin,
  });
  useLayoutEffect(() => virtualizer.measure(), [virtualizer, rowHeight]);
  const items = virtualizer.getVirtualItems();
  const lastRow = items.at(-1)?.index ?? -1;
  useEffect(() => {
    if (rows > 0 && lastRow >= rows - 2) onEndReached();
  }, [lastRow, rows, onEndReached]);

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: rows * rowHeight }}>
      {width > 0 &&
        items.map((row) => (
          <div
            key={row.key}
            className="absolute left-0 flex w-full"
            style={{ transform: `translateY(${row.start - scrollMargin}px)`, gap, height: rowHeight }}
          >
            {files.slice(row.index * columns, row.index * columns + columns).map((file) => (
              <div key={file.entryId} style={{ width: cell }} className="min-w-0">
                <MediaTile
                  tile={file.asset}
                  width={cell}
                  height={cell}
                  onOpen={onOpen}
                  className="rounded-md"
                  label={`${file.name}, ${tileLabel(file.asset)}`}
                />
                <p className="mt-1.5 truncate text-xs" title={file.name}>
                  {file.name}
                </p>
                <p className="truncate text-xs text-ink-subtle">{formatBytes(file.sizeBytes)}</p>
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

export function FolderBrowser({ folderId }: { folderId: string | null }) {
  const mounted = useMounted();
  const listing = useInfiniteQuery(libraryQueries.folder(folderId));
  const viewer = usePhotoParam();
  const first = listing.data?.pages[0];
  const files = useMemo(() => listing.data?.pages.flatMap((page) => page.files) ?? [], [listing.data]);
  const tiles = useMemo(() => files.map((file) => file.asset), [files]);
  const zip = useZipDownload();
  const [sharing, setSharing] = useState(false);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = listing;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (listing.isPending) {
    return (
      <div className="space-y-6 px-4 py-8 sm:px-8" aria-label="Loading folder">
        <Skeleton className="h-7 w-56" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="aspect-[4/3]" />
          ))}
        </div>
      </div>
    );
  }
  if (listing.isError || !first) {
    return (
      <div role="alert" className="px-4 py-16 text-center sm:px-8">
        <p className="font-medium">This folder couldn’t be opened</p>
        <p className="mt-1 text-sm text-ink-muted">It may not exist, or the API isn’t reachable.</p>
        <Link
          href="/folders"
          className="mt-4 inline-flex min-h-11 items-center text-sm font-medium underline underline-offset-4"
        >
          Back to all folders
        </Link>
      </div>
    );
  }

  const isRoot = first.folder.path.length === 0;
  const title = isRoot ? 'Folders' : first.folder.name;

  return (
    <>
      <PageHeader
        title={title}
        trail={!isRoot && <FolderTrail path={first.folder.path} />}
        description={
          isRoot
            ? count(first.folders.length, 'source', 'sources')
            : [
                first.folders.length ? count(first.folders.length, 'folder', 'folders') : null,
                first.fileTotal ? count(first.fileTotal, 'file', 'files') : null,
              ]
                .filter(Boolean)
                .join(' · ') || 'Empty folder'
        }
        actions={
          !isRoot &&
          folderId && (
            <>
              <Button variant="outline" size="sm" onClick={() => setSharing(true)} aria-label="Share folder">
                <Share2 aria-hidden="true" />
                <span className="max-sm:hidden">Share</span>
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={zip.busy}
                onClick={() => void zip.download({ folderId })}
                aria-label="Download folder"
              >
                {zip.busy ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Download aria-hidden="true" />
                )}
                <span className="max-sm:hidden">Download</span>
              </Button>
            </>
          )
        }
      />
      {!isRoot && folderId && (
        <ShareDialog kind="folder" targetId={folderId} open={sharing} onOpenChange={setSharing} />
      )}

      <div className="space-y-8 px-4 py-6 sm:px-8">
        {first.folders.length > 0 && (
          <section aria-label="Folders">
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
              {first.folders.map((folder) => (
                <li key={folder.id}>
                  <Link
                    href={`/folders/${folder.id}`}
                    className="group block rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    <span className="relative block aspect-[4/3] overflow-hidden rounded-lg bg-surface-sunken ring-1 ring-border">
                      {folder.cover ? (
                        <img
                          src={folder.cover.sm}
                          alt=""
                          loading="lazy"
                          className="size-full object-cover transition-transform duration-(--duration-slow) group-hover:scale-[1.03] motion-reduce:group-hover:scale-100"
                        />
                      ) : (
                        <span className="grid size-full place-items-center text-ink-subtle">
                          <Folder className="size-8" strokeWidth={1.5} aria-hidden="true" />
                        </span>
                      )}
                    </span>
                    <span className="mt-2 flex items-center gap-1.5 text-sm font-medium">
                      <FolderOpen className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
                      <span className="truncate">{folder.name}</span>
                    </span>
                    <span className="block text-xs text-ink-subtle">
                      {[
                        folder.folderCount ? count(folder.folderCount, 'folder', 'folders') : null,
                        folder.fileCount ? count(folder.fileCount, 'file', 'files') : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Empty'}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {files.length > 0 && (
          <section aria-label="Files">
            <SelectionProvider key={folderId ?? 'root'} tiles={tiles}>
              <FileGrid files={files} onOpen={viewer.open} onEndReached={loadMore} />
              <SelectionBar />
            </SelectionProvider>
          </section>
        )}

        {isRoot && first.folders.length === 0 && (
          <p className="py-16 text-center text-sm text-ink-muted">
            Nothing uploaded yet. Folders appear here as each source is uploaded.
          </p>
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
    </>
  );
}
