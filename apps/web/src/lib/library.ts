import type {
  AssetDetail,
  AssetPage,
  AssetSearchQuery,
  AssetTile,
  FacetsResponse,
  FolderListing,
  MapPointsResponse,
  OnThisDayResponse,
  TimelineResponse,
} from '@memory-vault/shared';
import { infiniteQueryOptions, queryOptions } from '@tanstack/react-query';
import { api } from './api';

/** Media links are signed for at least two hours; refresh well before that. */
const MEDIA_STALE_MS = 45 * 60_000;

export const libraryQueries = {
  timeline: () =>
    queryOptions({
      queryKey: ['timeline'],
      queryFn: () => api<TimelineResponse>('/timeline'),
      staleTime: 5 * 60_000,
    }),
  month: (month: string) =>
    queryOptions({
      queryKey: ['timeline', month],
      queryFn: async () => (await api<{ items: AssetTile[] }>(`/timeline/${month}`)).items,
      staleTime: MEDIA_STALE_MS,
      gcTime: 2 * 60 * 60_000,
    }),
  asset: (id: string) =>
    queryOptions({
      queryKey: ['asset', id],
      queryFn: () => api<AssetDetail>(`/assets/${id}`),
      staleTime: MEDIA_STALE_MS,
    }),
  facets: () =>
    queryOptions({
      queryKey: ['facets'],
      queryFn: () => api<FacetsResponse>('/search/facets'),
      staleTime: 10 * 60_000,
    }),
  onThisDay: (date: string) =>
    queryOptions({
      queryKey: ['on-this-day', date],
      queryFn: () => api<OnThisDayResponse>(`/memories/on-this-day?date=${date}`),
      staleTime: MEDIA_STALE_MS,
    }),
  mapPoints: () =>
    queryOptions({
      queryKey: ['map-points'],
      queryFn: () => api<MapPointsResponse>('/map/points'),
      staleTime: 10 * 60_000,
    }),
  search: (query: Omit<AssetSearchQuery, 'cursor'>) =>
    infiniteQueryOptions({
      queryKey: ['search', query],
      queryFn: ({ pageParam }) =>
        api<AssetPage>(`/assets?${toSearchParams({ ...query, cursor: pageParam })}`),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      staleTime: MEDIA_STALE_MS,
    }),
  folder: (id: string | null) =>
    infiniteQueryOptions({
      queryKey: ['folder', id ?? 'root'],
      queryFn: ({ pageParam }) =>
        api<FolderListing>(
          `/folders${id ? `/${id}` : ''}?limit=200${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ''}`,
        ),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      staleTime: MEDIA_STALE_MS,
    }),
};

export function toSearchParams(
  query: Record<string, string | number | readonly string[] | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  return params.toString();
}

/** Today's date on this device, as the API expects for "On this day". */
export function localToday(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
