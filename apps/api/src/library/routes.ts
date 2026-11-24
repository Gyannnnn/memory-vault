import { Router } from 'express';
import { z } from 'zod';
import {
  assetSearchQuery,
  onThisDayQuery,
  pendingOriginalsQuery,
  processingStatusRequest,
  recordOriginsRequest,
  timelineMonthParam,
  verifyAssetsRequest,
} from '@memory-vault/shared';
import type { AppContext } from '../context';
import { authOf } from '../http/auth-middleware';
import { parse } from '../http/errors';
import { UploadService } from '../uploads/service';
import { BrowseService } from './browse';
import { ProcessingService } from './processing';

const folderQuery = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export function libraryRoutes(ctx: AppContext): Router {
  const router = Router();
  const uploads = new UploadService(ctx);
  const browse = new BrowseService(ctx);
  const processing = new ProcessingService(ctx);

  router.post('/assets/origins', async (request, response) => {
    const { items } = parse(recordOriginsRequest, request.body);
    response.json(await uploads.recordOrigins(authOf(request).userId, items));
  });

  router.post('/assets/verify', async (request, response) => {
    const { sha256s } = parse(verifyAssetsRequest, request.body);
    response.json({ results: await uploads.verify(authOf(request).userId, sha256s) });
  });

  router.get('/assets', async (request, response) => {
    response.json(await browse.search(authOf(request).userId, parse(assetSearchQuery, request.query)));
  });

  router.get('/assets/:id', async (request, response) => {
    response.json(await browse.detail(authOf(request).userId, parse(z.uuid(), request.params.id)));
  });

  router.get('/timeline', async (request, response) => {
    response.json(await browse.timeline(authOf(request).userId));
  });

  router.get('/timeline/:month', async (request, response) => {
    const month = parse(timelineMonthParam, request.params.month);
    response.json({ items: await browse.month(authOf(request).userId, month) });
  });

  router.get('/search/facets', async (request, response) => {
    response.json(await browse.facets(authOf(request).userId));
  });

  router.get(['/folders', '/folders/:id'], async (request, response) => {
    const id = request.params.id ? parse(z.uuid(), request.params.id) : null;
    const { cursor, limit } = parse(folderQuery, request.query);
    response.json(await browse.folder(authOf(request).userId, id, cursor, limit));
  });

  router.get('/map/points', async (request, response) => {
    response.json(await browse.mapPoints(authOf(request).userId));
  });

  router.get('/memories/on-this-day', async (request, response) => {
    const { date } = parse(onThisDayQuery, request.query);
    response.json(await browse.onThisDay(authOf(request).userId, date));
  });

  router.get('/processing/pending', async (request, response) => {
    response.json(
      await processing.pending(authOf(request).userId, parse(pendingOriginalsQuery, request.query)),
    );
  });

  router.post('/processing/status', async (request, response) => {
    const { ids } = parse(processingStatusRequest, request.body);
    response.json(await processing.status(authOf(request).userId, ids));
  });

  return router;
}
