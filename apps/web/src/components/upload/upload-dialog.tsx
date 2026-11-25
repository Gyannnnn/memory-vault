'use client';

import { formatBytes, formatDuration, mediaKindOf } from '@memory-vault/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  AlertCircle,
  Check,
  ChevronUp,
  CloudUpload,
  Copy,
  File as FileIcon,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  FolderUp,
  Loader2,
  Pause,
  Play,
  RotateCw,
  Upload,
  X,
} from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fromInput } from '@/lib/upload/collect';
import type { UploadItem, UploadSnapshot, UploadStatus } from '@/lib/upload/engine';
import { cn } from '@/lib/utils';
import { useUploads } from './upload-provider';

type Filter = 'all' | 'active' | 'done' | 'duplicate' | 'failed';

const FILTERS: { key: Filter; label: string; statuses: UploadStatus[] }[] = [
  { key: 'all', label: 'All', statuses: [] },
  { key: 'active', label: 'In progress', statuses: ['queued', 'hashing', 'uploading', 'paused'] },
  { key: 'done', label: 'Uploaded', statuses: ['done'] },
  { key: 'duplicate', label: 'Already in vault', statuses: ['duplicate'] },
  { key: 'failed', label: 'Failed', statuses: ['failed'] },
];

const ROW_HEIGHT = 60;

/** Overall state in a few words, for the dialog and the minimised card. */
export function headline(snapshot: UploadSnapshot): string {
  const { counts } = snapshot;
  const finished = counts.done + counts.duplicate;
  const pending = counts.queued + counts.hashing + counts.uploading + counts.paused;
  const files = (count: number) => `${count.toLocaleString()} ${count === 1 ? 'file' : 'files'}`;
  if (pending > 0) return `${snapshot.paused ? 'Paused' : 'Uploading'} ${files(pending)}`;
  if (counts.failed > 0) return `${files(counts.failed)} ${counts.failed === 1 ? 'needs' : 'need'} attention`;
  return `${files(finished)} uploaded`;
}

const timeLeft = (snapshot: UploadSnapshot): string | null => {
  if (snapshot.paused || !snapshot.busy || snapshot.etaSeconds === null) return null;
  return snapshot.etaSeconds < 1 ? 'finishing…' : `about ${formatDuration(snapshot.etaSeconds)} left`;
};

/** "7 of 8 done · 120 MB of 1.2 GB · 3.2 MB/s · about 5 min left" */
export function detail(snapshot: UploadSnapshot): string {
  const { counts } = snapshot;
  const finished = counts.done + counts.duplicate;
  const pending = counts.queued + counts.hashing + counts.uploading + counts.paused;
  if (pending === 0 && counts.failed > 0)
    return `${finished.toLocaleString()} done · ${counts.failed.toLocaleString()} failed. Check your connection, then retry.`;
  const parts = [`${formatBytes(snapshot.doneBytes)} of ${formatBytes(snapshot.totalBytes)}`];
  if (pending > 0)
    parts.unshift(`${finished.toLocaleString()} of ${(finished + pending).toLocaleString()} done`);
  if (!snapshot.paused && snapshot.busy && snapshot.bytesPerSecond > 0)
    parts.push(`${formatBytes(snapshot.bytesPerSecond)}/s`);
  const left = timeLeft(snapshot);
  if (left) parts.push(left);
  return parts.join(' · ');
}

/** Share of all chosen bytes that are in the vault; failed files count as not done. */
const percentOf = (snapshot: UploadSnapshot) => {
  const failedBytes = snapshot.items.reduce(
    (sum, item) => sum + (item.status === 'failed' ? item.size : 0),
    0,
  );
  const total = snapshot.totalBytes + failedBytes;
  return total > 0 ? Math.floor((snapshot.doneBytes / total) * 100) : 100;
};

function KindIcon({ path }: { path: string }) {
  const kind = mediaKindOf(path);
  const Icon =
    kind === 'photo' || kind === 'raw'
      ? FileImage
      : kind === 'video'
        ? FileVideo
        : kind === 'audio'
          ? FileAudio
          : kind === 'document'
            ? FileText
            : FileIcon;
  return (
    <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-ink-muted ring-1 ring-border">
      <Icon className="size-4" aria-hidden="true" />
    </span>
  );
}

