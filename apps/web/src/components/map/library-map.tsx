'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import './maplibre';
import type { AssetTile } from '@memory-vault/shared';
import type { FeatureCollection, Point } from 'geojson';
import type { GeoJSONSource } from 'maplibre-gl';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { MapPinOff } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Layer,
  Map,
  NavigationControl,
  Source,
  type MapLayerMouseEvent,
  type MapRef,
} from 'react-map-gl/maplibre';
import { MediaTile } from '@/components/media/media-tile';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PhotoViewer } from '@/components/viewer/photo-viewer';
import { usePhotoParam } from '@/components/viewer/use-photo-param';
import { libraryQueries } from '@/lib/library';
import { MAP_STYLES, tokenColor } from './map-styles';

type Bbox = [number, number, number, number];

/** MapLibre bounds can run past ±180° when the world wraps; the API wants plain degrees. */
function normaliseBounds(map: MapRef): Bbox {
  const bounds = map.getBounds();
  const south = Math.max(-90, bounds.getSouth());
  const north = Math.min(90, bounds.getNorth());
  if (bounds.getEast() - bounds.getWest() >= 360) return [-180, south, 180, north];
  const wrap = (lng: number) => ((((lng + 180) % 360) + 360) % 360) - 180;
  const round = (value: number) => Math.round(value * 1e5) / 1e5;
  return [round(wrap(bounds.getWest())), round(south), round(wrap(bounds.getEast())), round(north)];
}

