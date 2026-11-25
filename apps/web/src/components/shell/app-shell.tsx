'use client';

import { Check, LogOut, Menu, Monitor, Moon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { Brand } from '@/components/brand';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { UploadButton, UploadDialog, UploadTray } from '@/components/upload/upload-dialog';
import { UploadProvider } from '@/components/upload/upload-provider';
import { authStep } from '@/lib/api';
import { cn } from '@/lib/utils';
import { isActive, libraryNav, manageNav, type NavItem } from './nav';

export interface ShellUser {
  displayName: string;
  email: string;
}

export function AppShell({ user, children }: { user: ShellUser; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <UploadProvider>
      <div className="min-h-dvh lg:grid lg:grid-cols-[232px_1fr]">
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-on-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>

        <aside className="sticky top-0 hidden h-dvh flex-col border-r bg-surface lg:flex">
          <Sidebar user={user} />
        </aside>

        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b bg-surface/90 px-4 backdrop-blur lg:hidden">
          <Link href="/" className="rounded-md">
            <Brand />
          </Link>
          <div className="flex items-center gap-1">
            <UploadButton compact />
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon-lg" aria-label="Open menu">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[264px] gap-0 bg-surface p-0">
                <SheetTitle className="sr-only">Menu</SheetTitle>
                <SheetDescription className="sr-only">Go to a part of your library</SheetDescription>
                <Sidebar user={user} onNavigate={() => setMenuOpen(false)} />
              </SheetContent>
            </Sheet>
          </div>
        </header>

        <main id="main" className="min-w-0">
          {children}
        </main>
      </div>
      <UploadDialog />
      <UploadTray />
    </UploadProvider>
  );
}

function Sidebar({ user, onNavigate }: { user: ShellUser; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 items-center px-5">
        <Link href="/" className="rounded-md" onClick={onNavigate}>
          <Brand />
        </Link>
      </div>
      <div className="px-3 pb-2">
        <UploadButton />
      </div>
      <nav aria-label="Main" className="flex flex-1 flex-col gap-6 overflow-y-auto px-3 py-2">
        <NavGroup items={libraryNav} pathname={pathname} onNavigate={onNavigate} />
        <NavGroup label="Manage" items={manageNav} pathname={pathname} onNavigate={onNavigate} />
      </nav>
      <div className="border-t p-3">
        <UserMenu user={user} />
      </div>
    </div>
  );
}

function NavGroup({
  label,
  items,
  pathname,
  onNavigate,
}: {
  label?: string;
  items: NavItem[];
  pathname: string;
  onNavigate?: (() => void) | undefined;
}) {
  return (
    <div>
      {label && <p className="mb-1 px-3 text-xs font-medium text-ink-subtle">{label}</p>}
      <ul className="space-y-0.5">
        {items.map((item) => {
          const active = isActive(item, pathname);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex h-10 items-center gap-3 rounded-md px-3 text-sm transition-colors duration-(--duration-fast)',
                  active
                    ? 'bg-surface-sunken font-medium text-ink'
                    : 'text-ink-muted hover:bg-surface-sunken hover:text-ink',
                )}
              >
                <item.icon
                  className="size-[18px] shrink-0"
                  strokeWidth={active ? 2.25 : 1.75}
                  aria-hidden="true"
                />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function UserMenu({ user }: { user: ShellUser }) {
  const { theme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const initials = user.displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const signOut = async () => {
    setSigningOut(true);
    await authStep('logout').catch(() => undefined);
    // A full page load, so nothing from the library stays in this tab's memory.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign('/sign-in');
  };

  const themes = [
    { value: 'light', label: 'Light', icon: Sun },
    { value: 'dark', label: 'Dark', icon: Moon },
    { value: 'system', label: 'Match system', icon: Monitor },
  ] as const;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-surface-sunken"
          aria-label={`Account menu for ${user.displayName}`}
        >
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-sunken text-xs font-semibold text-ink-muted ring-1 ring-border"
          >
            {initials}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">{user.displayName}</span>
            <span className="block truncate text-xs text-ink-subtle">{user.email}</span>
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel className="text-xs font-medium text-ink-subtle">Appearance</DropdownMenuLabel>
        {themes.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => setTheme(option.value)}>
            <option.icon aria-hidden="true" />
            {option.label}
            {theme === option.value && <Check className="ml-auto" aria-label="Selected" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()} disabled={signingOut}>
          <LogOut aria-hidden="true" />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
