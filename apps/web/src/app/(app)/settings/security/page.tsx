import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { SecuritySettings } from './security-settings';

export const metadata: Metadata = { title: 'Security' };

export default function SecurityPage() {
  return (
    <>
      <PageHeader title="Security" />
      <SecuritySettings />
    </>
  );
}
