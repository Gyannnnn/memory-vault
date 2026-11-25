import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AlbumView } from '@/components/albums/album-view';

export const metadata: Metadata = { title: 'Albums' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One album, or Favourites at /albums/favorites. */
export default async function AlbumPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id !== 'favorites' && !UUID.test(id)) notFound();
  return <AlbumView key={id} albumId={id === 'favorites' ? null : id} />;
}
