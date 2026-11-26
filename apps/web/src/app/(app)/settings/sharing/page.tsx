import type { Metadata } from 'next';
import { SharingSettings } from './sharing-settings';

export const metadata: Metadata = { title: 'Sharing' };

export default function SharingPage() {
  return <SharingSettings />;
}
