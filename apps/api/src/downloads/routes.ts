import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import { createDownloadRequest } from '@memory-vault/shared';
import type { AppContext } from '../context';
import { audit } from '../auth/audit';
import { authOf, requestMeta } from '../http/auth-middleware';
import { parse } from '../http/errors';
import { contentDisposition, DownloadService } from './service';

export function downloadRoutes(ctx: AppContext): Router {
  const router = Router();
  const downloads = new DownloadService(ctx);

  router.post('/', async (request, response) => {
    const { userId } = authOf(request);
    const body = parse(createDownloadRequest, request.body);
    const summary = await downloads.create(userId, body);
    await audit(ctx.db, {
      userId,
      type: 'download.zip',
      meta: requestMeta(request),
      metadata: {
        of: 'albumId' in body ? 'album' : 'folderId' in body ? 'folder' : 'selection',
        name: summary.fileName,
        files: summary.fileCount,
        bytes: summary.totalBytes,
      },
    });
    response.status(201).json(summary);
  });

  router.get('/:id', async (request, response) => {
    const { fileName, plan, stream } = await downloads.open(authOf(request).userId, request.params.id);
    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(plan.totalSize),
      'content-disposition': contentDisposition(fileName),
      'cache-control': 'no-store',
    });
    try {
      await pipeline(Readable.from(stream()), response);
    } catch (error) {
      // Headers are gone already: cut the connection so the browser reports a failed
      // download instead of saving a broken zip.
      ctx.logger.warn({ err: error, files: plan.entries.length }, 'zip download stopped');
      response.destroy();
    }
  });

  return router;
}
