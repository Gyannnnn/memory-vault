import type { MeResponse } from '@memory-vault/shared';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { serverApi } from '@/lib/server/api';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await serverApi<MeResponse>('/auth/me');
  return <AppShell user={{ displayName: me.displayName, email: me.email }}>{children}</AppShell>;
}
