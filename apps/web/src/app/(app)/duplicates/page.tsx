import type { Metadata } from 'next';
import { DuplicatesView } from '@/components/duplicates/duplicates-view';

export const metadata: Metadata = { title: 'Duplicates' };

export default function DuplicatesPage() {
  return <DuplicatesView />;
}
