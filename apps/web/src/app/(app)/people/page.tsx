import type { Metadata } from 'next';
import { Users } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'People' };

export default function PeoplePage() {
  return (
    <ComingSoon
      title="People"
      icon={Users}
      summary="Faces grouped into people, recognised on this computer only."
      milestone="M4"
    />
  );
}
