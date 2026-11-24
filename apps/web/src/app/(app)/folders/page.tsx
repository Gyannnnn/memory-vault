import type { Metadata } from 'next';
import { Folder } from 'lucide-react';
import { ComingSoon } from '@/components/coming-soon';

export const metadata: Metadata = { title: 'Folders' };

export default function FoldersPage() {
  return (
    <ComingSoon
      title="Folders"
      icon={Folder}
      summary="The original folder trees from your laptop and phone, exactly as they were."
      milestone="M1"
    />
  );
}
