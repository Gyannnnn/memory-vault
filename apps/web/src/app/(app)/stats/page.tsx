import type { Metadata } from 'next';
import { ChartPie } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Storage' };

export default function StoragePage() {
  return (
    <ComingSoon
      title="Storage"
      icon={ChartPie}
      summary="Files, sizes, storage tiers and the estimated monthly AWS cost."
      milestone="M6"
    />
  );
}
