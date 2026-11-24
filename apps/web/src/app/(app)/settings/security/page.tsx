import type { Metadata } from 'next';
import { PageHeader } from '@/components/page-header';
import { SecuritySettings } from './security-settings';

export const metadata: Metadata = { title: 'Security' };

export default function SecurityPage() {
  return (
    <>
      <PageHeader title="Security" description="How you sign in, and where you're signed in." />
      <SecuritySettings />
    </>
  );
}
