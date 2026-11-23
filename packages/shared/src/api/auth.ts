import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(254));

export const passwordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(1024, 'Use at most 1024 characters');

export const totpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code');

export const deviceNameSchema = z.string().trim().min(1).max(100);

export const passwordLoginRequest = z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024),
});

export const passwordLoginResponse = z.object({
  mfaRequired: z.literal(true),
  mfaToken: z.string(),
});

export const totpLoginRequest = z.object({
  mfaToken: z.string().min(1),
  code: totpCodeSchema,
  deviceName: deviceNameSchema,
});

export const recoveryLoginRequest = z.object({
  email: emailSchema,
  recoveryCode: z.string().trim().min(16).max(64),
  deviceName: deviceNameSchema,
});

export const refreshRequest = z.object({ refreshToken: z.string().min(20).max(200) });

export const tokenResponse = z.object({
  accessToken: z.string(),
  accessTokenExpiresAt: z.iso.datetime(),
  refreshToken: z.string(),
  refreshTokenExpiresAt: z.iso.datetime(),
  sessionId: z.uuid(),
  user: z.object({ id: z.uuid(), email: z.string(), displayName: z.string() }),
  recoveryUsed: z.boolean().optional(),
});

export const sessionSummary = z.object({
  id: z.uuid(),
  deviceName: z.string(),
  authMethod: z.string(),
  createdAt: z.iso.datetime(),
  lastUsedAt: z.iso.datetime(),
  current: z.boolean(),
});

export const totpConfirmRequest = z.object({ code: totpCodeSchema });

export const passkeyLoginVerifyRequest = z.object({
  challengeId: z.uuid(),
  response: z.record(z.string(), z.unknown()),
  deviceName: deviceNameSchema,
});

export const passkeyRegisterVerifyRequest = z.object({
  challengeId: z.uuid(),
  response: z.record(z.string(), z.unknown()),
  nickname: z.string().trim().min(1).max(60),
});

export type PasswordLoginRequest = z.infer<typeof passwordLoginRequest>;
export type PasswordLoginResponse = z.infer<typeof passwordLoginResponse>;
export type TotpLoginRequest = z.infer<typeof totpLoginRequest>;
export type RecoveryLoginRequest = z.infer<typeof recoveryLoginRequest>;
export type TokenResponse = z.infer<typeof tokenResponse>;
export type SessionSummary = z.infer<typeof sessionSummary>;
