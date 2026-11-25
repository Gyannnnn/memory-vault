'use client';

import { formatBytes, formatDuration } from '@memory-vault/shared';
import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  Copy,
  FileUp,
  FolderUp,
  Loader2,
  Pause,
  Play,
  RotateCw,
  Upload,
} from 'lucide-react';
import { useId, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { fromInput } from '@/lib/upload/collect';
import type { UploadItem, UploadSnapshot } from '@/lib/upload/engine';
import { cn } from '@/lib/utils';
import { useUploads } from './upload-provider';

const SHOWN = 300;

function statusText(item: UploadItem): string {
  switch (item.status) {
    case 'queued':
      return 'Waiting';
    case 'hashing':
      return `Checking ${item.size ? Math.floor((item.hashed / item.size) * 100) : 100}%`;
    case 'uploading':
      return `${formatBytes(item.sent)} of ${formatBytes(item.size)}`;
    case 'paused':
      return 'Paused';
    case 'done':
      return 'Uploaded';
    case 'duplicate':
      return 'Already in your vault';
    case 'failed':
      return item.error ?? 'Failed';
  }
}

function StatusIcon({ item }: { item: UploadItem }) {
  const className = 'size-4 shrink-0';
  if (item.status === 'done')
    return <CheckCircle2 className={cn(className, 'text-keep')} aria-hidden="true" />;
  if (item.status === 'duplicate')
    return <Copy className={cn(className, 'text-ink-subtle')} aria-hidden="true" />;
  if (item.status === 'failed')
    return <AlertCircle className={cn(className, 'text-skip')} aria-hidden="true" />;
  if (item.status === 'hashing' || item.status === 'uploading')
    return <Loader2 className={cn(className, 'animate-spin text-ink-muted')} aria-hidden="true" />;
  return <CircleDashed className={cn(className, 'text-ink-subtle')} aria-hidden="true" />;
}

/** "12 of 40 files · 120 MB of 1.2 GB · 3.2 MB/s · about 5 min left" */
export function summary(snapshot: UploadSnapshot): string {
  const { counts } = snapshot;
  const total = snapshot.items.length - counts.failed;
  const finished = counts.done + counts.duplicate;
  const parts = [
    `${finished.toLocaleString()} of ${total.toLocaleString()} ${total === 1 ? 'file' : 'files'}`,
    `${formatBytes(snapshot.doneBytes)} of ${formatBytes(snapshot.totalBytes)}`,
  ];
  if (snapshot.paused) parts.push('paused');
  else if (snapshot.busy && snapshot.bytesPerSecond > 0) {
    parts.push(`${formatBytes(snapshot.bytesPerSecond)}/s`);
    if (snapshot.etaSeconds !== null) parts.push(`about ${formatDuration(snapshot.etaSeconds)} left`);
  }
  return parts.join(' · ');
}

export function UploadPanel() {
  const { manager, snapshot, open, setOpen, add } = useUploads();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const progressId = useId();
  const { counts } = snapshot;
  const fraction = snapshot.totalBytes > 0 ? snapshot.doneBytes / snapshot.totalBytes : 0;
  // Waiting and failed files first: they're what needs attention.
  const ordered = [...snapshot.items].sort((a, b) => rank(a) - rank(b));
  const pending = counts.queued + counts.hashing + counts.uploading + counts.paused;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 bg-surface p-0 sm:max-w-md">
        <SheetHeader className="border-b px-5 py-4">
          <SheetTitle>Upload</SheetTitle>
          <SheetDescription>
            Photos and videos go straight to your vault, checked as they arrive. Files already in it aren’t
            uploaded twice.
          </SheetDescription>
        </SheetHeader>

        <div className="border-b px-5 py-4">
          <div className="grid gap-2 rounded-lg border border-dashed px-4 py-5 text-center">
            <Upload className="mx-auto size-6 text-ink-subtle" aria-hidden="true" />
            <p className="text-sm text-ink-muted">Drop files or folders anywhere on the page, or</p>
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="outline" onClick={() => filesInput.current?.click()}>
                <FileUp aria-hidden="true" /> Choose files
              </Button>
              <Button variant="outline" onClick={() => folderInput.current?.click()}>
                <FolderUp aria-hidden="true" /> Choose a folder
              </Button>
            </div>
          </div>
          <input
            ref={filesInput}
            type="file"
            multiple
            hidden
            data-upload="files"
            onChange={(event) => {
              add(fromInput(event.currentTarget.files));
              event.currentTarget.value = '';
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            hidden
            data-upload="folder"
            // Non-standard but supported by every current browser: pick a whole folder.
            {...{ webkitdirectory: '' }}
            onChange={(event) => {
              add(fromInput(event.currentTarget.files));
              event.currentTarget.value = '';
            }}
          />
        </div>

        {snapshot.items.length > 0 && (
          <div className="border-b px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <p id={progressId} className="text-sm" aria-live="polite">
                {summary(snapshot)}
              </p>
              {pending > 0 &&
                (snapshot.paused ? (
                  <Button size="sm" variant="outline" onClick={() => manager.resume()}>
                    <Play aria-hidden="true" /> Resume
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => manager.pause()}>
                    <Pause aria-hidden="true" /> Pause
                  </Button>
                ))}
            </div>
            <div
              role="progressbar"
              aria-labelledby={progressId}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fraction * 100)}
              className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
            >
              <div
                className="h-full rounded-full bg-primary transition-[width] duration-(--duration-base)"
                style={{ width: `${fraction * 100}%` }}
              />
            </div>
            {pending === 0 && counts.done + counts.duplicate > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 -ml-2"
                onClick={() => manager.clearFinished()}
              >
                Clear finished
              </Button>
            )}
          </div>
        )}

        <ul className="min-h-0 flex-1 divide-y overflow-y-auto" aria-label="Files">
          {ordered.slice(0, SHOWN).map((item) => (
            <li key={item.id} className="flex items-center gap-3 px-5 py-2.5">
              <StatusIcon item={item} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm" title={item.path}>
                  {item.path}
                </p>
                <p
                  className={cn(
                    'truncate text-xs',
                    item.status === 'failed' ? 'text-skip' : 'text-ink-subtle',
                  )}
                >
                  {statusText(item)}
                </p>
              </div>
              {item.status === 'failed' && (
                <Button size="sm" variant="ghost" onClick={() => manager.retry(item.id)}>
                  <RotateCw aria-hidden="true" /> Retry
                </Button>
              )}
            </li>
          ))}
          {ordered.length > SHOWN && (
            <li className="px-5 py-3 text-xs text-ink-subtle">
              and {(ordered.length - SHOWN).toLocaleString()} more
            </li>
          )}
        </ul>
      </SheetContent>
    </Sheet>
  );
}

