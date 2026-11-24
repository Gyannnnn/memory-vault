import type { Metadata } from 'next';
import { BookImage } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Albums' };

export default function AlbumsPage() {
  return (
    <ComingSoon
      title="Albums"
      icon={BookImage}
      summary="Albums and favourites, plus trip albums made automatically from your travels."
      milestone="M3"
    />
  );
}
