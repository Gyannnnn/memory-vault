export type Decision = 'approved' | 'skipped' | null;

export interface Group {
  key: string;
  label: string;
  hint: string;
  count: number;
  bytes: number;
  approved: number;
  skipped: number;
  keptElsewhere: number;
}

export interface Summary {
  sources: { id: string; kind: string; root: string }[];
  groups: Group[];
  total: number;
  decided: number;
}

export interface Item {
  id: string;
  sourceId: string;
  path: string;
  name: string;
  kind: string | null;
  size: number | null;
  modifiedAt: string | null;
  decision: Decision;
  keptElsewhere: boolean;
  preview: 'image' | 'video' | 'none';
  junkScore: number | null;
  junkLabel: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export const api = {
  summary: () => request<Summary>('/api/summary'),
  items: (group: string) =>
    request<{ items: Item[] }>(`/api/items?group=${encodeURIComponent(group)}`).then((body) => body.items),
  decide: (ids: string[], decision: Decision) =>
    request<{ changed: number }>('/api/decisions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids, decision }),
    }),
  previewUrl: (id: string) => `/api/preview/${id}`,
  originalUrl: (id: string) => `/api/original/${id}`,
};
