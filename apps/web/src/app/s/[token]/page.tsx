import type { Metadata } from 'next';
import { SharedView } from '@/components/sharing/shared-view';

export const metadata: Metadata = {
  title: 'Shared with you',
  robots: { index: false, follow: false },
  referrer: 'no-referrer',
};

/** What a share link shows, to anyone who has it. No sign-in. */
export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <SharedView token={token} />;
}
