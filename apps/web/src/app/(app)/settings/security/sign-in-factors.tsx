'use client';

import type { MeResponse, StepUpRequest } from '@memory-vault/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  Copy,
  Download,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Smartphone,
  TriangleAlert,
} from 'lucide-react';
import QRCode from 'qrcode';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { StepUpDialog } from '@/components/step-up-dialog';
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
import { Skeleton } from '@/components/ui/skeleton';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { LoadError, Row, Rows, Section } from './section';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/auth/me') });
}

export function AuthenticatorSection() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [stepUp, setStepUp] = useState(false);
  const [enrollment, setEnrollment] = useState<{ secret: string; uri: string } | null>(null);

  return (
    <Section
      title="Authenticator app"
      description="After your password, you enter a 6-digit code from this app. Replace it if you get a new phone."
      action={
        <Button variant="outline" onClick={() => setStepUp(true)}>
          <RefreshCw aria-hidden="true" />
          Replace authenticator
        </Button>
      }
    >
      {me.isPending ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : me.isError ? (
        <LoadError message="Couldn’t load your sign-in settings." onRetry={() => void me.refetch()} />
      ) : (
        <Rows>
          <Row
            icon={<Smartphone className="size-4" aria-hidden="true" />}
            title="Authenticator app"
            badge={
              me.data.totpEnrolledAt ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-keep-soft px-2 py-0.5 text-xs font-medium text-keep">
                  <Check className="size-3" aria-hidden="true" />
                  On
                </span>
              ) : undefined
            }
            meta={me.data.totpEnrolledAt ? `Set up ${formatDate(me.data.totpEnrolledAt)}` : 'Not set up'}
          />
        </Rows>
      )}

      <StepUpDialog
        open={stepUp}
        onOpenChange={setStepUp}
        title="Confirm it’s you"
        description="Enter your password and a code from your current authenticator. Lost it? Use a recovery code instead."
        actionLabel="Continue"
        onConfirm={async (proof: StepUpRequest) => {
          setEnrollment(
            await api<{ secret: string; uri: string }>('/auth/totp/enroll', { method: 'POST', body: proof }),
          );
          setStepUp(false);
        }}
      />

      {enrollment && (
        <EnrollDialog
          enrollment={enrollment}
          onClose={() => setEnrollment(null)}
          onDone={() => {
            setEnrollment(null);
            void queryClient.invalidateQueries({ queryKey: ['me'] });
            toast.success('Authenticator replaced', {
              description: 'Codes from the old app no longer work.',
            });
          }}
        />
      )}
    </Section>
  );
}

