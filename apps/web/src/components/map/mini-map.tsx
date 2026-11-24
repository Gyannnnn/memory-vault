'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import './maplibre';
import { Map, Marker } from 'react-map-gl/maplibre';
import { MAP_STYLES } from './map-styles';

/** A small, still map with a pin: where a photo was taken. */
export default function MiniMap({
  latitude,
  longitude,
  dark,
}: {
  latitude: number;
  longitude: number;
  dark: boolean;
}) {
  return (
    <Map
      initialViewState={{ latitude, longitude, zoom: 11 }}
      mapStyle={dark ? MAP_STYLES.dark : MAP_STYLES.light}
      interactive={false}
      // Credited in text right below the map instead of an overlay on this small map.
      attributionControl={false}
      style={{ width: '100%', height: '100%' }}
    >
      <Marker latitude={latitude} longitude={longitude} anchor="bottom">
        <svg viewBox="0 0 24 32" className="h-8 w-6 drop-shadow" aria-hidden="true">
          <path
            d="M12 0C5.4 0 0 5.2 0 11.7 0 20.4 12 32 12 32s12-11.6 12-20.3C24 5.2 18.6 0 12 0Z"
            className="fill-primary"
          />
          <circle cx="12" cy="11.5" r="4.5" className="fill-on-primary" />
        </svg>
      </Marker>
    </Map>
  );
}
