'use client';

import type { AssetTile } from '@memory-vault/shared';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ImageOff } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { GalleryLayout, GallerySection } from '@/components/media/gallery-layout';
import { VirtualGallery } from '@/components/media/virtual-gallery';
import { Skeleton } from '@/components/ui/skeleton';
import { PhotoViewer } from '@/components/viewer/photo-viewer';
import { usePhotoParam } from '@/components/viewer/use-photo-param';
import { formatMonth } from '@/lib/format';
import { libraryQueries } from '@/lib/library';
import { useMounted } from '@/lib/use-mounted';
import { OnThisDay } from './on-this-day';
import { TimelineScrubber } from './scrubber';

const combineMonths = (results: UseQueryResult<AssetTile[]>[]) => results.map((result) => result.data);

export function PhotosTimeline() {
  const mounted = useMounted();
  const timeline = useQuery(libraryQueries.timeline());
  const buckets = useMemo(() => timeline.data?.buckets ?? [], [timeline.data]);
  const [requested, setRequested] = useState<string[]>([]);
  const [scrubber, setScrubber] = useState<{ layout: GalleryLayout; scrollMargin: number } | null>(null);
  const viewer = usePhotoParam();
  const [viewerMonth, setViewerMonth] = useState<string | null>(null);

  // The newest months load straight away; the rest as they come near the screen.
  const wanted = useMemo(
    () => [...new Set([...buckets.slice(0, 2).map((bucket) => bucket.month), ...requested])],
    [buckets, requested],
  );
  const monthData = useQueries({
    queries: wanted.map((month) => libraryQueries.month(month)),
    combine: combineMonths,
  });
  const loaded = useMemo(() => {
    const map = new Map<string, AssetTile[]>();
    wanted.forEach((month, index) => {
      const items = monthData[index];
      if (items) map.set(month, items);
    });
    return map;
  }, [wanted, monthData]);

  const sections = useMemo<GallerySection[]>(
    () =>
      buckets.map((bucket) => ({
        key: bucket.month,
        title: formatMonth(bucket.month),
        items: loaded.get(bucket.month),
        estimate: bucket.days,
        groupByDay: true,
      })),
    [buckets, loaded],
  );

  const request = useCallback((months: string[]) => {
    setRequested((current) => {
      const missing = months.filter((month) => !current.includes(month));
      return missing.length ? [...current, ...missing] : current;
    });
  }, []);

  const onLayout = useCallback(
    (layout: GalleryLayout, scrollMargin: number) => setScrubber({ layout, scrollMargin }),
    [],
  );

  const open = useCallback(
    (id: string) => {
      setViewerMonth(sections.find((section) => section.items?.some((item) => item.id === id))?.key ?? null);
      viewer.open(id);
    },
    [sections, viewer],
  );

  // The viewer moves through the unbroken run of loaded months around the open photo,
  // and asks for the next month when it gets near either end.
  const run = useMemo(() => {
    const centre = sections.findIndex(
      (section) =>
        section.key === viewerMonth ||
        (viewer.photoId && section.items?.some((item) => item.id === viewer.photoId)),
    );
    if (centre < 0 || !sections[centre]?.items) return { items: [] as AssetTile[], before: -1, after: -1 };
    let start = centre;
    let end = centre;
    while (start > 0 && sections[start - 1]!.items) start -= 1;
    while (end < sections.length - 1 && sections[end + 1]!.items) end += 1;
    return {
      items: sections.slice(start, end + 1).flatMap((section) => section.items ?? []),
      before: start - 1,
      after: end + 1 < sections.length ? end + 1 : -1,
    };
  }, [sections, viewerMonth, viewer.photoId]);

  const onNearEdge = useCallback(
    (direction: 'previous' | 'next') => {
      const target = direction === 'next' ? run.after : run.before;
      if (target >= 0 && sections[target]) request([sections[target].key]);
    },
    [run, sections, request],
  );

  if (timeline.isPending) {
    return (
      <div className="space-y-3 px-4 py-6 sm:px-8" aria-label="Loading your photos">
        <Skeleton className="h-6 w-40" />
        <div className="grid grid-cols-3 gap-1 sm:grid-cols-5">
          {Array.from({ length: 15 }, (_, index) => (
            <Skeleton key={index} className="aspect-square rounded-none" />
          ))}
        </div>
      </div>
    );
  }
  if (timeline.isError) {
    return (
      <div role="alert" className="px-4 py-16 text-center sm:px-8">
        <p className="font-medium">Your photos couldn’t be loaded</p>
        <p className="mt-1 text-sm text-ink-muted">Check that the API is running, then try again.</p>
        <button
          type="button"
          onClick={() => void timeline.refetch()}
          className="mt-4 min-h-11 text-sm font-medium underline underline-offset-4"
        >
          Try again
        </button>
      </div>
    );
  }
  if (buckets.length === 0) {
    return (
      <div className="grid place-items-center px-4 py-24 text-center sm:px-8">
        <div className="max-w-sm">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-surface-sunken text-ink-muted ring-1 ring-border">
            <ImageOff className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-base font-semibold">No photos yet</h2>
          <p className="mt-1.5 text-sm text-ink-muted">
            Upload a folder with <code className="font-mono text-xs">pnpm vault upload</code>. Uploading from
            the browser comes in the next milestone.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      <OnThisDay />
      <div className="px-4 pt-2 pb-16 pr-12 sm:px-8 sm:pr-16">
        <VirtualGallery sections={sections} onOpen={open} onNeedSections={request} onLayout={onLayout} />
      </div>
      {scrubber && <TimelineScrubber layout={scrubber.layout} scrollMargin={scrubber.scrollMargin} />}
      {mounted && viewer.photoId && (
        <PhotoViewer
          items={run.items}
          currentId={viewer.photoId}
          onShow={viewer.show}
          onClose={viewer.close}
          onNearEdge={onNearEdge}
        />
      )}
    </>
  );
}
