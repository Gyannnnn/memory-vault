import type { Metadata } from 'next';
import { Trash2 } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Trash' };

export default function TrashPage() {
  return (
    <ComingSoon
      title="Trash"
      icon={Trash2}
      summary="Deleted items wait here for 30 days so you can restore them."
      milestone="M3"
    />
  );
}
