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

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra paths that should highlight this item. */
  matches?: string[];
}

export const libraryNav: NavItem[] = [
  { href: '/', label: 'Photos', icon: Images },
  { href: '/search', label: 'Search', icon: Search },
  { href: '/folders', label: 'Folders', icon: Folder },
  { href: '/albums', label: 'Albums', icon: BookImage },
  { href: '/people', label: 'People', icon: Users },
  { href: '/map', label: 'Map', icon: Map },
];

export const manageNav: NavItem[] = [
  { href: '/trash', label: 'Trash', icon: Trash2 },
  { href: '/stats', label: 'Storage', icon: ChartPie },
  { href: '/settings/security', label: 'Settings', icon: Settings, matches: ['/settings'] },
];

export function isActive(item: NavItem, pathname: string): boolean {
  if (item.href === '/') return pathname === '/';
  return [item.href, ...(item.matches ?? [])].some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}
