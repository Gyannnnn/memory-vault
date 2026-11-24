'use client';

import type { StepUpRequest } from '@memory-vault/shared';
import { Loader2 } from 'lucide-react';
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
import { errorMessage } from '@/lib/api';

/**
 * Asks again for the password and a second factor before a sensitive change.
 * `onConfirm` receives the proof and runs the change; its errors are shown in the dialog.
 */
export function StepUpDialog({
  open,
  onOpenChange,
  title,
  description,
  actionLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  actionLabel: string;
  onConfirm: (proof: StepUpRequest) => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  const ids = { password: useId(), code: useId() };

  const reset = () => {
    setPassword('');
    setCode('');
    setRecoveryCode('');
    setUseRecovery(false);
    setError(null);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(useRecovery ? { password, recoveryCode } : { password, code });
      reset();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="mt-6 space-y-5">
            <div className="space-y-2">
              <Label htmlFor={ids.password}>Password</Label>
              <Input
                id={ids.password}
                type="password"
                autoComplete="current-password"
                autoFocus
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={error ? errorId : undefined}
                className="h-11"
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <Label htmlFor={ids.code}>{useRecovery ? 'Recovery code' : 'Authenticator code'}</Label>
                <button
                  type="button"
                  className="rounded-sm text-xs font-medium text-ink-muted underline-offset-4 hover:text-ink hover:underline"
                  onClick={() => {
                    setUseRecovery(!useRecovery);
                    setError(null);
                  }}
                >
                  {useRecovery ? 'Use my authenticator' : 'Lost your authenticator?'}
                </button>
              </div>
              {useRecovery ? (
                <Input
                  id={ids.code}
                  autoComplete="off"
                  spellCheck={false}
                  required
                  value={recoveryCode}
                  onChange={(event) => setRecoveryCode(event.target.value)}
                  aria-describedby={error ? errorId : undefined}
                  className="h-11 font-mono"
                />
              ) : (
                <Input
                  id={ids.code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
                  aria-describedby={error ? errorId : undefined}
                  className="h-11 font-mono tracking-[0.3em]"
                />
              )}
              {useRecovery && <p className="text-xs text-ink-subtle">The code will be used up.</p>}
            </div>
            <p id={errorId} role="alert" aria-live="assertive" className="min-h-5 text-sm text-skip">
              {error}
            </p>
          </div>
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || !password || (useRecovery ? !recoveryCode : code.length !== 6)}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              {actionLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
