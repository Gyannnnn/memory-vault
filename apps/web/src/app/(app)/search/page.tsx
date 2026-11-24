import type { Metadata } from 'next';
import { Search } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Search' };

export default function SearchPage() {
  return (
    <ComingSoon
      title="Search"
      icon={Search}
      summary="Search by place, date, camera, file name, folder, people and text inside photos, with filter chips."
      milestone="M1"
    />
  );
}
