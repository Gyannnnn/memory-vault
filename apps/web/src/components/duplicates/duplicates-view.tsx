'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 WebP derivatives */
import {
  formatBytes,
  type DuplicateGroup,
  type DuplicateMember,
  type DuplicatesResponse,
} from '@memory-vault/shared';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Check, CopyCheck, Loader2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { useTrash } from '@/components/trash/use-trash';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PhotoViewer } from '@/components/viewer/photo-viewer';
import { usePhotoParam } from '@/components/viewer/use-photo-param';
import { api, errorMessage } from '@/lib/api';
import { formatWallTime } from '@/lib/format';
import { sourceLabel } from '@/lib/sources';
import { useMounted } from '@/lib/use-mounted';
import { cn } from '@/lib/utils';

const PAGE = 20;

/** "phone:s21fe/DCIM/Camera" → "Phone · s21fe / DCIM/Camera" */
function where(folder: string | null): string | null {
  if (!folder) return null;
  const slash = folder.indexOf('/');
  return slash < 0
    ? sourceLabel(folder)
    : `${sourceLabel(folder.slice(0, slash))} / ${folder.slice(slash + 1)}`;
}

function Member({
  member,
  best,
  kept,
  onToggle,
  onOpen,
}: {
  member: DuplicateMember;
  best: boolean;
  kept: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const facts = [
    member.width && member.height ? `${member.width} × ${member.height}` : null,
    formatBytes(member.sizeBytes),
    member.extension.toUpperCase(),
  ].filter(Boolean);
  return (
    <li className="w-44 shrink-0 sm:w-56">
      <div
        className={cn(
          'relative overflow-hidden rounded-lg bg-surface-sunken ring-2 transition-shadow duration-(--duration-fast)',
          kept ? 'ring-ink' : 'ring-transparent',
        )}
      >
        <button
          type="button"
          onClick={onOpen}
          aria-label={`Open ${formatWallTime(member.localAt)}, ${facts.join(', ')}`}
          className="block aspect-[4/3] w-full outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
        >
          {member.thumb ? (
            <img src={member.thumb.md} alt="" loading="lazy" className="size-full object-contain" />
          ) : null}
        </button>
        <button
          type="button"
          role="checkbox"
          aria-checked={kept}
          onClick={onToggle}
          className={cn(
            'absolute top-2 left-2 inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium shadow-sm transition-colors duration-(--duration-fast)',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            kept ? 'bg-primary text-on-primary' : 'bg-surface/90 text-ink',
          )}
        >
          {kept && <Check className="size-3.5" aria-hidden="true" />}
          {kept ? 'Keep' : 'To Trash'}
        </button>
        {best && (
          <span className="absolute top-2 right-2 rounded-full bg-keep px-2 py-1 text-xs font-medium text-on-keep">
            Best
          </span>
        )}
      </div>
      <p className="mt-2 truncate text-sm tabular-nums">{facts.join(' · ')}</p>
      <p className="truncate text-xs text-ink-muted tabular-nums">{formatWallTime(member.localAt)}</p>
      <p className="truncate text-xs text-ink-subtle" title={where(member.folder) ?? undefined}>
        {where(member.folder) ?? ' '}
      </p>
    </li>
  );
}

function Group({
  group,
  onResolved,
  onOpen,
}: {
  group: DuplicateGroup;
  onResolved: () => void;
  onOpen: (id: string) => void;
}) {
  const [keep, setKeep] = useState<ReadonlySet<string>>(() => new Set([group.suggestedKeepId]));
  const [busy, setBusy] = useState<'resolve' | 'dismiss' | null>(null);
  const { move } = useTrash();
  const others = group.members.filter((member) => !keep.has(member.id));
  const freed = others.reduce((sum, member) => sum + member.sizeBytes, 0);

  const toggle = (id: string) =>
    setKeep((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const dismiss = async (ids: string[]) => {
    await api('/duplicates/dismiss', { method: 'POST', body: { assetIds: ids } });
  };

  const resolve = async () => {
    setBusy('resolve');
    const moved = await move(others.map((member) => member.id));
    if (moved) {
      try {
        // Kept copies that still look alike aren't offered again.
        if (keep.size > 1) await dismiss([...keep]);
      } catch {
        /* only affects whether they're suggested again */
      }
      onResolved();
    } else {
      setBusy(null);
    }
  };

  const notDuplicates = async () => {
    setBusy('dismiss');
    try {
      await dismiss(group.members.map((member) => member.id));
      toast.success('They won’t be suggested again');
      onResolved();
    } catch (error) {
      toast.error('Nothing changed', { description: errorMessage(error) });
      setBusy(null);
    }
  };

  return (
    <section
      aria-label={`${group.members.length} look-alikes`}
      className="rounded-lg border bg-surface p-4 sm:p-5"
    >
      <ul className="-mx-1 flex gap-4 overflow-x-auto px-1 pt-1 pb-2">
        {group.members.map((member) => (
          <Member
            key={member.id}
            member={member}
            best={member.id === group.suggestedKeepId}
            kept={keep.has(member.id)}
            onToggle={() => toggle(member.id)}
            onOpen={() => onOpen(member.id)}
          />
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2 border-t pt-4">
        <p className="mr-auto text-sm text-ink-muted tabular-nums">
          {others.length === 0 ? 'Keeping all of them' : `${others.length} to Trash · ${formatBytes(freed)}`}
        </p>
        <Button variant="ghost" disabled={busy !== null} onClick={() => void notDuplicates()}>
          {busy === 'dismiss' && <Loader2 className="animate-spin" aria-hidden="true" />}
          Not duplicates
        </Button>
        <Button
          disabled={busy !== null || keep.size === 0 || others.length === 0}
          onClick={() => void resolve()}
        >
          {busy === 'resolve' && <Loader2 className="animate-spin" aria-hidden="true" />}
          {keep.size === 0 ? 'Keep at least one' : `Keep ${keep.size}, move ${others.length} to Trash`}
        </Button>
      </div>
    </section>
  );
}

export function DuplicatesView() {
  const mounted = useMounted();
  const queryClient = useQueryClient();
  const viewer = usePhotoParam();
  const [done, setDone] = useState<ReadonlySet<string>>(() => new Set());
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // Resolved groups are gone from the server's list, so the next page starts that much earlier.
  const resolved = useRef(0);
  const [freed, setFreed] = useState(0);

  const list = useInfiniteQuery({
    queryKey: ['duplicates'],
    queryFn: ({ pageParam }) => api<DuplicatesResponse>(`/duplicates?offset=${pageParam}&limit=${PAGE}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.groups.length, 0);
      const next = loaded - resolved.current;
      return next < last.totalGroups - resolved.current ? next : undefined;
    },
    staleTime: Infinity,
  });
  const first = list.data?.pages[0];
  const groups = useMemo(
    () => (list.data?.pages.flatMap((page) => page.groups) ?? []).filter((group) => !done.has(group.id)),
    [list.data, done],
  );
  const remaining = first ? first.totalGroups - done.size : 0;
  const viewed = groups.find((group) => group.id === openGroup);

  return (
    <>
      <PageHeader
        title="Duplicates"
        description={
          first && remaining > 0
            ? `${remaining.toLocaleString()} ${remaining === 1 ? 'group' : 'groups'} · ${formatBytes(Math.max(0, first.reclaimableBytes - freed))} in extra copies`
            : undefined
        }
      />
      <div className="space-y-4 px-4 py-5 sm:px-8">
        <p className="text-sm text-ink-muted">
          Photos and videos that look alike. Choose what to keep; the rest go to Trash for 30 days.
        </p>

        {list.isPending ? (
          Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-64 rounded-lg" />)
        ) : list.isError ? (
          <div role="alert" className="py-16 text-center">
            <p className="font-medium">Duplicates couldn’t be worked out</p>
            <button
              type="button"
              onClick={() => void list.refetch()}
              className="mt-3 min-h-11 text-sm font-medium underline underline-offset-4"
            >
              Try again
            </button>
          </div>
        ) : groups.length === 0 ? (
          <div className="py-24 text-center">
            <CopyCheck className="mx-auto size-6 text-ink-subtle" strokeWidth={1.6} aria-hidden="true" />
            <p className="mt-4 text-lg font-medium">No look-alikes</p>
            {done.size > 0 && (
              <Button
                variant="outline"
                className="mt-6"
                onClick={() => {
                  resolved.current = 0;
                  setFreed(0);
                  setDone(new Set());
                  void queryClient.resetQueries({ queryKey: ['duplicates'] });
                }}
              >
                Check again
              </Button>
            )}
          </div>
        ) : (
          <>
            {groups.map((group) => (
              <Group
                key={group.id}
                group={group}
                onOpen={(id) => {
                  setOpenGroup(group.id);
                  viewer.open(id);
                }}
                onResolved={() => {
                  resolved.current += 1;
                  setFreed((total) => total + group.reclaimableBytes);
                  setDone((current) => new Set(current).add(group.id));
                }}
              />
            ))}
            {list.hasNextPage && (
              <div className="flex justify-center pt-2 pb-12">
                <Button
                  variant="outline"
                  onClick={() => void list.fetchNextPage()}
                  disabled={list.isFetchingNextPage}
                >
                  {list.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Show more
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {mounted && viewer.photoId && viewed && (
        <PhotoViewer
          items={viewed.members}
          currentId={viewer.photoId}
          onShow={viewer.show}
          onClose={viewer.close}
        />
      )}
    </>
  );
}
