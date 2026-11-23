import type { ErrorRequestHandler } from 'express';
import { ZodError, type z } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Not allowed') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message);
export const conflict = (message: string, details?: unknown) =>
  new HttpError(409, 'conflict', message, details);
export const tooManyRequests = (retryAfterSeconds: number) =>
  new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.', { retryAfterSeconds });

export function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw badRequest(
      'Invalid request',
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }
  return result.data;
}

export const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  if (error instanceof HttpError) {
    if (error.status === 429) {
      const retry = (error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
      if (retry) response.setHeader('Retry-After', String(retry));
    }
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }
  if (error instanceof ZodError) {
    response.status(400).json({ error: { code: 'bad_request', message: 'Invalid request' } });
    return;
  }
  const status = (error as { status?: number; type?: string }).status;
  if (status === 400 || status === 413) {
    response
      .status(status)
      .json({ error: { code: 'bad_request', message: 'Malformed or oversized request' } });
    return;
  }
  request.log?.error({ err: error }, 'unhandled error');
  response.status(500).json({ error: { code: 'internal', message: 'Something went wrong' } });
};
