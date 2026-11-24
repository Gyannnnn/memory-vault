import type { Metadata } from 'next';
import { Brand } from '@/components/brand';
import { SignInForm } from './sign-in-form';

export const metadata: Metadata = { title: 'Sign in' };

/** Only same-site paths are allowed as a destination after signing in. */
function safeNext(value: string | string[] | undefined): string {
  const next = Array.isArray(value) ? value[0] : value;
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNext((await searchParams).next);
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-12">
      <div className="w-full max-w-[380px]">
        <Brand className="mb-10" />
        <SignInForm next={next} />
        <p className="mt-10 text-xs leading-relaxed text-ink-subtle">
          Your library is private. Only you can sign in, and every sign-in needs a second step.
        </p>
      </div>
    </main>
  );
}
