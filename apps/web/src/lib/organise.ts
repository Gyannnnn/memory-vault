import type {
  AlbumSummary,
  AssetDetail,
  AssetPage,
  AssetTile,
  FolderListing,
  OnThisDayResponse,
} from '@memory-vault/shared';
import type { InfiniteData, QueryClient } from '@tanstack/react-query';
import { api } from './api';

/** Applies `patch` to these items wherever they're cached, so every grid shows it at once. */
export function patchTiles(queryClient: QueryClient, ids: ReadonlySet<string>, patch: Partial<AssetTile>) {
  const fix = <T extends AssetTile>(tile: T): T => (ids.has(tile.id) ? { ...tile, ...patch } : tile);
  // ['timeline'] is the summary; ['timeline', month] holds that month's tiles.
  queryClient.setQueriesData({ queryKey: ['timeline'] }, (data: unknown) =>
    Array.isArray(data) ? (data as AssetTile[]).map(fix) : data,
  );
  queryClient.setQueriesData<InfiniteData<AssetPage>>({ queryKey: ['search'] }, (data) =>
    data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: page.items.map(fix) })) } : data,
  );
  queryClient.setQueriesData<InfiniteData<FolderListing>>({ queryKey: ['folder'] }, (data) =>
    data
      ? {
          ...data,
          pages: data.pages.map((page) => ({
            ...page,
            files: page.files.map((file) => ({ ...file, asset: fix(file.asset) })),
          })),
        }
      : data,
  );
  queryClient.setQueriesData<OnThisDayResponse>({ queryKey: ['on-this-day'] }, (data) =>
    data ? { groups: data.groups.map((group) => ({ ...group, items: group.items.map(fix) })) } : data,
  );
  queryClient.setQueriesData<AssetDetail>({ queryKey: ['asset'] }, (data) => (data ? fix(data) : data));
}

/** Everything that lists the library, refetched where it's on screen. */
export function refreshLibrary(queryClient: QueryClient) {
  for (const key of [
    'timeline',
    'search',
    'folder',
    'asset',
    'albums',
    'on-this-day',
    'map-points',
    'facets',
  ])
    void queryClient.invalidateQueries({ queryKey: [key] });
}

/** Marks or unmarks favourites, showing the change before the server confirms it. */
export async function setFavorite(queryClient: QueryClient, ids: string[], favorite: boolean) {
  patchTiles(queryClient, new Set(ids), { favorite });
  try {
    await api('/assets/favorite', { method: 'POST', body: { ids, favorite } });
  } catch (error) {
    refreshLibrary(queryClient);
    throw error;
  }
  void queryClient.invalidateQueries({ queryKey: ['albums'] });
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'search' &&
      (query.queryKey[1] as { favorite?: string } | undefined)?.favorite === '1',
  });
}

const albumChanged = (queryClient: QueryClient) => {
  void queryClient.invalidateQueries({ queryKey: ['albums'] });
  void queryClient.invalidateQueries({
    predicate: (query) =>
      query.queryKey[0] === 'search' && Boolean((query.queryKey[1] as { album?: string } | undefined)?.album),
  });
  void queryClient.invalidateQueries({ queryKey: ['asset'] });
};

export const albums = {
  async create(queryClient: QueryClient, name: string, assetIds: string[] = []) {
    const album = await api<AlbumSummary>('/albums', { method: 'POST', body: { name, assetIds } });
    albumChanged(queryClient);
    return album;
  },
  async rename(queryClient: QueryClient, id: string, name: string) {
    const album = await api<AlbumSummary>(`/albums/${id}`, { method: 'PATCH', body: { name } });
    albumChanged(queryClient);
    return album;
  },
  async setCover(queryClient: QueryClient, id: string, coverAssetId: string) {
    const album = await api<AlbumSummary>(`/albums/${id}`, { method: 'PATCH', body: { coverAssetId } });
    albumChanged(queryClient);
    return album;
  },
  async remove(queryClient: QueryClient, id: string) {
    await api(`/albums/${id}`, { method: 'DELETE' });
    queryClient.removeQueries({ queryKey: ['albums', id] });
    albumChanged(queryClient);
  },
  async add(queryClient: QueryClient, id: string, assetIds: string[]) {
    const result = await api<{ added: number }>(`/albums/${id}/items`, {
      method: 'POST',
      body: { assetIds },
    });
    albumChanged(queryClient);
    return result.added;
  },
  async removeItems(queryClient: QueryClient, id: string, assetIds: string[]) {
    const result = await api<{ removed: number }>(`/albums/${id}/items/remove`, {
      method: 'POST',
      body: { assetIds },
    });
    albumChanged(queryClient);
    return result.removed;
  },
};