function Status({ item, onRetry }: { item: UploadItem; onRetry: () => void }) {
  switch (item.status) {
    case 'done':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-keep">
          <Check className="size-3.5" aria-hidden="true" /> Uploaded
        </span>
      );
    case 'duplicate':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted">
          <Copy className="size-3" aria-hidden="true" /> Already in vault
        </span>
      );
    case 'failed':
      return (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCw aria-hidden="true" /> Retry
        </Button>
      );
    case 'uploading':
      return (
        <span className="text-xs text-ink-muted tabular-nums">
          {item.size ? Math.floor((item.sent / item.size) * 100) : 100}%
        </span>
      );
    case 'hashing':
      return <span className="text-xs text-ink-muted">Checking</span>;
    case 'paused':
      return <span className="text-xs text-ink-muted">Paused</span>;
    case 'queued':
      return <span className="text-xs text-ink-subtle">Waiting</span>;
  }
}

function Row({ item, onRetry }: { item: UploadItem; onRetry: () => void }) {
  const slash = item.path.lastIndexOf('/');
  const folder = slash > 0 ? item.path.slice(0, slash) : null;
  const moving = item.status === 'uploading' || item.status === 'hashing';
  const fraction = !item.size
    ? 1
    : item.status === 'hashing'
      ? item.hashed / item.size
      : item.status === 'uploading' || item.status === 'paused'
        ? item.sent / item.size
        : 0;
  return (
    <div className="flex h-full items-center gap-3 px-6">
      <KindIcon path={item.path} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium" title={item.path}>
          {item.name}
        </p>
        {item.status === 'failed' ? (
          <p className="truncate text-xs text-skip" title={item.error}>
            {item.error ?? 'Failed'}
          </p>
        ) : moving || item.status === 'paused' ? (
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-(--duration-base)',
                  item.status === 'hashing' ? 'bg-ink-subtle' : 'bg-focus',
                )}
                style={{ width: `${fraction * 100}%` }}
              />
            </div>
            <span className="shrink-0 text-xs text-ink-subtle tabular-nums">{formatBytes(item.size)}</span>
          </div>
        ) : (
          <p className="truncate text-xs text-ink-subtle">
            {[folder, formatBytes(item.size)].filter(Boolean).join(' · ')}
          </p>
        )}
      </div>
      <div className="flex shrink-0 justify-end sm:w-32">
        <Status item={item} onRetry={onRetry} />
      </div>
    </div>
  );
}

