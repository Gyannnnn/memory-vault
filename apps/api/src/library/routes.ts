import { Router } from 'express';
import { z } from 'zod';
import { recordOriginsRequest, verifyAssetsRequest } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { withUser } from '../db';
import { authOf } from '../http/auth-middleware';
import { parse } from '../http/errors';
import { UploadService } from '../uploads/service';

const listAssetsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.uuid().optional(),
});

export function libraryRoutes(ctx: AppContext): Router {
  const router = Router();
  const uploads = new UploadService(ctx);

  router.post('/assets/origins', async (request, response) => {
    const { items } = parse(recordOriginsRequest, request.body);
    response.json(await uploads.recordOrigins(authOf(request).userId, items));
  });

  router.post('/assets/verify', async (request, response) => {
    const { sha256s } = parse(verifyAssetsRequest, request.body);
    response.json({ results: await uploads.verify(authOf(request).userId, sha256s) });
  });

  router.get('/assets', async (request, response) => {
    const { limit, cursor } = parse(listAssetsQuery, request.query);
    const { userId } = authOf(request);
    const assets = await withUser(ctx.db, userId, (tx) =>
      tx.asset.findMany({
        where: { userId, status: 'verified', deletedAt: null },
        orderBy: { id: 'desc' },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          sha256: true,
          sizeBytes: true,
          mimeType: true,
          kind: true,
          originalName: true,
          takenAt: true,
          width: true,
          height: true,
          durationMs: true,
        },
      }),
    );
    const page = assets.slice(0, limit);
    response.json({
      items: page.map((asset) => ({ ...asset, sizeBytes: asset.sizeBytes.toString() })),
      nextCursor: assets.length > limit ? page.at(-1)!.id : null,
    });
  });

  return router;
}
