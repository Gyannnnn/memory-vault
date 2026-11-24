'use client';

import type { CreateDownloadRequest } from '@memory-vault/shared';
import { formatBytes } from '@memory-vault/shared';
import { Download, Loader2, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api';
import { startDownload } from '@/lib/downloads';
import { useSelection } from './selection';

/** Starts a zip download and says what's coming, or why it couldn't. */
export function useZipDownload() {
  const [busy, setBusy] = useState(false);
  const download = async (request: CreateDownloadRequest) => {
    setBusy(true);
    try {
      const summary = await startDownload(request);
      toast.success(`Downloading ${summary.fileName}`, {
        description: `${summary.fileCount.toLocaleString()} ${summary.fileCount === 1 ? 'file' : 'files'}, ${formatBytes(summary.totalBytes)}. Your browser shows the progress.`,
      });
      return true;
    } catch (error) {
      toast.error('The download couldn’t start', { description: errorMessage(error) });
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, download };
}

const MAX_FILES = 5000;

/** Floats at the bottom while tiles are selected: how many, download them as a zip, or clear. */
export function SelectionBar() {
  const selection = useSelection();
  const { busy, download } = useZipDownload();
  if (!selection?.active) return null;
  const count = selection.selected.size;

  return (
    <div
      role="toolbar"
      aria-label="Selected items"
      className="fixed inset-x-4 bottom-4 z-40 mx-auto flex max-w-md items-center gap-1 rounded-full border bg-surface-raised p-1.5 shadow-lg"
    >
      <Button variant="ghost" size="icon" onClick={selection.clear} aria-label="Clear selection (Esc)">
        <X />
      </Button>
      <p aria-live="polite" className="flex-1 px-1 text-sm font-medium tabular-nums">
        {count.toLocaleString()} selected
      </p>
      <Button
        className="rounded-full"
        disabled={busy}
        onClick={() => {
          if (count > MAX_FILES) {
            toast.error(`Download up to ${MAX_FILES.toLocaleString()} at a time`, {
              description: 'Select fewer, or download the whole folder from Folders.',
            });
            return;
          }
          void download({ assetIds: [...selection.selected] }).then(
            (started) => started && selection.clear(),
          );
        }}
      >
        {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
        Download
      </Button>
    </div>
  );
}
