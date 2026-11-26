'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 WebP derivatives */
import type { DownloadSummary, PublicShare, SharedPage } from '@memory-vault/shared';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, Folder, Loader2, Lock } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { BrandMark } from '@/components/brand';
import { sectionsByMonth } from '@/components/media/sections';
import { VirtualGallery } from '@/components/media/virtual-gallery';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { usePhotoParam } from '@/components/viewer/use-photo-param';
import { ApiError, errorMessage } from '@/lib/api';
import { formatWallTime } from '@/lib/format';
import { shareApi, sharePath } from '@/lib/share-client';
import { useMounted } from '@/lib/use-mounted';
import { SharedMedia, SharedViewer } from './shared-viewer';

type Open = Extract<PublicShare, { status: 'open' }>;

const items = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'item' : 'items'}`;

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-sm text-center">
        <BrandMark className="mx-auto size-10" />
        {children}
      </div>
    </main>
  );
}

/** A share link, as its visitor sees it. */
export function SharedView({ token }: { token: string }) {
  const summary = useQuery({
    queryKey: ['share', token],
    queryFn: () => shareApi<PublicShare>(token),
    retry: (count, error) => !(error instanceof ApiError && error.status < 500) && count < 2,
  });

  if (summary.isPending) {
    return (
      <Centered>
        <Loader2 className="mx-auto mt-6 size-5 animate-spin text-ink-muted" aria-label="Loading" />
      </Centered>
    );
  }
  if (summary.isError) {
    const gone = summary.error instanceof ApiError && summary.error.status === 404;
    return (
      <Centered>
        <h1 className="mt-6 text-xl font-medium">
          {gone ? 'This link isn’t available' : 'Something went wrong'}
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          {gone ? 'It may have expired, or its owner turned it off.' : errorMessage(summary.error)}
        </p>
        {!gone && (
          <Button variant="outline" className="mt-6" onClick={() => void summary.refetch()}>
            Try again
          </Button>
        )}
      </Centered>
    );
  }
  if (summary.data.status === 'locked') return <PasswordGate token={token} />;
  return <SharedContent token={token} share={summary.data} />;
}

function PasswordGate({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const unlock = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      await shareApi(token, '/unlock', { method: 'POST', body: { password } });
      await queryClient.invalidateQueries({ queryKey: ['share', token] });
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  };

  return (
    <Centered>
      <h1 className="mt-6 text-xl font-medium">This link has a password</h1>
      <p className="mt-2 text-sm text-ink-muted">Ask the person who sent it.</p>
      <form onSubmit={(event) => void unlock(event)} className="mt-6 grid gap-3 text-left" noValidate>
        <label htmlFor="share-password" className="text-sm font-medium">
          Password
        </label>
        <Input
          id="share-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'share-password-error' : undefined}
          className="h-11"
        />
        {error && (
          <p id="share-password-error" role="alert" className="text-sm text-skip">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" disabled={busy || !password}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Lock aria-hidden="true" />}
          Open
        </Button>
      </form>
    </Centered>
  );
}

function SharedContent({ token, share }: { token: string; share: Open }) {
  const mounted = useMounted();
  const params = useSearchParams();
  const folder = share.kind === 'folder' ? (params.get('folder') ?? undefined) : undefined;
  const viewer = usePhotoParam();
  const [downloading, setDownloading] = useState(false);

  const page = useInfiniteQuery({
    queryKey: ['share', token, 'items', folder ?? ''],
    queryFn: ({ pageParam }) => {
      const search = new URLSearchParams({ limit: '200' });
      if (pageParam) search.set('cursor', pageParam);
      if (folder) search.set('folder', folder);
      return shareApi<SharedPage>(token, `/items?${search.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    staleTime: 45 * 60_000,
  });
  const tiles = useMemo(() => page.data?.pages.flatMap((entry) => entry.items) ?? [], [page.data]);
  const sections = useMemo(() => sectionsByMonth(tiles), [tiles]);
  const first = page.data?.pages[0];
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = page;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const downloadAll = async () => {
    setDownloading(true);
    try {
      const summary = await shareApi<DownloadSummary>(token, '/downloads', { method: 'POST', body: {} });
      const link = document.createElement('a');
      link.href = sharePath(token, `/downloads/${summary.id}`);
      link.download = summary.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      toast.success(`Downloading ${summary.fileName}`);
    } catch (error) {
      toast.error('The download couldn’t start', { description: errorMessage(error) });
    } finally {
      setDownloading(false);
    }
  };

  const single = share.kind === 'photo' ? tiles[0] : undefined;
  const title = share.title || (single ? formatWallTime(single.localAt) : 'Shared photo');

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="flex h-14 items-center gap-3 px-4 sm:px-8">
          <BrandMark className="size-7 shrink-0" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-md font-medium">{title}</h1>
            <p className="truncate text-xs text-ink-muted">
              Shared by {share.ownerName}
              {share.kind === 'photo' ? '' : ` · ${items(share.total)}`}
            </p>
          </div>
          {share.allowDownload && share.total > 0 && (
            <Button size="sm" variant="outline" disabled={downloading} onClick={() => void downloadAll()}>
              {downloading ? (
                <Loader2 className="animate-spin" aria-hidden="true" />
              ) : (
                <Download aria-hidden="true" />
              )}
              <span className="max-sm:hidden">{share.kind === 'photo' ? 'Download' : 'Download all'}</span>
            </Button>
          )}
        </div>
      </header>

      <main id="main">
        {page.isPending ? (
          <Loader2 className="mx-auto mt-16 size-5 animate-spin text-ink-muted" aria-label="Loading" />
        ) : page.isError ? (
          <p role="alert" className="px-4 py-16 text-center text-sm text-ink-muted">
            {errorMessage(page.error)}
          </p>
        ) : single ? (
          <div className="flex h-[calc(100dvh-3.5rem)] p-2 sm:p-6" data-theme="dark">
            <SharedMedia token={token} tile={single} />
          </div>
        ) : (
          <div className="px-4 pt-4 pb-16 sm:px-8">
            {share.kind === 'folder' && first?.path && first.path.length > 1 && (
              <nav aria-label="Folder path" className="mb-4 flex flex-wrap items-center gap-1.5 text-sm">
                {first.path.map((part, index) => (
                  <span key={part.id} className="flex items-center gap-1.5">
                    {index > 0 && <ChevronRight className="size-4 text-ink-subtle" aria-hidden="true" />}
                    {index === first.path!.length - 1 ? (
                      <span aria-current="page" className="font-medium">
                        {part.name}
                      </span>
                    ) : (
                      <Link
                        href={index === 0 ? '?' : `?folder=${part.id}`}
                        className="text-ink-muted hover:text-ink"
                      >
                        {part.name}
                      </Link>
                    )}
                  </span>
                ))}
              </nav>
            )}
            {first?.folders && first.folders.length > 0 && (
              <ul className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {first.folders.map((child) => (
                  <li key={child.id}>
                    <Link
                      href={`?folder=${child.id}`}
                      className="group block rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus"
                    >
                      <span className="grid aspect-[4/3] place-items-center overflow-hidden rounded-lg bg-surface-sunken">
                        {child.cover ? (
                          <img src={child.cover.sm} alt="" className="size-full object-cover" />
                        ) : (
                          <Folder className="size-6 text-ink-subtle" aria-hidden="true" />
                        )}
                      </span>
                      <span className="mt-2 block truncate text-sm font-medium">{child.name}</span>
                      <span className="block text-xs text-ink-muted tabular-nums">
                        {[
                          child.folderCount
                            ? `${child.folderCount} ${child.folderCount === 1 ? 'folder' : 'folders'}`
                            : null,
                          child.fileCount ? items(child.fileCount) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ') || 'Empty'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {tiles.length > 0 ? (
              <VirtualGallery sections={sections} onOpen={viewer.open} onEndReached={loadMore} />
            ) : (
              !first?.folders?.length && (
                <p className="py-16 text-center text-sm text-ink-muted">Nothing here.</p>
              )
            )}
            {isFetchingNextPage && (
              <Loader2
                className="mx-auto mt-6 size-5 animate-spin text-ink-muted"
                aria-label="Loading more"
              />
            )}
          </div>
        )}
      </main>

      {mounted && viewer.photoId && !single && (
        <SharedViewer
          token={token}
          items={tiles}
          currentId={viewer.photoId}
          onShow={viewer.show}
          onClose={viewer.close}
          onNearEnd={loadMore}
        />
      )}
    </div>
  );
}
