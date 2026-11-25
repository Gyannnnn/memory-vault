'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 WebP derivatives */
import type { AssetTile } from '@memory-vault/shared';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { useState } from 'react';
import { PhotoViewer } from '@/components/viewer/photo-viewer';
import { formatDay } from '@/lib/format';
import { libraryQueries, localToday } from '@/lib/library';
import { useMounted } from '@/lib/use-mounted';

/**
 * Photos from this calendar day in earlier years, one card per year. Opens its own viewer
 * (not the timeline's), so moving through a year's photos stays within that day.
 */
export function OnThisDay() {
  const mounted = useMounted();
  const today = mounted ? localToday() : null;
  const memories = useQuery({ ...libraryQueries.onThisDay(today ?? ''), enabled: Boolean(today) });
  const [open, setOpen] = useState<{ items: AssetTile[]; id: string } | null>(null);
  const groups = memories.data?.groups ?? [];
  if (groups.length === 0) return null;

  return (
    <section aria-labelledby="on-this-day" className="px-4 pt-6 pr-12 sm:px-8 sm:pr-16">
      <div className="flex items-center gap-2">
        <History className="size-4 text-ink-muted" aria-hidden="true" />
        <h2 id="on-this-day" className="text-sm font-medium">
          On this day
        </h2>
      </div>
      <ul className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {groups.map((group) => {
          const cover = group.items[0]!;
          return (
            <li key={group.year}>
              <button
                type="button"
                onClick={() => setOpen({ items: group.items, id: cover.id })}
                className="group relative block aspect-[4/3] w-full overflow-hidden rounded-lg bg-surface-sunken text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {cover.thumb && (
                  <img
                    src={cover.thumb.md}
                    alt=""
                    loading="lazy"
                    className="size-full object-cover transition-transform duration-(--duration-slow) group-hover:scale-[1.03] motion-reduce:group-hover:scale-100"
                  />
                )}
                <span
                  data-theme="dark"
                  className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-scrim to-transparent px-3 pt-8 pb-2.5"
                >
                  <span className="block text-sm font-medium text-ink">
                    {group.yearsAgo === 1 ? '1 year ago' : `${group.yearsAgo} years ago`}
                  </span>
                  <span className="block text-xs text-ink-muted">
                    {formatDay(cover.localAt.slice(0, 10))} · {group.total}{' '}
                    {group.total === 1 ? 'item' : 'items'}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {mounted && open && (
        <PhotoViewer
          items={open.items}
          currentId={open.id}
          onShow={(id) => setOpen({ ...open, id })}
          onClose={() => setOpen(null)}
        />
      )}
    </section>
  );
}
