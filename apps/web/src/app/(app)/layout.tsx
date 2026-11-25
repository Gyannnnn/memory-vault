import type { MeResponse } from '@memory-vault/shared';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { AppShell } from '@/components/shell/app-shell';
import { parseSidebar, SIDEBAR } from '@/components/shell/sidebar-state';
import { serverApi } from '@/lib/server/api';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await serverApi<MeResponse>('/auth/me');
  const sidebar = parseSidebar((await cookies()).get(SIDEBAR.cookie)?.value);
  return (
    <AppShell user={{ displayName: me.displayName, email: me.email }} sidebar={sidebar}>
      {children}
    </AppShell>
  );
}
