import { formatBytes, type ActivityEvent, type ActivityPage } from '@memory-vault/shared';
import { deviceName } from '@/lib/server/session';

export type ActivityKind = 'signin' | 'alert' | 'sharing' | 'download' | 'deletion' | 'other';

const items = (count: unknown) => {
  const n = typeof count === 'number' ? count : 0;
  return `${n.toLocaleString()} ${n === 1 ? 'item' : 'items'}`;
};
const files = (count: unknown) => {
  const n = typeof count === 'number' ? count : 0;
  return `${n.toLocaleString()} ${n === 1 ? 'file' : 'files'}`;
};
const text = (value: unknown, fallback: string) => (typeof value === 'string' && value ? value : fallback);

const METHOD: Record<string, string> = {
  'password+totp': 'password and code',
  'recovery-code': 'a recovery code',
  passkey: 'a passkey',
};
const FAILED_STEP: Record<string, string> = {
  password: 'wrong password',
  totp: 'wrong code',
  recovery: 'wrong recovery code',
  passkey: 'passkey not accepted',
  'passkey-counter': 'passkey looked copied',
};
const KIND: Record<string, string> = { photo: 'a photo', album: 'an album', folder: 'a folder' };

/** One plain sentence per event, and what kind of event it is. */
export function describe(
  event: ActivityEvent,
  links: ActivityPage['links'],
): { sentence: string; kind: ActivityKind } {
  const m = event.metadata;
  const link = typeof m.shareId === 'string' ? links[m.shareId] : undefined;
  const target = link?.title
    ? `“${link.title}”`
    : text(m.title, '')
      ? `“${text(m.title, '')}”`
      : (KIND[String(link?.kind ?? m.kind)] ?? 'something');
  switch (event.type) {
    case 'auth.login':
      return { kind: 'signin', sentence: `Signed in with ${METHOD[String(m.method)] ?? 'your account'}` };
    case 'auth.login_failed':
      return { kind: 'alert', sentence: `Sign-in failed: ${FAILED_STEP[String(m.step)] ?? 'not accepted'}` };
    case 'auth.recovery_code_used':
      return {
        kind: 'alert',
        sentence: `Used a recovery code${typeof m.remaining === 'number' ? ` (${m.remaining} left)` : ''}`,
      };
    case 'auth.refresh_reuse_detected':
      return { kind: 'alert', sentence: 'A sign-in was ended because its key was used twice' };
    case 'auth.session_revoked':
      return { kind: 'signin', sentence: 'Signed out a device' };
    case 'auth.totp_enrolled':
      return {
        kind: 'signin',
        sentence: m.replaced ? 'Replaced the authenticator app' : 'Set up the authenticator app',
      };
    case 'auth.recovery_codes_generated':
      return { kind: 'signin', sentence: 'Made new recovery codes' };
    case 'auth.passkey_added':
      return { kind: 'signin', sentence: `Added the passkey “${text(m.nickname, 'passkey')}”` };
    case 'auth.passkey_removed':
      return { kind: 'signin', sentence: 'Removed a passkey' };
    case 'user.created':
      return { kind: 'signin', sentence: 'Account created' };
    case 'asset.trashed':
      return { kind: 'deletion', sentence: `Moved ${items(m.count)} to Trash` };
    case 'asset.restored':
      return { kind: 'deletion', sentence: `Restored ${items(m.count)} from Trash` };
    case 'asset.purge_requested':
      return { kind: 'deletion', sentence: `Chose to delete ${items(m.count)} now` };
    case 'asset.purged':
      return { kind: 'deletion', sentence: `Deleted ${text(m.name, 'a file')} for good` };
    case 'share.created':
      return { kind: 'sharing', sentence: `Made a link to ${target}` };
    case 'share.revoked':
      return { kind: 'sharing', sentence: `Turned off the link to ${target}` };
    case 'share.opened':
      return { kind: 'sharing', sentence: `Someone opened your link to ${target}` };
    case 'share.unlock_failed':
      return { kind: 'alert', sentence: `Wrong password on your link to ${target}` };
    case 'share.downloaded':
      return {
        kind: 'sharing',
        sentence: `Someone downloaded ${files(m.files)} from your link to ${target}`,
      };
    case 'download.zip':
      return {
        kind: 'download',
        sentence: `Downloaded ${text(m.name, 'a zip')} (${files(m.files)}${typeof m.bytes === 'number' ? `, ${formatBytes(m.bytes)}` : ''})`,
      };
    case 'download.original':
      return { kind: 'download', sentence: `Downloaded ${text(m.name, 'an original')}` };
    case 'export.started':
      return { kind: 'download', sentence: `Started an export of ${files(m.files)}` };
    default:
      return { kind: 'other', sentence: event.type };
  }
}

/** "Chrome on Linux", or the command-line tool. */
export function deviceOf(userAgent: string | null): string | null {
  if (!userAgent) return null;
  if (userAgent.startsWith('memory-vault-cli')) return 'vault CLI';
  return deviceName(userAgent);
}
