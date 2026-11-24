import type { Metadata } from 'next';
import { PhotosHeader } from '@/components/timeline/photos-header';
import { PhotosTimeline } from '@/components/timeline/photos-timeline';

export const metadata: Metadata = { title: 'Photos' };

export default function PhotosPage() {
  return (
    <>
      <PhotosHeader />
      <PhotosTimeline />
    </>
  );
}
