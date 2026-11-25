import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { PageHeader } from './page-header';

/** Placeholder for a screen that arrives in a later milestone. */
export function ComingSoon({
  title,
  icon: Icon,
  summary,
  milestone,
  children,
}: {
  title: string;
  icon: LucideIcon;
  summary: string;
  milestone: string;
  /** What already works here, shown under the placeholder. */
  children?: ReactNode;
}) {
  return (
    <>
      <PageHeader title={title} />
      <section className="grid place-items-center px-4 py-24 text-center sm:px-8">
        <div className="max-w-sm">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-surface-sunken text-ink-muted ring-1 ring-border">
            <Icon className="size-5" aria-hidden="true" />
          </span>
          <h2 className="mt-5 text-base font-semibold">Not built yet</h2>
          <p className="mt-1.5 text-sm text-ink-muted">{summary}</p>
          <p className="mt-4 text-xs text-ink-subtle">Planned for milestone {milestone}</p>
        </div>
      </section>
      {children}
    </>
  );
}
