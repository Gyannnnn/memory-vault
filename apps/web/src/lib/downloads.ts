import type { CreateDownloadRequest, DownloadSummary } from '@memory-vault/shared';
import { api } from './api';

/**
 * Prepares a zip on the API (it checks the files and works out the exact size), then lets
 * the browser fetch it: the download shows in the browser's own list with real progress.
 */
export async function startDownload(request: CreateDownloadRequest): Promise<DownloadSummary> {
  const summary = await api<DownloadSummary>('/downloads', { method: 'POST', body: request });
  const link = document.createElement('a');
  link.href = `/api/v1/downloads/${summary.id}`;
  link.download = summary.fileName;
  document.body.append(link);
  link.click();
  link.remove();
  return summary;
}
