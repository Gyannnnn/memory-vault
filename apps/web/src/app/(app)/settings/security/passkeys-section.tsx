'use client';

import type { PasskeySummary } from '@memory-vault/shared';
import { browserSupportsWebAuthn, startRegistration, WebAuthnError } from '@simplewebauthn/browser';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import { LoadError, Row, Rows, RowsLoading, Section } from './section';

const noSubscription = () => () => undefined;

type RegistrationOptions = Parameters<typeof startRegistration>[0]['optionsJSON'];

function registrationError(error: unknown): string {
  if (error instanceof WebAuthnError) {
    if (error.name === 'InvalidStateError') return 'That passkey or security key is already added.';
    if (error.name === 'NotAllowedError') return 'Cancelled. Nothing was added.';
  }
  return errorMessage(error);
}

export function PasskeysSection() {
  const queryClient = useQueryClient();
  const passkeys = useQuery({
    queryKey: ['passkeys'],
    queryFn: async () => (await api<{ passkeys: PasskeySummary[] }>('/auth/passkeys')).passkeys,
  });
  const supported = useSyncExternalStore(noSubscription, browserSupportsWebAuthn, () => true);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<PasskeySummary | null>(null);
  const [removing, setRemoving] = useState<PasskeySummary | null>(null);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['passkeys'] });
    void queryClient.invalidateQueries({ queryKey: ['me'] });
  };

  const remove = useMutation({
    mutationFn: (passkey: PasskeySummary) => api(`/auth/passkeys/${passkey.id}`, { method: 'DELETE' }),
    onSuccess: (_, passkey) => {
      toast.success(`Removed “${passkey.nickname}”`);
      setRemoving(null);
      refresh();
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Section
      title="Passkeys and security keys"
      description="Sign in with your fingerprint, face, screen lock or a YubiKey instead of a password and code."
      action={
        <Button variant="outline" onClick={() => setAdding(true)} disabled={!supported}>
          <Plus aria-hidden="true" />
          Add a passkey
        </Button>
      }
    >
      {!supported && (
        <p className="mb-4 text-sm text-warning">
          This browser can’t create passkeys. Try a recent Chrome, Safari, Edge or Firefox.
        </p>
      )}
      {passkeys.isPending ? (
        <RowsLoading />
      ) : passkeys.isError ? (
        <LoadError message="Couldn’t load your passkeys." onRetry={() => void passkeys.refetch()} />
      ) : passkeys.data.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-ink-muted">
          No passkeys yet. You sign in with your password and authenticator code.
        </div>
      ) : (
        <Rows>
          {passkeys.data.map((passkey) => (
            <Row
              key={passkey.id}
              icon={<KeyRound className="size-4" aria-hidden="true" />}
              title={passkey.nickname}
              meta={[
                passkey.backedUp ? 'Synced passkey' : 'Security key or single-device passkey',
                `added ${formatDate(passkey.createdAt)}`,
                passkey.lastUsedAt ? `last used ${formatRelative(passkey.lastUsedAt)}` : 'never used',
              ].join(' · ')}
              actions={
                <>
                  <IconAction label={`Rename ${passkey.nickname}`} onClick={() => setRenaming(passkey)}>
                    <Pencil />
                  </IconAction>
                  <IconAction label={`Remove ${passkey.nickname}`} onClick={() => setRemoving(passkey)}>
                    <Trash2 />
                  </IconAction>
                </>
              }
            />
          ))}
        </Rows>
      )}

      <NicknameDialog
        key={adding ? 'add-open' : 'add-closed'}
        open={adding}
        onOpenChange={setAdding}
        title="Add a passkey"
        description="Name it so you can tell it apart later. Your browser will then ask you to confirm with your fingerprint, face, screen lock or key."
        initial=""
        placeholder="e.g. Pixel fingerprint, YubiKey 5C"
        actionLabel="Continue"
        onSubmit={async (nickname) => {
          try {
            const { challengeId, options } = await api<{ challengeId: string; options: RegistrationOptions }>(
              '/auth/passkeys/register/options',
              { method: 'POST' },
            );
            const response = await startRegistration({ optionsJSON: options });
            await api('/auth/passkeys/register/verify', {
              method: 'POST',
              body: { challengeId, response, nickname },
            });
          } catch (error) {
            throw new Error(registrationError(error), { cause: error });
          }
          toast.success(`Added “${nickname}”`, { description: 'You can now sign in with it.' });
          setAdding(false);
          refresh();
        }}
      />

      <NicknameDialog
        key={renaming?.id ?? 'rename-closed'}
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Rename passkey"
        description="Only the name changes; the passkey keeps working."
        initial={renaming?.nickname ?? ''}
        actionLabel="Save"
        onSubmit={async (nickname) => {
          await api(`/auth/passkeys/${renaming!.id}`, { method: 'PATCH', body: { nickname } });
          setRenaming(null);
          refresh();
        }}
      />

      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove “{removing?.nickname}”?</AlertDialogTitle>
            <AlertDialogDescription>
              You won’t be able to sign in with it any more. Your password and authenticator code keep
              working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(event) => {
                event.preventDefault();
                if (removing) remove.mutate(removing);
              }}
              disabled={remove.isPending}
            >
              {remove.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

export function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={onClick}
          className="text-ink-muted hover:text-ink"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function NicknameDialog({
  open,
  onOpenChange,
  title,
  description,
  initial,
  placeholder,
  actionLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initial: string;
  placeholder?: string;
  actionLabel: string;
  onSubmit: (nickname: string) => Promise<void>;
}) {
  const [nickname, setNickname] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputId = useId();
  const errorId = useId();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit(nickname.trim());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="mt-6 space-y-2">
            <Label htmlFor={inputId}>Name</Label>
            <Input
              id={inputId}
              autoFocus
              maxLength={60}
              placeholder={placeholder}
              value={nickname}
              onChange={(event) => setNickname(event.target.value)}
              aria-describedby={error ? errorId : undefined}
              className="h-11"
            />
            <p id={errorId} role="alert" aria-live="assertive" className="min-h-5 text-sm text-skip">
              {error}
            </p>
          </div>
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || nickname.trim().length === 0}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {actionLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
