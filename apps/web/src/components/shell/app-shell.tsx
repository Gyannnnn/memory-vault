'use client';

import {
  Check,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Upload,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { UploadDialog, UploadTray } from '@/components/upload/upload-dialog';
import { UploadProvider, useUploads } from '@/components/upload/upload-provider';
import { authStep } from '@/lib/api';
import { cn } from '@/lib/utils';
import { isActive, libraryNav, manageNav, mobileMoreNav, mobileTabs, type NavItem } from './nav';
import { SIDEBAR, sidebarCookie, type SidebarState } from './sidebar-state';

export interface ShellUser {
  displayName: string;
  email: string;
}

const THEMES = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
] as const;

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

async function signOut() {
  await authStep('logout').catch(() => undefined);
  // A full page load, so nothing from the library stays in this tab's memory.
  // eslint-disable-next-line @next/next/no-location-assign-relative-destination
  window.location.assign('/sign-in');
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

/**
 * The frame around every signed-in page. From 768 px a sidebar that collapses to an icon
 * rail (button or Ctrl/⌘ B) and resizes by its edge; on a phone a top bar, a tab bar at the
 * foot and a full-screen sheet for the rest.
 */
export function AppShell({
  user,
  sidebar: initial,
  children,
}: {
  user: ShellUser;
  sidebar: SidebarState;
  children: ReactNode;
}) {
  const [sidebar, setSidebar] = useState(initial);

  const update = useCallback((next: SidebarState) => {
    setSidebar(next);
    document.cookie = sidebarCookie(next);
  }, []);
  const toggle = useCallback(
    () =>
      setSidebar((current) => {
        const next = { ...current, collapsed: !current.collapsed };
        document.cookie = sidebarCookie(next);
        return next;
      }),
    [],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== 'b' ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (isTyping(event.target) || document.querySelector('[role=dialog]')) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const width = sidebar.collapsed ? SIDEBAR.rail : sidebar.width;

  return (
    <UploadProvider>
      <div style={{ '--sidebar': `${width}px` } as CSSProperties}>
        <a
          href="#main"
          className="sr-only z-50 rounded-md bg-primary px-3 py-2 text-sm text-on-primary focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
        >
          Skip to content
        </a>
        <div className="min-h-dvh md:grid md:grid-cols-[var(--sidebar)_minmax(0,1fr)]">
          <aside className="sticky top-0 hidden h-dvh border-r bg-surface md:block" aria-label="Sidebar">
            <Sidebar user={user} collapsed={sidebar.collapsed} onToggle={toggle} />
            <ResizeHandle state={sidebar} onChange={update} />
          </aside>
          <PhoneTopBar user={user} />
          <main id="main" className="min-w-0 pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
            {children}
          </main>
          <PhoneTabBar user={user} />
        </div>
        <UploadDialog />
        <UploadTray />
      </div>
    </UploadProvider>
  );
}

/* ---------------------------------------------------------------- sidebar */

function Sidebar({
  user,
  collapsed,
  onToggle,
}: {
  user: ShellUser;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();
  const { setOpen } = useUploads();
  const toggleLabel = collapsed ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <div className="flex h-full flex-col">
      <div
        className={cn('flex h-14 shrink-0 items-center', collapsed ? 'justify-center' : 'gap-2 pr-2 pl-4')}
      >
        {!collapsed && (
          <Link href="/" className="min-w-0 flex-1 rounded-md" aria-label="Memory Vault, Photos">
            <Brand />
          </Link>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggle}
              aria-label={toggleLabel}
              aria-keyshortcuts="Control+B Meta+B"
              aria-expanded={!collapsed}
            >
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">
            {toggleLabel} <kbd className="ml-1.5 font-sans opacity-70">Ctrl B</kbd>
          </TooltipContent>
        </Tooltip>
      </div>

      <div className={cn('shrink-0 pb-4', collapsed ? 'flex justify-center' : 'px-3')}>
        {collapsed ? (
          <RailTip label="Upload">
            <Button size="icon" onClick={() => setOpen(true)} aria-label="Upload">
              <Upload />
            </Button>
          </RailTip>
        ) : (
          <Button className="w-full" onClick={() => setOpen(true)}>
            <Upload aria-hidden="true" /> Upload
          </Button>
        )}
      </div>

      <nav
        aria-label="Main"
        className={cn('min-h-0 flex-1 overflow-y-auto pb-4', collapsed ? 'px-3.5' : 'px-3')}
      >
        <NavList items={libraryNav} pathname={pathname} collapsed={collapsed} />
        {collapsed ? (
          <div className="mx-2 my-3 border-t" role="presentation" />
        ) : (
          <p className="mt-6 mb-1 px-3 text-xs font-medium text-ink-subtle">Manage</p>
        )}
        <NavList items={manageNav} pathname={pathname} collapsed={collapsed} />
      </nav>

      <div className={cn('shrink-0 border-t', collapsed ? 'flex justify-center py-2' : 'p-2')}>
        <AccountMenu user={user} compact={collapsed} side={collapsed ? 'right' : 'top'} />
      </div>
    </div>
  );
}

function RailTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

function NavList({ items, pathname, collapsed }: { items: NavItem[]; pathname: string; collapsed: boolean }) {
  return (
    <ul className="space-y-0.5">
      {items.map((item) => {
        const active = isActive(item, pathname);
        const link = (
          <Link
            href={item.href}
            aria-current={active ? 'page' : undefined}
            aria-label={collapsed ? item.label : undefined}
            className={cn(
              'flex h-9 items-center rounded-md text-sm font-medium transition-colors duration-(--duration-fast)',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              collapsed ? 'w-10 justify-center' : 'gap-3 px-3',
              active
                ? 'bg-surface-sunken text-ink'
                : 'text-ink-muted hover:bg-surface-sunken/70 hover:text-ink',
            )}
          >
            <item.icon
              className="size-[18px] shrink-0"
              strokeWidth={active ? 2.1 : 1.75}
              aria-hidden="true"
            />
            {!collapsed && <span className="truncate">{item.label}</span>}
          </Link>
        );
        return <li key={item.href}>{collapsed ? <RailTip label={item.label}>{link}</RailTip> : link}</li>;
      })}
    </ul>
  );
}

/**
 * The sidebar's right edge: drag to resize (far left collapses it to the rail, dragging out
 * of the rail opens it again), double-click for the default width, or focus it and use the
 * arrow keys (Enter collapses or expands).
 */
function ResizeHandle({ state, onChange }: { state: SidebarState; onChange: (next: SidebarState) => void }) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  const at = (x: number, base: SidebarState): SidebarState =>
    x < SIDEBAR.collapseBelow
      ? { ...base, collapsed: true }
      : { collapsed: false, width: Math.round(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, x))) };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR.min}
      aria-valuemax={SIDEBAR.max}
      aria-valuenow={state.collapsed ? SIDEBAR.rail : state.width}
      tabIndex={0}
      data-dragging={dragging || undefined}
      title="Drag to resize, double-click to reset"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
      }}
      onPointerMove={(event) => {
        if (!dragging) return;
        const current = latest.current;
        const next = at(event.clientX, current);
        if (next.collapsed !== current.collapsed || next.width !== current.width) {
          latest.current = next;
          onChange(next);
        }
      }}
      onPointerUp={(event) => {
        if (!dragging) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        setDragging(false);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      }}
      onDoubleClick={() => onChange({ collapsed: false, width: SIDEBAR.width })}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 16;
        const width = state.collapsed ? SIDEBAR.min : state.width;
        const keys: Record<string, SidebarState> = {
          ArrowLeft: at(width - step, state),
          ArrowRight: {
            collapsed: false,
            width: Math.min(SIDEBAR.max, width + (state.collapsed ? 0 : step)),
          },
          Home: { collapsed: false, width: SIDEBAR.min },
          End: { collapsed: false, width: SIDEBAR.max },
          Enter: { ...state, collapsed: !state.collapsed },
        };
        const next = keys[event.key];
        if (!next) return;
        event.preventDefault();
        onChange(next);
      }}
      className="group absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize outline-none"
    >
      <span
        aria-hidden="true"
        className={cn(
          'absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors duration-(--duration-fast)',
          'group-hover:bg-border-strong group-focus-visible:bg-focus group-data-[dragging]:bg-focus',
        )}
      />
    </div>
  );
}

