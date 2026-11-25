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
      <section className="px-4 py-16 sm:px-8">
        <Icon className="size-6 text-ink-subtle" strokeWidth={1.6} aria-hidden="true" />
        <h2 className="mt-4 text-lg font-medium">Coming in milestone {milestone}</h2>
        <p className="mt-1.5 max-w-md text-sm text-ink-muted">{summary}</p>
      </section>
      {children}
    </>
  );
}
