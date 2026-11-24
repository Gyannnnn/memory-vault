import { AlertCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `section-${title.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <section
      aria-labelledby={headingId}
      className="grid gap-6 border-b px-4 py-8 sm:px-8 lg:grid-cols-[280px_minmax(0,1fr)] lg:gap-12"
    >
      <div>
        <h2 id={headingId} className="text-[15px] font-semibold">
          {title}
        </h2>
        <p className="mt-1 text-sm text-ink-muted">{description}</p>
        {action && <div className="mt-4">{action}</div>}
      </div>
      <div className="min-w-0 max-w-2xl">{children}</div>
    </section>
  );
}

export function Rows({ children }: { children: ReactNode }) {
  return <ul className="divide-y rounded-lg border bg-surface">{children}</ul>;
}

export function Row({
  icon,
  title,
  meta,
  badge,
  actions,
}: {
  icon: ReactNode;
  title: ReactNode;
  meta: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-4 px-4 py-3.5">
      <span className="grid size-9 shrink-0 place-items-center rounded-md bg-surface-sunken text-ink-muted">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <span className="truncate">{title}</span>
          {badge}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-subtle">{meta}</p>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </li>
  );
}

export function RowsLoading({ count = 2 }: { count?: number }) {
  return (
    <Rows>
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="flex items-center gap-4 px-4 py-3.5" aria-hidden="true">
          <Skeleton className="size-9 rounded-md" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </li>
      ))}
      <li className="sr-only">Loading</li>
    </Rows>
  );
}

export function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-3 rounded-lg border border-skip/30 bg-skip-soft px-4 py-3 text-sm"
    >
      <AlertCircle className="size-4 shrink-0 text-skip" aria-hidden="true" />
      <span className="flex-1">{message}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
