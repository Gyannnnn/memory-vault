'use client';

import { useQuery } from '@tanstack/react-query';
import { PageHeader } from '@/components/page-header';
import { libraryQueries } from '@/lib/library';

const count = (value: number) => value.toLocaleString();

export function PhotosHeader() {
  const timeline = useQuery(libraryQueries.timeline());
  const data = timeline.data;
  return (
    <PageHeader
      title="Photos"
      description={
        data && data.total > 0
          ? `${count(data.total)} photos and videos${data.pending > 0 ? ` · ${count(data.pending)} processing` : ''}`
          : undefined
      }
    />
  );
}
