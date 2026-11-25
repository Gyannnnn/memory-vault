import type { ReactNode } from 'react';

/**
 * The bar at the top of a page: its name, a short fact beside it, actions on the right.
 * 56 px, the height of the sidebar's top row, so their hairlines meet.
 */
export function PageHeader({
  title,
  description,
  actions,
  trail,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Shown before the title, e.g. the folders above this one. */
  trail?: ReactNode;
}) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-4 border-b px-4 sm:px-8 md:h-14">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {trail}
        <h1 className="min-w-0 truncate text-lg font-medium tracking-tight">{title}</h1>
        {description && (
          <p className="min-w-0 shrink-[100] truncate pt-px text-sm text-ink-muted tabular-nums">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
