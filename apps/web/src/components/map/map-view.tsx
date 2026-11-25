'use client';

import dynamic from 'next/dynamic';
import { Skeleton } from '@/components/ui/skeleton';

// MapLibre needs the browser (WebGL); load it only there, and only on this page.
const LibraryMap = dynamic(() => import('./library-map'), {
  ssr: false,
  loading: () => <Skeleton className="size-full rounded-none" />,
});

export function MapView() {
  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col lg:h-dvh">
      <div className="flex shrink-0 items-baseline justify-between gap-4 border-b px-4 py-4 sm:px-8">
        <h1 className="text-3xl font-medium tracking-display">Map</h1>
        <p className="hidden text-sm text-ink-muted sm:block">
          Every photo with a location. Click a circle to zoom in.
        </p>
      </div>
      <div className="flex min-h-0 flex-1">
        <LibraryMap />
      </div>
    </div>
  );
}