function EnrollDialog({
  enrollment,
  onClose,
  onDone,
}: {
  enrollment: { secret: string; uri: string };
  onClose: () => void;
  onDone: () => void;
}) {
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeId = useId();
  const errorId = useId();
  const grouped = enrollment.secret.match(/.{1,4}/g)?.join(' ') ?? enrollment.secret;

  useEffect(() => {
    // Dark on white in both themes: authenticator apps scan that most reliably.
    void QRCode.toDataURL(enrollment.uri, {
      margin: 1,
      width: 400,
      color: { dark: '#0A0A0B', light: '#FFFFFF' },
    }).then(setQr);
  }, [enrollment.uri]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/totp/confirm', { method: 'POST', body: { code } });
      onDone();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={(event) => void submit(event)} noValidate>
          <DialogHeader>
            <DialogTitle>Set up your new authenticator</DialogTitle>
            <DialogDescription>
              Scan the code with the new app, then enter the 6-digit code it shows. Your old app keeps working
              until you confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-6 flex flex-col items-center gap-4">
            {qr ? (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL generated in the browser
              <img
                src={qr}
                alt="QR code for your authenticator app"
                className="size-48 rounded-md ring-1 ring-border"
              />
            ) : (
              <Skeleton className="size-48 rounded-md" />
            )}
            <div className="w-full text-center">
              <p className="text-xs text-ink-subtle">Can’t scan? Enter this key in the app:</p>
              <CopyText text={enrollment.secret} display={grouped} label="Copy key" />
            </div>
          </div>
          <div className="mt-6 space-y-2">
            <Label htmlFor={codeId}>Code from the new app</Label>
            <Input
              id={codeId}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              aria-describedby={error ? errorId : undefined}
              className="h-11 font-mono tracking-[0.3em]"
            />
            <p id={errorId} role="alert" aria-live="assertive" className="min-h-5 text-sm text-skip">
              {error}
            </p>
          </div>
          <DialogFooter className="mt-2">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || code.length !== 6}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RecoveryCodesSection() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [stepUp, setStepUp] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const left = me.data?.recoveryCodesLeft ?? 0;
  const low = me.isSuccess && left <= 3;

  return (
    <Section
      title="Recovery codes"
      description="If you lose your authenticator, a recovery code gets you in. Each one works once."
      action={
        <Button variant="outline" onClick={() => setStepUp(true)}>
          <RefreshCw aria-hidden="true" />
          Make new codes
        </Button>
      }
    >
      {me.isPending ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : me.isError ? (
        <LoadError message="Couldn’t load your sign-in settings." onRetry={() => void me.refetch()} />
      ) : (
        <Rows>
          <Row
            icon={
              low ? (
                <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
              ) : (
                <ShieldCheck className="size-4" aria-hidden="true" />
              )
            }
            title={`${left} of 10 codes left`}
            meta={
              low
                ? 'Running low. Make new codes and store them somewhere safe.'
                : 'Keep them somewhere safe and offline, such as a password manager or printed copy.'
            }
          />
        </Rows>
      )}

      <StepUpDialog
        open={stepUp}
        onOpenChange={setStepUp}
        title="Confirm it’s you"
        description="New codes replace all your current ones. Enter your password and a code from your authenticator."
        actionLabel="Make new codes"
        onConfirm={async (proof) => {
          const result = await api<{ codes: string[] }>('/auth/recovery-codes', {
            method: 'POST',
            body: proof,
          });
          setStepUp(false);
          setCodes(result.codes);
          void queryClient.invalidateQueries({ queryKey: ['me'] });
        }}
      />

      {codes && <CodesDialog codes={codes} onClose={() => setCodes(null)} />}
    </Section>
  );
}

function CodesDialog({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const text = `Memory Vault recovery codes (made ${new Date().toISOString().slice(0, 10)})\nEach code works once.\n\n${codes.join('\n')}\n`;

  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = Object.assign(document.createElement('a'), {
      href: url,
      download: 'memory-vault-recovery-codes.txt',
    });
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(event) => event.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Your new recovery codes</DialogTitle>
          <DialogDescription>
            Save them now: they won’t be shown again. Your old codes have stopped working.
          </DialogDescription>
        </DialogHeader>
        <ol className="mt-4 grid gap-x-6 gap-y-2 rounded-lg bg-surface-sunken p-4 font-mono text-[13px] whitespace-nowrap sm:grid-cols-2">
          {codes.map((code) => (
            <li key={code} className="tabular-nums">
              {code}
            </li>
          ))}
        </ol>
        <div className="mt-3 flex gap-2">
          <CopyButton text={codes.join('\n')} label="Copy all" />
          <Button variant="outline" size="sm" onClick={download}>
            <Download aria-hidden="true" />
            Download .txt
          </Button>
        </div>
        <DialogFooter className="mt-4">
          <Button onClick={onClose}>I’ve saved them</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error('Couldn’t copy. Select the text and copy it yourself.');
    }
  };
  return { copied, copy };
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <Button variant="outline" size="sm" onClick={() => void copy()}>
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      <span aria-live="polite">{copied ? 'Copied' : label}</span>
    </Button>
  );
}

function CopyText({ text, display, label }: { text: string; display: string; label: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <button
      type="button"
      onClick={() => void copy()}
      title={label}
      className="mt-1.5 inline-flex min-h-10 items-center gap-2 rounded-md px-3 font-mono text-sm break-all hover:bg-surface-sunken"
    >
      <span className="sr-only">{label}: </span>
      {display}
      {copied ? (
        <Check className="size-4 shrink-0 text-keep" aria-hidden="true" />
      ) : (
        <Copy className="size-4 shrink-0 text-ink-subtle" aria-hidden="true" />
      )}
    </button>
  );
}
