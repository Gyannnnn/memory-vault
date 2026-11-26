import { newId, type Db, type Prisma, type Tx } from '../db';

export interface RequestMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type AuditType =
  | 'auth.login'
  | 'auth.login_failed'
  | 'auth.recovery_code_used'
  | 'auth.refresh_reuse_detected'
  | 'auth.session_revoked'
  | 'auth.totp_enrolled'
  | 'auth.recovery_codes_generated'
  | 'auth.passkey_added'
  | 'auth.passkey_removed'
  | 'user.created'
  | 'asset.trashed'
  | 'asset.restored'
  | 'asset.purge_requested'
  | 'asset.purged';

export async function audit(
  db: Db | Tx,
  event: { userId?: string | null; type: AuditType; meta?: RequestMeta; metadata?: Prisma.InputJsonObject },
): Promise<void> {
  await db.auditEvent.create({
    data: {
      id: newId(),
      userId: event.userId ?? null,
      type: event.type,
      ipAddress: event.meta?.ip ?? null,
      userAgent: event.meta?.userAgent?.slice(0, 500) ?? null,
      metadata: event.metadata ?? {},
    },
  });
}
