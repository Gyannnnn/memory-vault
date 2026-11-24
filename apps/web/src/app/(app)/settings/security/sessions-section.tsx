'use client';

import type { SessionSummary } from '@memory-vault/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Monitor, Smartphone, SquareTerminal } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { api, errorMessage } from '@/lib/api';
import { formatDate, formatRelative } from '@/lib/format';
import { LoadError, Row, Rows, RowsLoading, Section } from './section';

const methodLabels: Record<string, string> = {
  'password+totp': 'Password and code',
  passkey: 'Passkey',
  'recovery-code': 'Recovery code',
};

function DeviceIcon({ name }: { name: string }) {
  const Icon = /\bCLI\b/.test(name) ? SquareTerminal : /Android|iOS/.test(name) ? Smartphone : Monitor;
  return <Icon className="size-4" aria-hidden="true" />;
}

export function SessionsSection() {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ['sessions'],
    queryFn: async () => (await api<{ sessions: SessionSummary[] }>('/auth/sessions')).sessions,
  });
  const signOut = useMutation({
    mutationFn: (session: SessionSummary) => api(`/auth/sessions/${session.id}`, { method: 'DELETE' }),
    onSuccess: (_, session) => {
      toast.success(`Signed out ${session.deviceName}`);
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error) => toast.error(errorMessage(error)),
  });

  return (
    <Section
      title="Where you’re signed in"
      description="Browsers, phones and the vault CLI that can reach your library. Sign out anything you don’t recognise."
    >
      {sessions.isPending ? (
        <RowsLoading count={3} />
      ) : sessions.isError ? (
        <LoadError message="Couldn’t load your devices." onRetry={() => void sessions.refetch()} />
      ) : (
        <Rows>
          {sessions.data.map((session) => (
            <Row
              key={session.id}
              icon={<DeviceIcon name={session.deviceName} />}
              title={session.deviceName}
              badge={
                session.current ? (
                  <span className="rounded-full bg-info-soft px-2 py-0.5 text-xs font-medium text-info">
                    This browser
                  </span>
                ) : undefined
              }
              meta={[
                methodLabels[session.authMethod] ?? session.authMethod,
                `signed in ${formatDate(session.createdAt)}`,
                `active ${formatRelative(session.lastUsedAt)}`,
              ].join(' · ')}
              actions={
                session.current ? undefined : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => signOut.mutate(session)}
                    disabled={signOut.isPending && signOut.variables.id === session.id}
                    aria-label={`Sign out ${session.deviceName}`}
                  >
                    {signOut.isPending && signOut.variables.id === session.id && (
                      <Loader2 className="animate-spin" aria-hidden="true" />
                    )}
                    Sign out
                  </Button>
                )
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  );
}
