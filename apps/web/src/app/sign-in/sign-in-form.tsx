'use client';

import { startAuthentication, WebAuthnError } from '@simplewebauthn/browser';
import { ArrowLeft, KeyRound, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authStep, errorMessage } from '@/lib/api';

type Step = 'password' | 'totp' | 'recovery';

interface SessionStarted {
  user: { displayName: string };
  recoveryUsed: boolean;
}

export function SignInForm({ next }: { next: string }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [code, setCode] = useState('');
  const [recoveryCode, setRecoveryCode] = useState('');
  const [busy, setBusy] = useState<'form' | 'passkey' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  const finish = (session: SessionStarted) => {
    if (session.recoveryUsed) {
      toast.warning('You used a recovery code', {
        description: 'It no longer works. Generate fresh codes in Settings › Security.',
        duration: 10_000,
      });
    }
    router.replace(next);
    router.refresh();
  };

  const run = async (kind: 'form' | 'passkey', action: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(
        caught instanceof WebAuthnError && caught.name === 'NotAllowedError' ? null : errorMessage(caught),
      );
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run('form', async () => {
      if (step === 'password') {
        const { mfaToken: token } = await authStep<{ mfaToken: string }>('password', { email, password });
        setMfaToken(token);
        setPassword('');
        setStep('totp');
      } else if (step === 'totp') {
        finish(await authStep<SessionStarted>('totp', { mfaToken, code }));
      } else {
        finish(await authStep<SessionStarted>('recovery', { email, recoveryCode }));
      }
    });
  };

  const signInWithPasskey = () =>
    run('passkey', async () => {
      const { challengeId, options } = await authStep<{
        challengeId: string;
        options: Parameters<typeof startAuthentication>[0]['optionsJSON'];
      }>('passkey-options');
      const response = await startAuthentication({ optionsJSON: options });
      finish(await authStep<SessionStarted>('passkey-verify', { challengeId, response }));
    });

  const goTo = (target: Step) => {
    setError(null);
    setCode('');
    setRecoveryCode('');
    setStep(target);
  };

  const describedBy = error ? errorId : undefined;

  return (
    <div>
      <h1 className="text-2xl font-medium tracking-display">
        {step === 'password' ? 'Sign in' : step === 'totp' ? 'Enter your code' : 'Use a recovery code'}
      </h1>
      <p className="mt-1.5 text-sm text-ink-muted">
        {step === 'password'
          ? 'Use your email and password, or a passkey.'
          : step === 'totp'
            ? 'Open your authenticator app and enter the 6-digit code for Memory Vault.'
            : 'Each recovery code works once. You can make new ones after signing in.'}
      </p>

      <form onSubmit={submit} className="mt-8 space-y-5" noValidate>
        {step === 'password' && (
          <>
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={Boolean(error)}
                className="h-11"
              />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={Boolean(error)}
                className="h-11"
              />
            </Field>
          </>
        )}

        {step === 'totp' && (
          <Field label="Authenticator code" htmlFor="code">
            <Input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]*"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
              aria-describedby={describedBy}
              aria-invalid={Boolean(error)}
              className="h-12 font-mono text-lg tracking-[0.4em]"
            />
          </Field>
        )}

        {step === 'recovery' && (
          <>
            <Field label="Email" htmlFor="recovery-email">
              <Input
                id="recovery-email"
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="h-11"
              />
            </Field>
            <Field label="Recovery code" htmlFor="recovery-code">
              <Input
                id="recovery-code"
                autoComplete="off"
                spellCheck={false}
                required
                autoFocus
                value={recoveryCode}
                onChange={(event) => setRecoveryCode(event.target.value)}
                aria-describedby={describedBy}
                aria-invalid={Boolean(error)}
                className="h-11 font-mono"
              />
            </Field>
          </>
        )}

        <p id={errorId} role="alert" aria-live="assertive" className="min-h-5 text-sm text-skip">
          {error}
        </p>

        <Button type="submit" size="lg" className="h-11 w-full" disabled={busy !== null}>
          {busy === 'form' && <Loader2 className="animate-spin" aria-hidden="true" />}
          {step === 'password' ? 'Continue' : 'Sign in'}
        </Button>
      </form>

      {step === 'password' ? (
        <>
          <div className="my-6 flex items-center gap-3 text-xs text-ink-subtle" aria-hidden="true">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="h-11 w-full"
            onClick={() => void signInWithPasskey()}
            disabled={busy !== null}
          >
            {busy === 'passkey' ? (
              <Loader2 className="animate-spin" aria-hidden="true" />
            ) : (
              <KeyRound aria-hidden="true" />
            )}
            Sign in with a passkey
          </Button>
        </>
      ) : (
        <div className="mt-6 flex items-center justify-between gap-4 text-sm">
          <button
            type="button"
            onClick={() => goTo('password')}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-sm text-ink-muted hover:text-ink"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Start again
          </button>
          <button
            type="button"
            onClick={() => goTo(step === 'totp' ? 'recovery' : 'totp')}
            className="min-h-11 rounded-sm font-medium underline-offset-4 hover:underline"
            disabled={step === 'recovery' && !mfaToken}
            hidden={step === 'recovery' && !mfaToken}
          >
            {step === 'totp' ? 'Use a recovery code' : 'Use my authenticator'}
          </button>
        </div>
      )}
    </div>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}
