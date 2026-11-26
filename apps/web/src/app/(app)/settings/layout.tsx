import type { ReactNode } from 'react';
import { SettingsHeader } from './settings-tabs';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SettingsHeader />
      {children}
    </>
  );
}
