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
    >
      <section aria-labelledby="export" className="mx-4 mb-16 border-t pt-8 sm:mx-8">
        <h2 id="export" className="text-lg font-medium">
          Export everything
        </h2>
        <p className="mt-1.5 max-w-prose text-sm text-ink-muted">
          Every original, in the folders it came from, checked against its SHA-256. Run it again to resume or
          to add new files.
        </p>
        <pre className="mt-4 max-w-xl overflow-x-auto rounded-md border bg-surface-sunken px-3 py-2.5 font-mono text-sm">
          <code>pnpm vault export /path/to/folder</code>
        </pre>
        <p className="mt-3 text-xs text-ink-muted">
          For a few files or one folder, select them in Photos, Search or Folders and download.
        </p>
      </section>
    </ComingSoon>
  );
}
