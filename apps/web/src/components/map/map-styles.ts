/**
 * OpenFreeMap vector tiles (OpenStreetMap data): no API key and no account. The browser
 * fetches tiles for the area being viewed; photos and their positions are never sent.
 */
export const MAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/positron',
  dark: 'https://tiles.openfreemap.org/styles/dark',
} as const;

/** Reads a design-token colour (MapLibre paints need concrete values, not CSS variables). */
export function tokenColor(name: string, element: Element = document.documentElement): string {
  return getComputedStyle(element).getPropertyValue(`--color-${name}`).trim() || '#18181b';
}
