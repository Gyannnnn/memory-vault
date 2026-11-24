'use client';

import { PasskeysSection } from './passkeys-section';
import { SessionsSection } from './sessions-section';
import { AuthenticatorSection, RecoveryCodesSection } from './sign-in-factors';

export function SecuritySettings() {
  return (
    <div>
      <PasskeysSection />
      <AuthenticatorSection />
      <RecoveryCodesSection />
      <SessionsSection />
    </div>
  );
}
