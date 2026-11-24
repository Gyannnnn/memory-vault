import type { Metadata } from 'next';
import { Images } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Photos' };

export default function PhotosPage() {
  return (
    <ComingSoon
      title="Photos"
      icon={Images}
      summary="Your whole library as a timeline, with a year and month scrubber, a photo viewer and “On this day”."
      milestone="M1"
    />
  );
}
