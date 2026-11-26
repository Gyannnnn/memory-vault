'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/settings/security', label: 'Security' },
  { href: '/settings/sharing', label: 'Sharing' },
  { href: '/settings/activity', label: 'Activity' },
];

/** Settings' page bar: its name, then one tab per section. */
export function SettingsHeader() {
  const pathname = usePathname();
  return (
    <header className="border-b px-4 sm:px-8">
      <div className="flex h-12 items-center md:h-14">
        <h1 className="text-lg font-medium tracking-tight">Settings</h1>
      </div>
      <nav aria-label="Settings sections" className="-mb-px flex gap-6">
        {TABS.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex h-10 items-center border-b-2 text-sm font-medium transition-colors duration-(--duration-fast)',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                active ? 'border-ink text-ink' : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
