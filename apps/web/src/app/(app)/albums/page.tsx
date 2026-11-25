import type { Metadata } from 'next';
import { BookImage } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Albums' };

export default function AlbumsPage() {
  return (
    <ComingSoon
      title="Albums"
      icon={BookImage}
      summary="Albums, favourites, and trip albums made from where your photos were taken."
      milestone="M3"
    />
  );
}
