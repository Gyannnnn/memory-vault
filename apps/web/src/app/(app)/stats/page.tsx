import type { Metadata } from 'next';
import { ChartPie, HardDriveDownload } from 'lucide-react';
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
      <section aria-labelledby="export" className="mx-4 mb-16 rounded-lg border bg-surface p-5 sm:mx-8">
        <div className="flex items-start gap-3">
          <HardDriveDownload className="mt-0.5 size-5 shrink-0 text-ink-muted" aria-hidden="true" />
          <div className="min-w-0">
            <h2 id="export" className="text-base font-semibold">
              Take everything with you
            </h2>
            <p className="mt-1 max-w-prose text-sm text-ink-muted">
              One command copies every original out of your vault into a folder on this computer or a drive:
              the same folders and names it came from, each file checked against its SHA-256, with a catalogue
              of every file and a README. Run it again to resume or to add what’s new. Nothing in the vault
              changes.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-surface-sunken px-3 py-2 font-mono text-sm">
              <code>pnpm vault export /path/to/folder</code>
            </pre>
            <p className="mt-2 text-xs text-ink-subtle">
              To download a few files or one folder instead, select them in Photos, Search or Folders.
            </p>
          </div>
        </div>
      </section>
    </ComingSoon>
  );
}
