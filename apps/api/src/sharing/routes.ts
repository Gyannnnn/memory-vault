import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  createShareRequest,
  sharedDownloadRequest,
  sharedPageQuery,
  shareListQuery,
  unlockShareRequest,
} from '@memory-vault/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import type { AppContext } from '../context';
import { contentDisposition } from '../downloads/service';
import { authOf, requestMeta } from '../http/auth-middleware';
import { notFound, parse } from '../http/errors';
import { PLAYLIST_TYPE } from '../library/streams';
import { ShareService } from './shares';

/** The owner's links: make, list, revoke. Mounted behind sign-in. */
export function shareRoutes(ctx: AppContext): Router {
  const router = Router();
  const shares = new ShareService(ctx);

  router.post('/', async (request, response) => {
    const input = parse(createShareRequest, request.body);
    response.status(201).json(await shares.create(authOf(request).userId, input, requestMeta(request)));
  });

  router.get('/', async (request, response) => {
    const { targetId } = parse(shareListQuery, request.query);
    response.json({ items: await shares.list(authOf(request).userId, { targetId }) });
  });

  router.delete('/:id', async (request, response) => {
    await shares.revoke(authOf(request).userId, parse(z.uuid(), request.params.id), requestMeta(request));
    response.status(204).end();
  });

  return router;
}

/** What anyone with a link can reach. No sign-in; the token (and its password session) decide. */
export function publicShareRoutes(ctx: AppContext): Router {
  const router = Router();
  const shares = new ShareService(ctx);
  const session = (request: Request) => request.get('x-share-session') ?? undefined;
  const token = (request: Request) => String(request.params.token);

  router.use((_request, response, next) => {
    response.set('cache-control', 'no-store');
    response.set('x-robots-tag', 'noindex, nofollow');
    next();
  });

  router.get('/:token', async (request, response) => {
    response.json(await shares.summary(token(request), session(request), requestMeta(request)));
  });

  router.post('/:token/unlock', async (request, response) => {
    const { password } = parse(unlockShareRequest, request.body);
    response.json(await shares.unlock(token(request), password, requestMeta(request)));
  });

  router.get('/:token/items', async (request, response) => {
    const query = parse(sharedPageQuery, request.query);
    response.json(await shares.page(token(request), session(request), query, requestMeta(request)));
  });

  router.get('/:token/assets/:id', async (request, response) => {
    const assetId = parse(z.uuid(), request.params.id);
    response.json(await shares.asset(token(request), session(request), assetId, requestMeta(request)));
  });

  router.get('/:token/assets/:id/stream.m3u8', async (request, response) => {
    const assetId = parse(z.uuid(), request.params.id);
    const playlist = await shares.streamMaster(
      token(request),
      session(request),
      assetId,
      requestMeta(request),
    );
    if (!playlist) throw notFound('No streaming version');
    response.type(PLAYLIST_TYPE).send(playlist);
  });

  router.get('/:token/assets/:id/stream/:quality.m3u8', async (request, response) => {
    const assetId = parse(z.uuid(), request.params.id);
    const quality = parse(z.coerce.number().int().min(16).max(4320), request.params.quality);
    const playlist = await shares.streamMedia(
      token(request),
      session(request),
      assetId,
      quality,
      requestMeta(request),
    );
    if (!playlist) throw notFound('No such streaming version');
    response.type(PLAYLIST_TYPE).send(playlist);
  });

  router.post('/:token/downloads', async (request, response) => {
    const { assetIds } = parse(sharedDownloadRequest, request.body ?? {});
    response
      .status(201)
      .json(await shares.createDownload(token(request), session(request), assetIds, requestMeta(request)));
  });

  router.get('/:token/downloads/:id', async (request, response) => {
    const { fileName, plan, stream } = await shares.openDownload(
      token(request),
      session(request),
      String(request.params.id),
      requestMeta(request),
    );
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(plan.totalSize),
      'content-disposition': contentDisposition(fileName),
      'cache-control': 'no-store',
    });
    try {
      await pipeline(Readable.from(stream()), response);
    } catch (error) {
      ctx.logger.warn({ err: error, files: plan.entries.length }, 'shared zip download stopped');
      response.destroy();
    }
  });

  return router;
}
