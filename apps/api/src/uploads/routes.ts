import { Router } from 'express';
import { z } from 'zod';
import {
  checkUploadsRequest,
  completeUploadRequest,
  createUploadRequest,
  presignPartsRequest,
} from '@memory-vault/shared';
import type { AppContext } from '../context';
import { authOf } from '../http/auth-middleware';
import { parse } from '../http/errors';
import { UploadService } from './service';

export function uploadRoutes(ctx: AppContext): Router {
  const router = Router();
  const uploads = new UploadService(ctx);
  const uploadId = (value: unknown) => parse(z.uuid(), value);

  router.post('/check', async (request, response) => {
    const { items } = parse(checkUploadsRequest, request.body);
    response.json(
      await uploads.check(
        authOf(request).userId,
        items.map((item) => item.sha256),
      ),
    );
  });

  router.post('/', async (request, response) => {
    response.json(await uploads.create(authOf(request).userId, parse(createUploadRequest, request.body)));
  });

  router.post('/:id/parts', async (request, response) => {
    const { parts } = parse(presignPartsRequest, request.body);
    response.json({
      parts: await uploads.presignParts(authOf(request).userId, uploadId(request.params.id), parts),
    });
  });

  router.get('/:id/parts', async (request, response) => {
    response.json({ parts: await uploads.listParts(authOf(request).userId, uploadId(request.params.id)) });
  });

  router.post('/:id/complete', async (request, response) => {
    const { parts } = parse(completeUploadRequest, request.body ?? {});
    response.json(await uploads.complete(authOf(request).userId, uploadId(request.params.id), parts));
  });

  router.delete('/:id', async (request, response) => {
    await uploads.abort(authOf(request).userId, uploadId(request.params.id));
    response.status(204).end();
  });

  return router;
}
