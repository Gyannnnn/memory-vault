import type { Metadata } from 'next';
import { Map } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Map' };

export default function MapPage() {
  return (
    <ComingSoon
      title="Map"
      icon={Map}
      summary="Every photo with a location on a map, clustered as you zoom."
      milestone="M1"
    />
  );
}
