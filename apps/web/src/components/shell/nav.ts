import {
  BookImage,
  ChartPie,
  Folder,
  Images,
  Map,
  Search,
  Settings,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react';

export type Tint = 'blue' | 'violet' | 'amber' | 'rose' | 'orange' | 'green' | 'teal' | 'gray' | 'slate';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The colour of the item's icon tile. */
  tint: Tint;
  /** Extra paths that should highlight this item. */
  matches?: string[];
}

export const libraryNav: NavItem[] = [
  { href: '/', label: 'Photos', icon: Images, tint: 'blue' },
  { href: '/search', label: 'Search', icon: Search, tint: 'violet' },
  { href: '/folders', label: 'Folders', icon: Folder, tint: 'amber' },
  { href: '/albums', label: 'Albums', icon: BookImage, tint: 'rose' },
  { href: '/people', label: 'People', icon: Users, tint: 'orange' },
  { href: '/map', label: 'Map', icon: Map, tint: 'green' },
];

export const manageNav: NavItem[] = [
  { href: '/trash', label: 'Trash', icon: Trash2, tint: 'gray' },
  { href: '/stats', label: 'Storage', icon: ChartPie, tint: 'teal' },
  { href: '/settings/security', label: 'Settings', icon: Settings, tint: 'slate', matches: ['/settings'] },
];

/** The phone's tab bar: these three around the Upload button, then More. */
export const mobileTabs: NavItem[] = [libraryNav[0]!, libraryNav[1]!, libraryNav[2]!];

/** Everything else, in the More sheet. */
export const mobileMoreNav: NavItem[] = [...libraryNav.slice(3), ...manageNav];

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.href === '/') return pathname === '/';
  return [item.href, ...(item.matches ?? [])].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}
