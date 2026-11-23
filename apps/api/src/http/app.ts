import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { authRoutes } from '../auth/routes';
import type { AppContext } from '../context';
import { libraryRoutes } from '../library/routes';
import { uploadRoutes } from '../uploads/routes';
import { authOf, requireAuth } from './auth-middleware';
import { errorHandler, notFound } from './errors';

export function createApp(ctx: AppContext): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(helmet());
  app.use(pinoHttp({ logger: ctx.logger, autoLogging: ctx.env.NODE_ENV !== 'test' }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_request, response) => {
    response.json({ ok: true });
  });

  app.use('/v1/auth', authRoutes(ctx));

  const signedIn = requireAuth(ctx);
  app.get('/v1/me', signedIn, async (request, response) => {
    const user = await ctx.db.user.findUniqueOrThrow({ where: { id: authOf(request).userId } });
    response.json({
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      storageQuotaBytes: user.storageQuotaBytes.toString(),
      storageUsedBytes: user.storageUsedBytes.toString(),
    });
  });
  app.use('/v1/uploads', signedIn, uploadRoutes(ctx));
  app.use('/v1', signedIn, libraryRoutes(ctx));

  app.use((_request, _response, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
