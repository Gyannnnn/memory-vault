import { cn } from '@/lib/utils';
import type { NavItem, Tint } from './nav';

// Whole class names, so Tailwind finds them.
const TILE: Record<Tint, string> = {
  blue: 'bg-tint-blue',
  violet: 'bg-tint-violet',
  amber: 'bg-tint-amber',
  rose: 'bg-tint-rose',
  orange: 'bg-tint-orange',
  green: 'bg-tint-green',
  teal: 'bg-tint-teal',
  gray: 'bg-tint-gray',
  slate: 'bg-tint-slate',
};

/** A destination's icon on its coloured tile: 24 px in the sidebar, 28 px in the phone's More sheet. */
export function NavIcon({ item, size = 'md' }: { item: NavItem; size?: 'md' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid shrink-0 place-items-center text-on-tint ring-1 ring-ink/10 ring-inset',
        size === 'lg' ? 'size-7 rounded-[8px]' : 'size-6 rounded-[7px]',
        TILE[item.tint],
      )}
    >
      <item.icon className={size === 'lg' ? 'size-4' : 'size-3.5'} strokeWidth={2.25} />
    </span>
  );
}
