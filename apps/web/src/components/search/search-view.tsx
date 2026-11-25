'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Loader2, Search, SearchX, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sectionsByMonth } from '@/components/media/sections';
import { VirtualGallery } from '@/components/media/virtual-gallery';
import { SelectionProvider } from '@/components/selection/selection';
import { SelectionBar } from '@/components/selection/selection-bar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { PhotoViewer } from '@/components/viewer/photo-viewer';
import { usePhotoParam } from '@/components/viewer/use-photo-param';
import { libraryQueries } from '@/lib/library';
import { sourceLabel } from '@/lib/sources';
import { useMounted } from '@/lib/use-mounted';
import { cn } from '@/lib/utils';

interface Filters {
  q?: string;
  kind?: string;
  from?: string;
  to?: string;
  place?: string;
  camera?: string;
  source?: string;
}

const FILTER_KEYS = ['q', 'kind', 'from', 'to', 'place', 'camera', 'source'] as const;
const KINDS = [
  { value: undefined, label: 'All' },
  { value: 'photo,raw', label: 'Photos' },
  { value: 'video', label: 'Videos' },
  { value: 'document', label: 'Documents' },
] as const;

function readFilters(params: URLSearchParams): Filters {
  const filters: Filters = {};
  for (const key of FILTER_KEYS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

/** Filters live in the address, so a search can be bookmarked and Back works; typing doesn't add history. */
function writeFilters(filters: Filters) {
  const url = new URL(window.location.href);
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  const next = `${url.pathname}${url.search}`;
  if (next !== `${window.location.pathname}${window.location.search}`)
    window.history.replaceState(null, '', next);
}

function Chip({
  active,
  onClick,
  children,
  className,
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-sm whitespace-nowrap transition-colors duration-(--duration-fast)',
        active
          ? 'border-primary bg-primary text-on-primary'
          : 'border-border-strong bg-surface text-ink hover:bg-surface-sunken',
        className,
      )}
    >
      {children}
    </button>
  );
}

