/** The sidebar's size, kept in a cookie so the server renders it right from the first paint. */
export interface SidebarState {
  collapsed: boolean;
  /** Width when expanded, in px. */
  width: number;
}

export const SIDEBAR = {
  /** Default width. */
  width: 248,
  min: 208,
  max: 360,
  /** Width of the icon rail. */
  rail: 68,
  /** Dragging the edge further left than this collapses to the rail. */
  collapseBelow: 160,
  cookie: 'mv_sidebar',
} as const;

export const DEFAULT_SIDEBAR: SidebarState = { collapsed: false, width: SIDEBAR.width };

/** "e.248" (expanded, 248 px) or "c.248" (collapsed; the width is kept for when it opens). */
export function parseSidebar(value: string | undefined): SidebarState {
  const match = /^([ec])\.(\d{3})$/.exec(value ?? '');
  if (!match) return DEFAULT_SIDEBAR;
  const width = Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, Number(match[2])));
  return { collapsed: match[1] === 'c', width };
}

export function sidebarCookie(state: SidebarState): string {
  return `${SIDEBAR.cookie}=${state.collapsed ? 'c' : 'e'}.${state.width}; Path=/; Max-Age=31536000; SameSite=Lax`;
}
