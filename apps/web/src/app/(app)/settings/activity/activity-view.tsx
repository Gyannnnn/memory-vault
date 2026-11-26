'use client';

import type { ActivityGroup, ActivityPage } from '@memory-vault/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import {
  CircleAlert,
  Download,
  KeyRound,
  Link2,
  Loader2,
  ScrollText,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { LoadError, RowsLoading } from '../security/section';
import { describe, deviceOf, type ActivityKind } from './describe';

const FILTERS: { value: ActivityGroup; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'signins', label: 'Sign-ins' },
  { value: 'sharing', label: 'Sharing' },
  { value: 'downloads', label: 'Downloads' },
  { value: 'deletions', label: 'Deletions' },
];

const ICON: Record<ActivityKind, LucideIcon> = {
  signin: KeyRound,
  alert: CircleAlert,
  sharing: Link2,
  download: Download,
  deletion: Trash2,
  other: ScrollText,
};

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

function dayLabel(date: Date, now: Date): string {
  const start = (value: Date) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((start(now) - start(date)) / 86_400_000);
  return days === 0 ? 'Today' : days === 1 ? 'Yesterday' : dayFormat.format(date);
}

/** Settings › Activity: what happened to the account and the library, newest first. */
export function ActivityView() {
  const [group, setGroup] = useState<ActivityGroup>('all');
  const [now] = useState(() => new Date());
  const activity = useInfiniteQuery({
    queryKey: ['activity', group],
    queryFn: ({ pageParam }) =>
      api<ActivityPage>(
        `/activity?group=${group}&limit=50${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const days = useMemo(() => {
    const pages = activity.data?.pages ?? [];
    const links = Object.assign({}, ...pages.map((page) => page.links)) as ActivityPage['links'];
    const grouped: {
      label: string;
      rows: { id: string; sentence: string; kind: ActivityKind; meta: string }[];
    }[] = [];
    for (const event of pages.flatMap((page) => page.items)) {
      const at = new Date(event.createdAt);
      const label = dayLabel(at, now);
      const { sentence, kind } = describe(event, links);
      const meta = [timeFormat.format(at), deviceOf(event.userAgent), event.ipAddress]
        .filter(Boolean)
        .join(' · ');
      const last = grouped.at(-1);
      const row = { id: event.id, sentence, kind, meta };
      if (last?.label === label) last.rows.push(row);
      else grouped.push({ label, rows: [row] });
    }
    return grouped;
  }, [activity.data, now]);

  return (
    <section aria-labelledby="activity-heading" className="px-4 py-8 sm:px-8">
      <div className="max-w-3xl">
        <h2 id="activity-heading" className="text-md font-medium">
          Activity
        </h2>
        <p className="mt-1 text-sm text-ink-muted">
          Sign-ins, links, downloads and deletions on your account, newest first.
        </p>

        <div role="group" aria-label="Show" className="mt-5 flex flex-wrap gap-2">
          {FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={group === filter.value}
              onClick={() => setGroup(filter.value)}
              className={cn(
                'inline-flex h-9 items-center rounded-full border px-3.5 text-sm transition-colors duration-(--duration-fast)',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                group === filter.value
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-border-strong bg-surface text-ink hover:bg-surface-sunken',
              )}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <div className="mt-6">
          {activity.isPending ? (
            <RowsLoading count={4} />
          ) : activity.isError ? (
            <LoadError message="Activity couldn’t be loaded." onRetry={() => void activity.refetch()} />
          ) : days.length === 0 ? (
            <p className="text-sm text-ink-muted">Nothing here yet.</p>
          ) : (
            <div className="space-y-8">
              {days.map((day) => (
                <div key={day.label}>
                  <h3 className="mb-2 text-xs font-medium text-ink-subtle">{day.label}</h3>
                  <ul className="divide-y rounded-lg border bg-surface">
                    {day.rows.map((row) => {
                      const Icon = ICON[row.kind];
                      return (
                        <li key={row.id} className="flex items-start gap-3.5 px-4 py-3">
                          <span
                            className={cn(
                              'mt-0.5 grid size-8 shrink-0 place-items-center rounded-md',
                              row.kind === 'alert'
                                ? 'bg-warning-soft text-warning'
                                : 'bg-surface-sunken text-ink-muted',
                            )}
                          >
                            <Icon className="size-4" aria-hidden="true" />
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm">{row.sentence}</p>
                            <p className="mt-0.5 truncate text-xs text-ink-subtle tabular-nums">{row.meta}</p>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
              {activity.hasNextPage && (
                <Button
                  variant="outline"
                  onClick={() => void activity.fetchNextPage()}
                  disabled={activity.isFetchingNextPage}
                >
                  {activity.isFetchingNextPage && <Loader2 className="animate-spin" aria-hidden="true" />}
                  Show older
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