function FilterMenu({
  label,
  value,
  options,
  onSelect,
  onClear,
}: {
  label: string;
  value: string | undefined;
  options: { value: string; label: string; detail?: string }[];
  onSelect: (value: string) => void;
  onClear: () => void;
}) {
  const selected = options.find((option) => option.value === value);
  if (options.length === 0) return null;
  return (
    <span className="inline-flex items-center">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Chip active={Boolean(selected)} className={selected ? 'rounded-r-none pr-2.5' : undefined}>
            {selected ? selected.label : label}
            <ChevronDown className="size-3.5 opacity-70" aria-hidden="true" />
          </Chip>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-y-auto">
          {options.map((option) => (
            <DropdownMenuItem key={option.value} onSelect={() => onSelect(option.value)}>
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.detail && <span className="text-xs text-ink-subtle tabular-nums">{option.detail}</span>}
              {option.value === value && <Check aria-label="Selected" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {selected && (
        <button
          type="button"
          onClick={onClear}
          aria-label={`Remove the ${label.toLowerCase()} filter`}
          className="inline-flex h-9 items-center rounded-r-full border border-l-0 border-primary bg-primary pr-2.5 pl-1.5 text-on-primary hover:opacity-90"
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

export function SearchView() {
  const mounted = useMounted();
  const params = useSearchParams();
  const [filters, setFilters] = useState<Filters>(() => readFilters(params));
  const [text, setText] = useState(filters.q ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  const viewer = usePhotoParam();
  const facets = useQuery(libraryQueries.facets());

  const update = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => {
      const next = { ...current, ...patch };
      for (const key of FILTER_KEYS) if (!next[key]) delete next[key];
      return next;
    });
  }, []);

  // Keep the address in step with the filters (after render, never during it).
  useEffect(() => writeFilters(filters), [filters]);

  // Search as you type, a moment after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => {
      const q = text.trim() || undefined;
      if (q !== filters.q) update({ q });
    }, 300);
    return () => clearTimeout(timer);
  }, [text, filters.q, update]);

  const active = FILTER_KEYS.some((key) => filters[key]);
  const results = useInfiniteQuery({
    ...libraryQueries.search({
      q: filters.q,
      kind: filters.kind,
      from: filters.from,
      to: filters.to,
      place: filters.place,
      camera: filters.camera,
      source: filters.source,
      limit: 120,
    }),
    enabled: active,
  });
  const items = useMemo(() => results.data?.pages.flatMap((page) => page.items) ?? [], [results.data]);
  const sections = useMemo(() => sectionsByMonth(items), [items]);
  const total = results.data?.pages[0]?.total;
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = results;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const year = filters.from?.slice(0, 4);
  const options = {
    years: (facets.data?.years ?? []).map((entry) => ({
      value: String(entry.year),
      label: String(entry.year),
      detail: entry.count.toLocaleString(),
    })),
    places: (facets.data?.places ?? []).map((place) => ({
      value: place.ids.join(','),
      label: [place.name, place.admin1].filter(Boolean).join(', '),
      detail: place.count.toLocaleString(),
    })),
    cameras: (facets.data?.cameras ?? []).map((camera) => ({
      value: camera.name,
      label: camera.name,
      detail: camera.count.toLocaleString(),
    })),
    sources: (facets.data?.sources ?? []).map((source) => ({
      value: source.id,
      label: sourceLabel(source.id),
      detail: source.count.toLocaleString(),
    })),
  };

  const clearAll = () => {
    setText('');
    update({
      q: undefined,
      kind: undefined,
      from: undefined,
      to: undefined,
      place: undefined,
      camera: undefined,
      source: undefined,
    });
    inputRef.current?.focus();
  };

  return (
    <>
      <div className="border-b px-4 py-4 sm:px-8">
        <h1 className="sr-only">Search</h1>
        <label htmlFor="library-search" className="sr-only">
          Search your library
        </label>
        <div className="relative max-w-2xl">
          <Search
            className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-ink-subtle"
            aria-hidden="true"
          />
          <input
            ref={inputRef}
            id="library-search"
            type="search"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Places, years, folders, file names, cameras…"
            className="h-12 w-full rounded-full border border-border-strong bg-surface pr-12 pl-12 text-base outline-none placeholder:text-ink-subtle focus-visible:border-focus focus-visible:ring-2 focus-visible:ring-focus/30 [&::-webkit-search-cancel-button]:hidden"
          />
          {text && (
            <button
              type="button"
              onClick={() => {
                setText('');
                inputRef.current?.focus();
              }}
              aria-label="Clear the search text"
              className="absolute top-1/2 right-2 grid size-9 -translate-y-1/2 place-items-center rounded-full text-ink-muted hover:bg-surface-sunken hover:text-ink"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
          <div className="inline-flex flex-wrap gap-2" role="group" aria-label="Type">
            {KINDS.map((kind) => (
              <Chip
                key={kind.label}
                active={filters.kind === kind.value}
                onClick={() => update({ kind: kind.value })}
              >
                {kind.label}
              </Chip>
            ))}
          </div>
          <span className="mx-1 hidden h-5 w-px bg-border sm:block" aria-hidden="true" />
          <FilterMenu
            label="Year"
            value={year}
            options={options.years}
            onSelect={(value) => update({ from: `${value}-01-01`, to: `${value}-12-31` })}
            onClear={() => update({ from: undefined, to: undefined })}
          />
          <FilterMenu
            label="Place"
            value={filters.place}
            options={options.places}
            onSelect={(value) => update({ place: value })}
            onClear={() => update({ place: undefined })}
          />
          <FilterMenu
            label="Camera"
            value={filters.camera}
            options={options.cameras}
            onSelect={(value) => update({ camera: value })}
            onClear={() => update({ camera: undefined })}
          />
          <FilterMenu
            label="Source"
            value={filters.source}
            options={options.sources}
            onSelect={(value) => update({ source: value })}
            onClear={() => update({ source: undefined })}
          />
          {active && (
            <Button variant="ghost" size="sm" onClick={clearAll} className="h-9">
              Clear all
            </Button>
          )}
        </div>
      </div>

      <div className="px-4 pt-4 pb-16 sm:px-8">
        {!active ? (
          <Suggestions
            places={options.places.slice(0, 8)}
            years={options.years}
            onPlace={(value) => update({ place: value })}
            onYear={(value) => update({ from: `${value}-01-01`, to: `${value}-12-31` })}
            onText={(value) => setText(value)}
          />
        ) : results.isPending ? (
          <div className="space-y-3" aria-label="Searching">
            <Skeleton className="h-5 w-32" />
            <div className="grid grid-cols-3 gap-1 sm:grid-cols-6">
              {Array.from({ length: 12 }, (_, index) => (
                <Skeleton key={index} className="aspect-square rounded-none" />
              ))}
            </div>
          </div>
        ) : results.isError ? (
          <p role="alert" className="py-12 text-center text-sm text-ink-muted">
            The search didn’t work. Check that the API is running, then try again.
          </p>
        ) : items.length === 0 ? (
          <div className="mx-auto max-w-md py-16 text-center">
            <span className="mx-auto grid size-12 place-items-center rounded-full bg-surface-sunken text-ink-muted ring-1 ring-border">
              <SearchX className="size-5" aria-hidden="true" />
            </span>
            <p className="mt-5 font-medium">
              {filters.q ? `Nothing matches “${filters.q}”` : 'Nothing matches these filters'}
            </p>
            <p className="mt-1.5 text-sm text-ink-muted">
              Try fewer words or the start of a word (“kora” finds Koraput), a folder such as WhatsApp or
              Screenshots, or remove a filter.
            </p>
            <Button variant="outline" className="mt-5" onClick={clearAll}>
              Clear the search
            </Button>
          </div>
        ) : (
          <>
            <p className="mb-1 text-sm text-ink-muted" aria-live="polite">
              {total !== undefined ? `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}` : ''}
            </p>
            {/* A new search starts a new selection. */}
            <SelectionProvider key={JSON.stringify(filters)} tiles={items}>
              <VirtualGallery sections={sections} onOpen={viewer.open} onEndReached={loadMore} />
              <SelectionBar />
            </SelectionProvider>
            {isFetchingNextPage && (
              <Loader2
                className="mx-auto mt-6 size-5 animate-spin text-ink-muted"
                aria-label="Loading more"
              />
            )}
          </>
        )}
      </div>

      {mounted && viewer.photoId && (
        <PhotoViewer
          items={items}
          currentId={viewer.photoId}
          onShow={viewer.show}
          onClose={viewer.close}
          onNearEdge={(direction) => direction === 'next' && loadMore()}
        />
      )}
    </>
  );
}

function Suggestions({
  places,
  years,
  onPlace,
  onYear,
  onText,
}: {
  places: { value: string; label: string }[];
  years: { value: string; label: string }[];
  onPlace: (value: string) => void;
  onYear: (value: string) => void;
  onText: (value: string) => void;
}) {
  const groups: { title: string; chips: { label: string; onClick: () => void }[] }[] = [
    {
      title: 'Places',
      chips: places.map((place) => ({ label: place.label, onClick: () => onPlace(place.value) })),
    },
    {
      title: 'Years',
      chips: years.map((year) => ({ label: year.label, onClick: () => onYear(year.value) })),
    },
    {
      title: 'Folders and kinds',
      chips: ['WhatsApp', 'Screenshots', 'Camera', 'Download'].map((word) => ({
        label: word,
        onClick: () => onText(word),
      })),
    },
  ].filter((group) => group.chips.length > 0);

  return (
    <div className="max-w-3xl space-y-6 py-4">
      <p className="text-sm text-ink-muted">
        Search finds file names, the folders files came from, places, and cameras. Start typing, or try one of
        these.
      </p>
      {groups.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h2 className="mb-2 text-xs font-medium tracking-wide text-ink-subtle uppercase">{group.title}</h2>
          <div className="flex flex-wrap gap-2">
            {group.chips.map((chip) => (
              <Chip key={chip.label} onClick={chip.onClick}>
                {chip.label}
              </Chip>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
