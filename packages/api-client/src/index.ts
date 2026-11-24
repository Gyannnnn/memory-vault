import type { z } from 'zod';
import {
  checkUploadsResponse,
  completeUploadResponse,
  createUploadResponse,
  listPartsResponse,
  passwordLoginResponse,
  pendingOriginalsResponse,
  presignPartsResponse,
  processingStatusResponse,
  recordOriginsResponse,
  tokenResponse,
  verifyAssetsResponse,
  type CreateUploadRequest,
  type Origin,
  type PendingOriginalsQuery,
  type TokenResponse,
  type UploadedPart,
} from '@memory-vault/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export interface StoredTokens {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  sessionId: string;
  user: TokenResponse['user'];
}

export interface TokenStore {
  load(): StoredTokens | null;
  save(tokens: StoredTokens): void;
  clear(): void;
}

export interface ApiClientOptions {
  baseUrl: string;
  tokens: TokenStore;
  fetch?: typeof fetch;
  userAgent?: string;
}

const REFRESH_MARGIN_MS = 60_000;

export function createApiClient(options: ApiClientOptions) {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  let refreshing: Promise<StoredTokens> | null = null;

  async function send<T extends z.ZodType>(
    method: string,
    path: string,
    schema: T | null,
    body: unknown,
    accessToken?: string,
  ): Promise<z.infer<T>> {
    let response: Response;
    try {
      response = await doFetch(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
          ...(options.userAgent ? { 'user-agent': options.userAgent } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new ApiError(
        0,
        'network',
        `Could not reach ${base}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (response.status === 204) return undefined as z.infer<T>;
    const text = await response.text();
    const payload: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const error = (
        payload as { error?: { code?: string; message?: string; details?: unknown } } | undefined
      )?.error;
      throw new ApiError(
        response.status,
        error?.code ?? 'http_error',
        error?.message ?? response.statusText,
        error?.details,
      );
    }
    return schema ? schema.parse(payload) : (payload as z.infer<T>);
  }

  function remember(tokens: TokenResponse): StoredTokens {
    const stored: StoredTokens = {
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt,
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
      sessionId: tokens.sessionId,
      user: tokens.user,
    };
    options.tokens.save(stored);
    return stored;
  }

  /** One refresh at a time: refresh tokens are single-use, so parallel refreshes would revoke the session. */
  async function refresh(current: StoredTokens): Promise<StoredTokens> {
    refreshing ??= send('POST', '/v1/auth/refresh', tokenResponse, { refreshToken: current.refreshToken })
      .then(remember)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) options.tokens.clear();
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  async function accessToken(): Promise<string> {
    if (refreshing) return (await refreshing).accessToken;
    const tokens = options.tokens.load();
    if (!tokens) throw new ApiError(401, 'signed_out', 'Not signed in. Run `vault login` first.');
    if (Date.parse(tokens.accessTokenExpiresAt) - Date.now() > REFRESH_MARGIN_MS) return tokens.accessToken;
    return (await refresh(tokens)).accessToken;
  }

  async function authed<T extends z.ZodType>(method: string, path: string, schema: T | null, body?: unknown) {
    const token = await accessToken();
    try {
      return await send(method, path, schema, body, token);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      const tokens = options.tokens.load();
      if (!tokens) throw error;
      const renewed = tokens.accessToken === token ? await refresh(tokens) : tokens;
      return send(method, path, schema, body, renewed.accessToken);
    }
  }

  return {
    baseUrl: base,

    async loginWithPassword(email: string, password: string) {
      return send('POST', '/v1/auth/login/password', passwordLoginResponse, { email, password });
    },
    async loginWithTotp(mfaToken: string, code: string, deviceName: string) {
      return remember(
        await send('POST', '/v1/auth/login/totp', tokenResponse, { mfaToken, code, deviceName }),
      );
    },
    async loginWithRecoveryCode(email: string, recoveryCode: string, deviceName: string) {
      return remember(
        await send('POST', '/v1/auth/login/recovery', tokenResponse, { email, recoveryCode, deviceName }),
      );
    },
    async logout() {
      await authed('POST', '/v1/auth/logout', null);
      options.tokens.clear();
    },
    me() {
      return authed('GET', '/v1/me', null) as Promise<{
        id: string;
        email: string;
        displayName: string;
        storageQuotaBytes: string;
        storageUsedBytes: string;
      }>;
    },

    checkUploads(items: { sha256: string; size: number }[]) {
      return authed('POST', '/v1/uploads/check', checkUploadsResponse, { items });
    },
    recordOrigins(items: (Origin & { sha256: string })[]) {
      return authed('POST', '/v1/assets/origins', recordOriginsResponse, { items });
    },
    createUpload(input: CreateUploadRequest) {
      return authed('POST', '/v1/uploads', createUploadResponse, input);
    },
    presignParts(uploadId: string, parts: { partNumber: number; sha256: string }[]) {
      return authed('POST', `/v1/uploads/${uploadId}/parts`, presignPartsResponse, { parts });
    },
    listParts(uploadId: string) {
      return authed('GET', `/v1/uploads/${uploadId}/parts`, listPartsResponse);
    },
    completeUpload(uploadId: string, parts?: UploadedPart[]) {
      return authed(
        'POST',
        `/v1/uploads/${uploadId}/complete`,
        completeUploadResponse,
        parts ? { parts } : {},
      );
    },
    abortUpload(uploadId: string) {
      return authed('DELETE', `/v1/uploads/${uploadId}`, null);
    },
    verifyAssets(sha256s: string[]) {
      return authed('POST', '/v1/assets/verify', verifyAssetsResponse, { sha256s });
    },

    /** Files from `source` the worker hasn't processed yet, newest first. */
    pendingOriginals(query: PendingOriginalsQuery) {
      const params = new URLSearchParams({ source: query.source });
      if (query.cursor) params.set('cursor', query.cursor);
      if (query.limit) params.set('limit', String(query.limit));
      return authed('GET', `/v1/processing/pending?${params.toString()}`, pendingOriginalsResponse);
    },
    processingStatus(ids: string[]) {
      return authed('POST', '/v1/processing/status', processingStatusResponse, { ids });
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