function FileList({ items, onRetry }: { items: readonly UploadItem[]; onRetry: (id: string) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- not compiled; nothing memoized receives it
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto" role="list" aria-label="Files">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((row) => {
          const item = items[row.index]!;
          return (
            <div
              key={item.id}
              role="listitem"
              className="absolute inset-x-0 border-b border-border/60"
              style={{ height: ROW_HEIGHT, transform: `translateY(${row.start}px)` }}
            >
              <Row item={item} onRetry={() => onRetry(item.id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DropZone({
  compact,
  dragging,
  onFiles,
  onFolder,
}: {
  compact: boolean;
  dragging: boolean;
  onFiles: () => void;
  onFolder: () => void;
}) {
  const frame = cn(
    'rounded-xl border-2 border-dashed transition-colors duration-(--duration-fast)',
    dragging ? 'border-focus bg-selection' : 'border-border-strong bg-surface-sunken/40',
  );
  if (compact) {
    return (
      <div className={cn(frame, 'flex flex-wrap items-center gap-3 px-4 py-3')}>
        <CloudUpload
          className={cn('size-5 shrink-0', dragging ? 'text-focus' : 'text-ink-subtle')}
          aria-hidden="true"
        />
        <p className="min-w-0 flex-1 text-sm text-ink-muted">
          {dragging ? (
            'Drop to add them'
          ) : (
            <>
              <span className="sm:hidden">Add more</span>
              <span className="max-sm:hidden">Drop more files or folders here, or</span>
            </>
          )}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onFiles}>
            <Upload aria-hidden="true" /> Files
          </Button>
          <Button size="sm" variant="outline" onClick={onFolder}>
            <FolderUp aria-hidden="true" /> Folder
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className={cn(frame, 'flex flex-col items-center px-6 py-10 text-center sm:py-12')}>
      <span
        className={cn(
          'grid size-14 place-items-center rounded-full ring-1 transition-colors duration-(--duration-fast)',
          dragging ? 'bg-focus text-white ring-focus' : 'bg-surface-raised text-ink-muted ring-border',
        )}
      >
        <CloudUpload className="size-6" aria-hidden="true" />
      </span>
      <p className="mt-4 text-base font-semibold">
        {dragging ? 'Drop to upload' : 'Drag photos and videos here'}
      </p>
      <p className="mt-1 max-w-sm text-sm text-ink-muted">
        Or choose them. Whole folders keep their structure, and files already in your vault aren’t uploaded
        again.
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <Button onClick={onFiles}>
          <Upload aria-hidden="true" /> Choose files
        </Button>
        <Button variant="outline" onClick={onFolder}>
          <FolderUp aria-hidden="true" /> Choose a folder
        </Button>
      </div>
    </div>
  );
}

/** The upload window: centred, with everything about the current uploads in one place. */
export function UploadDialog() {
  const { manager, snapshot, dragging, open, setOpen, add } = useUploads();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const progressId = useId();
  const { counts } = snapshot;
  const pending = counts.queued + counts.hashing + counts.uploading + counts.paused;
  const finished = counts.done + counts.duplicate;
  const hasItems = snapshot.items.length > 0;
  const percent = percentOf(snapshot);

  const countFor = (key: Filter) =>
    key === 'all'
      ? snapshot.items.length
      : FILTERS.find((entry) => entry.key === key)!.statuses.reduce((sum, status) => sum + counts[status], 0);
  // A filter with nothing left in it falls back to all.
  const active = filter !== 'all' && countFor(filter) === 0 ? 'all' : filter;
  const shown = useMemo(() => {
    const statuses = FILTERS.find((entry) => entry.key === active)!.statuses;
    const items = statuses.length
      ? snapshot.items.filter((item) => statuses.includes(item.status))
      : [...snapshot.items];
    // What needs attention first, then what's moving, then the rest in the order chosen.
    const rank: Record<UploadStatus, number> = {
      failed: 0,
      uploading: 1,
      hashing: 2,
      paused: 3,
      queued: 4,
      done: 5,
      duplicate: 6,
    };
    return items.sort((a, b) => rank[a.status] - rank[b.status]);
  }, [snapshot.items, active]);

  const choose = (input: HTMLInputElement | null) => input?.click();

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim/70 backdrop-blur-[1px]" />
        <DialogPrimitive.Content
          // Focus the window itself, not its first button: no tooltip pops up and Esc closes at once.
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
          className={cn(
            'fixed top-1/2 left-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden',
            'w-[min(680px,calc(100vw-1.5rem))] rounded-xl border bg-surface-raised shadow-2xl outline-none',
            hasItems ? 'h-[min(720px,calc(100dvh-1.5rem))]' : 'max-h-[calc(100dvh-1.5rem)]',
          )}
        >
          <header className="flex items-start gap-4 border-b px-6 pt-5 pb-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="text-lg font-semibold tracking-tight">
                Upload
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-sm text-ink-muted">
                Photos, videos and other files go straight into your vault, each checked as it arrives.
              </DialogPrimitive.Description>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <DialogPrimitive.Close asChild>
                  <Button variant="ghost" size="icon" aria-label="Close (Esc)" className="-mr-2">
                    <X />
                  </Button>
                </DialogPrimitive.Close>
              </TooltipTrigger>
              <TooltipContent>{pending > 0 ? 'Close (uploads continue)' : 'Close'}</TooltipContent>
            </Tooltip>
          </header>

          <div className="space-y-4 px-6 pt-5 pb-4">
            <DropZone
              compact={hasItems}
              dragging={dragging}
              onFiles={() => choose(filesInput.current)}
              onFolder={() => choose(folderInput.current)}
            />

            {hasItems && (
              <section aria-labelledby={progressId} className="rounded-lg border bg-surface p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p id={progressId} className="font-semibold" aria-live="polite">
                      {headline(snapshot)}
                    </p>
                    <p className="mt-0.5 text-sm text-ink-muted tabular-nums">{detail(snapshot)}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className="text-2xl font-semibold tabular-nums">{percent}%</span>
                    {pending > 0 &&
                      (snapshot.paused ? (
                        <Button variant="outline" onClick={() => manager.resume()}>
                          <Play aria-hidden="true" /> Resume
                        </Button>
                      ) : (
                        <Button variant="outline" onClick={() => manager.pause()}>
                          <Pause aria-hidden="true" /> Pause
                        </Button>
                      ))}
                  </div>
                </div>
                <div
                  role="progressbar"
                  aria-labelledby={progressId}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  className="mt-3 h-2 overflow-hidden rounded-full bg-surface-sunken"
                >
                  <div
                    className={cn(
                      'h-full rounded-full transition-[width] duration-(--duration-base)',
                      pending === 0 ? 'bg-keep' : 'bg-focus',
                    )}
                    style={{ width: `${percent}%` }}
                  />
                </div>
              </section>
            )}

            {hasItems && (
              <div role="toolbar" aria-label="Show" className="-mb-1 flex gap-1 overflow-x-auto">
                {FILTERS.filter((entry) => entry.key === 'all' || countFor(entry.key) > 0).map((entry) => (
                  <button
                    key={entry.key}
                    type="button"
                    aria-pressed={active === entry.key}
                    onClick={() => setFilter(entry.key)}
                    className={cn(
                      'inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-sm transition-colors duration-(--duration-fast)',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                      active === entry.key
                        ? 'bg-primary text-on-primary'
                        : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
                    )}
                  >
                    {entry.label}
                    <span
                      className={cn('tabular-nums', active === entry.key ? 'opacity-80' : 'text-ink-subtle')}
                    >
                      {countFor(entry.key).toLocaleString()}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {hasItems && <FileList items={shown} onRetry={(id) => manager.retry(id)} />}

          {hasItems && (
            <footer className="flex flex-wrap items-center justify-end gap-3 border-t px-6 py-3.5">
              <p className="min-w-0 flex-1 text-xs text-ink-subtle max-sm:hidden">
                {pending > 0
                  ? 'You can close this window. Uploads carry on while you browse.'
                  : 'New photos appear in your library as they’re processed.'}
              </p>
              <div className="flex flex-wrap gap-2">
                {counts.failed > 0 && (
                  <Button variant="outline" onClick={() => manager.retryFailed()}>
                    <RotateCw aria-hidden="true" /> Retry failed
                  </Button>
                )}
                {finished > 0 && pending === 0 && (
                  <Button variant="ghost" onClick={() => manager.clearFinished()}>
                    Clear finished
                  </Button>
                )}
                <Button onClick={() => setOpen(false)}>{pending > 0 ? 'Hide' : 'Done'}</Button>
              </div>
            </footer>
          )}

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
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
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

/** While the dialog is closed: a small card with the overall progress, one click from the dialog. */
export function UploadTray() {
  const { manager, snapshot, open, setOpen } = useUploads();
  const { counts } = snapshot;
  const pending = counts.queued + counts.hashing + counts.uploading + counts.paused;
  if (open || (pending === 0 && counts.failed === 0)) return null;
  const percent = percentOf(snapshot);
  const failedOnly = pending === 0 && counts.failed > 0;

  return (
    <section
      aria-label="Uploads"
      className="fixed bottom-4 left-4 z-40 w-[min(320px,calc(100vw-2rem))] rounded-xl border bg-surface-raised shadow-lg lg:left-62"
    >
      <div className="flex items-center gap-3 px-4 pt-3">
        {failedOnly ? (
          <AlertCircle className="size-4 shrink-0 text-skip" aria-hidden="true" />
        ) : snapshot.paused ? (
          <Pause className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        ) : (
          <Loader2 className="size-4 shrink-0 animate-spin text-focus" aria-hidden="true" />
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-medium" aria-live="polite">
          {headline(snapshot)}
        </p>
        {pending > 0 && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={snapshot.paused ? 'Resume uploads' : 'Pause uploads'}
            onClick={() => (snapshot.paused ? manager.resume() : manager.pause())}
          >
            {snapshot.paused ? <Play /> : <Pause />}
          </Button>
        )}
        <Button variant="ghost" size="icon" aria-label="Show uploads" onClick={() => setOpen(true)}>
          <ChevronUp />
        </Button>
      </div>
      <div className="px-4 pt-1 pb-3">
        <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
          <div
            className={cn('h-full rounded-full', failedOnly ? 'bg-skip' : 'bg-focus')}
            style={{ width: `${percent}%` }}
          />
        </div>
        <p className="mt-1.5 truncate text-xs text-ink-subtle tabular-nums">
          {failedOnly
            ? 'Open to see what went wrong and retry'
            : [`${percent}%`, snapshot.paused ? 'paused' : timeLeft(snapshot)].filter(Boolean).join(' · ')}
        </p>
      </div>
    </section>
  );
}
