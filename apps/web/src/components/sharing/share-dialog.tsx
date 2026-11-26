'use client';

import type { CreateShareRequest, ShareKind, ShareLinkSummary } from '@memory-vault/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Link2, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

const EXPIRY = [
  { value: 1, label: '1 day' },
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: null, label: 'Never' },
] as const;

const what: Record<ShareKind, string> = { photo: 'this photo', album: 'this album', folder: 'this folder' };

export const shareUrl = (token: string) =>
  `${typeof window === 'undefined' ? '' : window.location.origin}/s/${token}`;

/** Makes a link to a photo, an album or a folder, then shows it to copy. */
export function ShareDialog({
  kind,
  targetId,
  open,
  onOpenChange,
}: {
  kind: ShareKind;
  targetId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {open && <ShareForm kind={kind} targetId={targetId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

function ShareForm({ kind, targetId, onDone }: { kind: ShareKind; targetId: string; onDone: () => void }) {
  const queryClient = useQueryClient();
  const ids = useId();
  const [expiresInDays, setExpiresInDays] = useState<1 | 7 | 30 | null>(7);
  const [allowDownload, setAllowDownload] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ShareLinkSummary | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (password && password.length < 4) {
      setError('Use at least 4 characters for the password, or leave it empty');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body: CreateShareRequest = {
        kind,
        targetId,
        expiresInDays,
        allowDownload,
        ...(password ? { password } : {}),
      };
      setLink(await api<ShareLinkSummary>('/shares', { method: 'POST', body }));
      void queryClient.invalidateQueries({ queryKey: ['shares'] });
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(shareUrl(link.token));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copying didn’t work: select the link and copy it yourself');
    }
  };

  if (link) {
    return (
      <div className="grid gap-5">
        <DialogHeader>
          <DialogTitle>Link ready</DialogTitle>
          <DialogDescription>
            Anyone with it can see {what[kind]}
            {link.expiresAt
              ? ` until ${new Date(link.expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
              : ''}
            {link.hasPassword ? ', with the password' : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <label htmlFor={`${ids}-url`} className="sr-only">
            Link
          </label>
          <Input
            id={`${ids}-url`}
            readOnly
            value={shareUrl(link.token)}
            onFocus={(event) => event.currentTarget.select()}
            className="h-10 font-mono text-sm"
          />
          <Button onClick={() => void copy()} className="shrink-0">
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        {error && <p className="text-sm text-skip">{error}</p>}
        <p className="text-xs text-ink-muted">
          Until Memory Vault is online, the link opens only on this computer. Turn it off any time in{' '}
          <Link href="/settings/sharing" onClick={onDone} className="underline underline-offset-2">
            Settings › Sharing
          </Link>
          .
        </p>
        <DialogFooter>
          <Button onClick={onDone}>Done</Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void create(event)} className="grid gap-6" noValidate>
      <DialogHeader>
        <DialogTitle>Share {what[kind]}</DialogTitle>
        <DialogDescription>Make a link that shows it without signing in.</DialogDescription>
      </DialogHeader>

      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">Link expires after</legend>
        <div role="radiogroup" className="grid grid-cols-4 gap-1 rounded-lg bg-surface-sunken p-1">
          {EXPIRY.map((option) => (
            <button
              key={option.label}
              type="button"
              role="radio"
              aria-checked={expiresInDays === option.value}
              onClick={() => setExpiresInDays(option.value)}
              className={cn(
                'h-9 rounded-md text-sm font-medium transition-colors duration-(--duration-fast)',
                'focus-visible:outline-2 focus-visible:outline-focus',
                expiresInDays === option.value
                  ? 'bg-surface text-ink shadow-sm'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex items-start justify-between gap-4">
        <div>
          <p id={`${ids}-download`} className="text-sm font-medium">
            Allow downloads
          </p>
          <p className="mt-0.5 text-sm text-ink-muted">
            Visitors can save the originals, one by one or as a zip.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowDownload}
          aria-labelledby={`${ids}-download`}
          onClick={() => setAllowDownload((value) => !value)}
          className={cn(
            'relative mt-0.5 h-6 w-10 shrink-0 rounded-full transition-colors duration-(--duration-fast)',
            'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
            allowDownload ? 'bg-primary' : 'bg-border-strong',
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              'absolute top-0.5 left-0.5 size-5 rounded-full bg-surface shadow-sm transition-transform duration-(--duration-fast)',
              allowDownload && 'translate-x-4',
            )}
          />
        </button>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={`${ids}-password`}>
          Password <span className="font-normal text-ink-muted">(optional)</span>
        </Label>
        <Input
          id={`${ids}-password`}
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          maxLength={200}
          className="h-10"
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-skip">
          {error}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Link2 aria-hidden="true" />}
          Create link
        </Button>
      </DialogFooter>
    </form>
  );
}