function AreaPanel({
  items,
  total,
  loading,
  hasMore,
  loadingMore,
  onMore,
  onOpen,
}: {
  items: AssetTile[];
  total: number;
  loading: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <aside
      aria-label="Photos in this area"
      className="flex h-[42%] shrink-0 flex-col border-t bg-surface md:h-auto md:w-[340px] md:border-t-0 md:border-l"
    >
      <div className="flex h-12 shrink-0 items-center justify-between px-4">
        <h2 className="text-sm font-semibold">In this area</h2>
        <p className="text-xs text-ink-subtle tabular-nums" aria-live="polite">
          {loading ? '' : `${total.toLocaleString()} ${total === 1 ? 'item' : 'items'}`}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {loading ? (
          <div className="grid grid-cols-3 gap-1">
            {Array.from({ length: 12 }, (_, index) => (
              <Skeleton key={index} className="aspect-square rounded-none" />
            ))}
          </div>
        ) : items.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-muted">No photos here. Zoom out or move the map.</p>
        ) : (
          <>
            <ul className="grid grid-cols-3 gap-1">
              {items.map((item) => (
                <li key={item.id} className="aspect-square">
                  <MediaTile tile={item} sizes="(min-width: 768px) 104px, 33vw" onOpen={onOpen} />
                </li>
              ))}
            </ul>
            {hasMore && (
              <Button variant="outline" className="mt-3 w-full" onClick={onMore} disabled={loadingMore}>
                {loadingMore ? 'Loading…' : 'Show more'}
              </Button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

export default function LibraryMap() {
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme === 'dark';
  const params = useSearchParams();
  const points = useQuery(libraryQueries.mapPoints());
  const mapRef = useRef<MapRef>(null);
  const [bbox, setBbox] = useState<Bbox | null>(null);
  const viewer = usePhotoParam();
  const area = useInfiniteQuery({
    ...libraryQueries.search({ bbox: bbox?.join(','), kind: 'photo,video,raw', limit: 60 }),
    enabled: Boolean(bbox),
  });
  const areaItems = useMemo(() => area.data?.pages.flatMap((page) => page.items) ?? [], [area.data]);
  const [colors, setColors] = useState<{ primary: string; onPrimary: string; surface: string } | null>(null);

  // Paint colours come from the design tokens of the current theme.
  useEffect(() => {
    const frame = requestAnimationFrame(() =>
      setColors({
        primary: tokenColor('primary'),
        onPrimary: tokenColor('on-primary'),
        surface: tokenColor('surface'),
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, [dark]);

  const geojson = useMemo<FeatureCollection<Point>>(
    () => ({
      type: 'FeatureCollection',
      features: (points.data?.points ?? []).map(([id, latitude, longitude, video]) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        properties: { id, video },
      })),
    }),
    [points.data],
  );

  const initialView = useMemo(() => {
    const lat = Number(params.get('lat'));
    const lng = Number(params.get('lng'));
    if (params.get('lat') && Number.isFinite(lat) && Number.isFinite(lng)) {
      return { latitude: lat, longitude: lng, zoom: Number(params.get('z')) || 12 };
    }
    const all = points.data?.points ?? [];
    if (all.length === 0) return { latitude: 20, longitude: 0, zoom: 1.5 };
    const lats = all.map((point) => point[1]);
    const lngs = all.map((point) => point[2]);
    return {
      bounds: [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)] as Bbox,
      fitBoundsOptions: { padding: 64, maxZoom: 12 },
    };
    // Only the first view: later data or URL changes must not move the map under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points.isSuccess]);

  const onMoveEnd = useCallback(() => {
    if (mapRef.current) setBbox(normaliseBounds(mapRef.current));
  }, []);

  const onClick = useCallback(
    (event: MapLayerMouseEvent) => {
      const feature = event.features?.[0];
      const map = mapRef.current;
      if (!feature || !map || feature.geometry.type !== 'Point') return;
      const [longitude, latitude] = feature.geometry.coordinates as [number, number];
      if (feature.properties?.cluster) {
        const source = map.getSource<GeoJSONSource>('photos');
        void source
          ?.getClusterExpansionZoom(feature.properties.cluster_id as number)
          .then((zoom) =>
            map.easeTo({ center: [longitude, latitude], zoom: Math.min(zoom, 18), duration: 400 }),
          );
      } else {
        viewer.open(String(feature.properties?.id));
      }
    },
    [viewer],
  );

  if (points.isPending || !colors) return <Skeleton className="size-full rounded-none" />;
  if (points.isError) {
    return (
      <div role="alert" className="m-auto p-8 text-center">
        <p className="font-medium">The map couldn’t be loaded</p>
        <p className="mt-1 text-sm text-ink-muted">Check that the API is running, then reload.</p>
      </div>
    );
  }
  if (geojson.features.length === 0) {
    return (
      <div className="m-auto max-w-sm p-8 text-center">
        <span className="mx-auto grid size-12 place-items-center rounded-full bg-surface-sunken text-ink-muted ring-1 ring-border">
          <MapPinOff className="size-5" aria-hidden="true" />
        </span>
        <p className="mt-5 font-semibold">No photos with a location yet</p>
        <p className="mt-1.5 text-sm text-ink-muted">
          Photos taken with location turned on appear here once they have been processed.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="relative min-h-0 min-w-0 flex-1">
        <Map
          ref={mapRef}
          initialViewState={initialView}
          mapStyle={dark ? MAP_STYLES.dark : MAP_STYLES.light}
          interactiveLayerIds={['clusters', 'points']}
          onClick={onClick}
          onLoad={onMoveEnd}
          onMoveEnd={onMoveEnd}
          cursor="auto"
          style={{ width: '100%', height: '100%' }}
          attributionControl={{ compact: true }}
        >
          <NavigationControl position="top-right" showCompass={false} />
          <Source id="photos" type="geojson" data={geojson} cluster clusterRadius={48} clusterMaxZoom={16}>
            <Layer
              id="clusters"
              type="circle"
              filter={['has', 'point_count']}
              paint={{
                'circle-color': colors.primary,
                'circle-opacity': 0.92,
                'circle-radius': ['step', ['get', 'point_count'], 15, 25, 19, 250, 24, 2500, 30],
                'circle-stroke-width': 3,
                'circle-stroke-color': colors.surface,
              }}
            />
            <Layer
              id="cluster-count"
              type="symbol"
              filter={['has', 'point_count']}
              layout={{
                'text-field': ['get', 'point_count_abbreviated'],
                'text-font': ['Noto Sans Regular'],
                'text-size': 12,
                'text-allow-overlap': true,
              }}
              paint={{ 'text-color': colors.onPrimary }}
            />
            <Layer
              id="points"
              type="circle"
              filter={['!', ['has', 'point_count']]}
              paint={{
                'circle-color': colors.primary,
                'circle-radius': 7,
                'circle-stroke-width': 2.5,
                'circle-stroke-color': colors.surface,
              }}
            />
          </Source>
        </Map>
      </div>
      <AreaPanel
        items={areaItems}
        total={area.data?.pages[0]?.total ?? 0}
        loading={area.isPending}
        hasMore={Boolean(area.hasNextPage)}
        loadingMore={area.isFetchingNextPage}
        onMore={() => void area.fetchNextPage()}
        onOpen={viewer.open}
      />
      {viewer.photoId && (
        <PhotoViewer
          items={areaItems}
          currentId={viewer.photoId}
          onShow={viewer.show}
          onClose={viewer.close}
          onNearEdge={(direction) => direction === 'next' && area.hasNextPage && void area.fetchNextPage()}
        />
      )}
    </div>
  );
}