function rank(item: UploadItem): number {
  return { failed: 0, uploading: 1, hashing: 2, paused: 3, queued: 4, done: 5, duplicate: 6 }[item.status];
}

/** In the sidebar and the phone header. */
export function UploadButton({ compact = false }: { compact?: boolean }) {
  const { setOpen } = useUploads();
  return compact ? (
    <Button variant="ghost" size="icon-lg" aria-label="Upload" onClick={() => setOpen(true)}>
      <Upload />
    </Button>
  ) : (
    <Button className="w-full justify-start" onClick={() => setOpen(true)}>
      <Upload aria-hidden="true" /> Upload
    </Button>
  );
}

/** While the panel is closed: how uploads are going, one click from the panel. */
export function UploadProgressPill() {
  const { snapshot, open, setOpen } = useUploads();
  const { counts } = snapshot;
  const pending = counts.queued + counts.hashing + counts.uploading + counts.paused;
  if (open || (pending === 0 && counts.failed === 0)) return null;
  const fraction = snapshot.totalBytes > 0 ? snapshot.doneBytes / snapshot.totalBytes : 0;
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="fixed bottom-4 left-4 z-40 flex min-h-11 items-center gap-2 rounded-full border bg-surface-raised px-4 text-sm shadow-lg lg:left-[248px]"
    >
      {counts.failed > 0 && pending === 0 ? (
        <AlertCircle className="size-4 text-skip" aria-hidden="true" />
      ) : snapshot.paused ? (
        <Pause className="size-4" aria-hidden="true" />
      ) : (
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
      )}
      <span className="tabular-nums">
        {counts.failed > 0 && pending === 0
          ? `${counts.failed} ${counts.failed === 1 ? 'upload' : 'uploads'} failed`
          : `Uploading ${Math.floor(fraction * 100)}%${snapshot.paused ? ' (paused)' : ''}`}
      </span>
    </button>
  );
}