/* ---------------------------------------------------------------- account */

function AccountMenu({
  user,
  compact,
  side,
}: {
  user: ShellUser;
  compact: boolean;
  side: 'top' | 'right' | 'bottom';
}) {
  const { theme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Account: ${user.displayName}`}
          className={cn(
            'flex items-center rounded-md text-left transition-colors duration-(--duration-fast) hover:bg-surface-sunken',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            compact ? 'size-11 justify-center' : 'w-full gap-3 p-2',
          )}
        >
          <span
            aria-hidden="true"
            className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-sunken text-xs font-medium text-ink ring-1 ring-border"
          >
            {initialsOf(user.displayName)}
          </span>
          {!compact && (
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium">{user.displayName}</span>
              <span className="block truncate text-xs text-ink-muted">{user.email}</span>
            </span>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side={side} align={side === 'right' ? 'end' : 'start'} className="w-60">
        <DropdownMenuLabel className="text-xs font-medium text-ink-muted">Appearance</DropdownMenuLabel>
        {THEMES.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => setTheme(option.value)}>
            <option.icon aria-hidden="true" />
            {option.label}
            {theme === option.value && <Check className="ml-auto" aria-label="Selected" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={signingOut}
          onSelect={() => {
            setSigningOut(true);
            void signOut();
          }}
        >
          <LogOut aria-hidden="true" />
          {signingOut ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ---------------------------------------------------------------- phone */

function PhoneTopBar({ user }: { user: ShellUser }) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b bg-surface pr-1.5 pl-4 md:hidden">
      <Link href="/" className="rounded-md" aria-label="Memory Vault, Photos">
        <Brand />
      </Link>
      <AccountMenu user={user} compact side="bottom" />
    </header>
  );
}

function PhoneTabBar({ user }: { user: ShellUser }) {
  const pathname = usePathname();
  const { setOpen } = useUploads();
  const [more, setMore] = useState(false);
  const moreActive = mobileMoreNav.some((item) => isActive(item, pathname));
  // The sheet closes once a link in it has changed the page.
  const [shownFor, setShownFor] = useState(pathname);
  if (shownFor !== pathname) {
    setShownFor(pathname);
    setMore(false);
  }

  const tab =
    'flex h-full w-full flex-col items-center justify-center gap-1 text-xs font-medium outline-none focus-visible:bg-surface-sunken';

  return (
    <>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-30 border-t bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <ul className="grid h-16 grid-cols-5">
          {mobileTabs.slice(0, 2).map((item) => (
            <PhoneTab key={item.href} item={item} active={isActive(item, pathname)} className={tab} />
          ))}
          <li>
            <button type="button" onClick={() => setOpen(true)} className={cn(tab, 'text-ink')}>
              <span className="-my-[5px] grid size-8 place-items-center rounded-full bg-primary text-on-primary">
                <Upload className="size-4" aria-hidden="true" />
              </span>
              Upload
            </button>
          </li>
          {mobileTabs.slice(2).map((item) => (
            <PhoneTab key={item.href} item={item} active={isActive(item, pathname)} className={tab} />
          ))}
          <li>
            <button
              type="button"
              aria-haspopup="dialog"
              aria-expanded={more}
              onClick={() => setMore(true)}
              className={cn(tab, moreActive ? 'text-ink' : 'text-ink-subtle')}
            >
              <MoreHorizontal
                className="size-[22px]"
                strokeWidth={moreActive ? 2.1 : 1.75}
                aria-hidden="true"
              />
              More
            </button>
          </li>
        </ul>
      </nav>
      <MoreSheet open={more} onOpenChange={setMore} user={user} pathname={pathname} />
    </>
  );
}

function PhoneTab({ item, active, className }: { item: NavItem; active: boolean; className: string }) {
  return (
    <li>
      <Link
        href={item.href}
        aria-current={active ? 'page' : undefined}
        className={cn(className, active ? 'text-ink' : 'text-ink-subtle')}
      >
        <item.icon className="size-[22px]" strokeWidth={active ? 2.1 : 1.75} aria-hidden="true" />
        {item.label}
      </Link>
    </li>
  );
}

/** Everything the tab bar has no room for, full screen, in rows a thumb can hit. */
function MoreSheet({
  open,
  onOpenChange,
  user,
  pathname,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: ShellUser;
  pathname: string;
}) {
  const { theme, setTheme } = useTheme();
  const [signingOut, setSigningOut] = useState(false);
  const row =
    'flex h-14 w-full items-center gap-4 px-5 text-base outline-none transition-colors duration-(--duration-fast) focus-visible:bg-surface-sunken active:bg-surface-sunken';

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content className="fixed inset-0 z-50 flex flex-col bg-surface outline-none md:hidden">
          <header className="flex h-14 shrink-0 items-center justify-between border-b pr-1.5 pl-5">
            <DialogPrimitive.Title className="text-base font-medium">More</DialogPrimitive.Title>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-lg" aria-label="Close">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </header>
          <DialogPrimitive.Description className="sr-only">
            Albums, people, map, trash, storage, settings, appearance and your account
          </DialogPrimitive.Description>

          <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
            <ul className="py-2">
              {mobileMoreNav.map((item) => {
                const active = isActive(item, pathname);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      onClick={() => onOpenChange(false)}
                      className={cn(row, 'text-ink', active && 'font-medium')}
                    >
                      <item.icon
                        className="size-[22px] text-ink-muted"
                        strokeWidth={1.75}
                        aria-hidden="true"
                      />
                      <span className="flex-1">{item.label}</span>
                      {active && <Check className="size-[18px] text-ink-muted" aria-label="Current page" />}
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className="border-t px-5 py-5">
              <p id="appearance-label" className="text-xs font-medium text-ink-muted">
                Appearance
              </p>
              <div
                role="radiogroup"
                aria-labelledby="appearance-label"
                className="mt-2 grid grid-cols-3 gap-1 rounded-lg bg-surface-sunken p-1"
              >
                {THEMES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={theme === option.value}
                    onClick={() => setTheme(option.value)}
                    className={cn(
                      'flex h-11 items-center justify-center gap-2 rounded-md text-sm font-medium outline-none transition-colors duration-(--duration-fast)',
                      'focus-visible:outline-2 focus-visible:outline-focus',
                      theme === option.value ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted',
                    )}
                  >
                    <option.icon className="size-4" aria-hidden="true" />
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="border-t">
              <div className="flex items-center gap-3 px-5 pt-5 pb-3">
                <span
                  aria-hidden="true"
                  className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-sunken text-sm font-medium ring-1 ring-border"
                >
                  {initialsOf(user.displayName)}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-base font-medium">{user.displayName}</span>
                  <span className="block truncate text-sm text-ink-muted">{user.email}</span>
                </span>
              </div>
              <button
                type="button"
                disabled={signingOut}
                onClick={() => {
                  setSigningOut(true);
                  void signOut();
                }}
                className={cn(row, 'text-skip')}
              >
                <LogOut className="size-[22px]" strokeWidth={1.75} aria-hidden="true" />
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
