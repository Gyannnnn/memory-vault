'use client';

import { useQuery } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
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
          ? `${count(data.total)} photos and videos${
              data.pending > 0
                ? ` · ${count(data.pending)} still being processed (previews appear as they finish)`
                : ''
            }`
          : undefined
      }
      actions={
        <Button asChild variant="outline">
          <Link href="/search">
            <Search aria-hidden="true" />
            Search
          </Link>
        </Button>
      }
    />
  );
}
