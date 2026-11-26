import express, { type Express } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { ActivityService } from '../activity/activity';
import { authRoutes } from '../auth/routes';
import type { AppContext } from '../context';
import { downloadRoutes } from '../downloads/routes';
import { libraryRoutes } from '../library/routes';
import { publicShareRoutes, shareRoutes } from '../sharing/routes';
import { uploadRoutes } from '../uploads/routes';
import { authOf, requireAuth } from './auth-middleware';
import { activityQuery } from '@memory-vault/shared';
import { errorHandler, notFound, parse } from './errors';

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
  // Share links: no sign-in, before the signed-in /v1 routes below.
  app.use('/v1/public/shares', publicShareRoutes(ctx));

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
  app.use('/v1/downloads', signedIn, downloadRoutes(ctx));
  app.use('/v1/shares', signedIn, shareRoutes(ctx));
  const activity = new ActivityService(ctx);
  app.get('/v1/activity', signedIn, async (request, response) => {
    const { group, cursor, limit } = parse(activityQuery, request.query);
    response.json(await activity.page(authOf(request).userId, group, cursor, limit));
  });
  app.use('/v1', signedIn, libraryRoutes(ctx));

  app.use((_request, _response, next) => next(notFound()));
  app.use(errorHandler);
  return app;
}
