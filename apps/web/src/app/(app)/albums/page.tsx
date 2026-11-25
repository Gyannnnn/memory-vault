import type { Metadata } from 'next';
import { AlbumsView } from '@/components/albums/albums-view';

export const metadata: Metadata = { title: 'Albums' };

export default function AlbumsPage() {
  return <AlbumsView />;
}
