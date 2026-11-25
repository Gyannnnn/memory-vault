'use client';

import dynamic from 'next/dynamic';
import { PageHeader } from '@/components/page-header';
import { Skeleton } from '@/components/ui/skeleton';

// MapLibre needs the browser (WebGL); load it only there, and only on this page.
const LibraryMap = dynamic(() => import('./library-map'), {
  ssr: false,
  loading: () => <Skeleton className="size-full rounded-none" />,
});

export function MapView() {
  return (
    <div className="flex h-[calc(100dvh-7.5rem-env(safe-area-inset-bottom))] flex-col md:h-dvh">
      <PageHeader title="Map" description="Photos with a location" />
      <div className="flex min-h-0 flex-1">
        <LibraryMap />
      </div>
    </div>
  );
}
