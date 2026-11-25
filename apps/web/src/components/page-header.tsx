import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b px-4 pt-8 pb-6 sm:px-8 md:pt-10">
      <div className="min-w-0">
        <h1 className="text-3xl font-medium tracking-display">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-prose text-sm text-ink-muted tabular-nums">{description}</p>
        )}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
