import { reviewReasonLabels, type MediaKind, type ReviewReason } from '@memory-vault/shared';
import type { FileRow } from '../manifest/manifest';

export interface ReviewGroup {
  key: string;
  label: string;
  hint: string;
  order: number;
}

const groups: Record<string, Omit<ReviewGroup, 'key'>> = {
  'whatsapp-sent': {
    label: 'WhatsApp — photos you sent',
    hint: 'Often your own photos; many are worth keeping.',
    order: 1,
  },
  'whatsapp-received': {
    label: 'WhatsApp — received photos',
    hint: 'Forwards, greetings and memes live here.',
    order: 2,
  },
  'whatsapp-video': { label: 'WhatsApp — videos', hint: 'Received and sent videos.', order: 3 },
  'whatsapp-private': {
    label: 'WhatsApp — private folder',
    hint: 'Media WhatsApp hides from the gallery.',
    order: 4,
  },
  'whatsapp-other': { label: 'WhatsApp — documents, voice notes and stickers', hint: '', order: 5 },
  telegram: { label: reviewReasonLabels.telegram, hint: '', order: 6 },
  screenshot: {
    label: reviewReasonLabels.screenshot,
    hint: 'Receipts and tickets are sometimes worth keeping.',
    order: 7,
  },
  'screen-recording': { label: reviewReasonLabels['screen-recording'], hint: '', order: 8 },
  downloads: { label: reviewReasonLabels.downloads, hint: 'Documents, forms and saved images.', order: 9 },
  'messenger-filename': { label: reviewReasonLabels['messenger-filename'], hint: '', order: 10 },
  'other-app-media': { label: reviewReasonLabels['other-app-media'], hint: '', order: 11 },
  'phone-trash': {
    label: reviewReasonLabels['phone-trash'],
    hint: 'You deleted these on the phone; it keeps them for 30 days.',
    order: 12,
  },
  'temp-file': {
    label: reviewReasonLabels['temp-file'],
    hint: 'Usually empty or broken recordings.',
    order: 13,
  },
  'thumbnail-cache': {
    label: reviewReasonLabels['thumbnail-cache'],
    hint: 'Copies the phone made itself.',
    order: 14,
  },
  'system-file': {
    label: reviewReasonLabels['system-file'],
    hint: 'Markers like .nomedia; no content.',
    order: 15,
  },
};

const mediaGroupKinds: MediaKind[] = ['photo', 'raw'];

export function groupOf(row: Pick<FileRow, 'path' | 'kind' | 'reasons'>): ReviewGroup {
  const primary: ReviewReason | undefined = row.reasons[0];
  let key: string = primary ?? 'messenger-filename';
  if (primary === 'whatsapp') {
    const lower = row.path.toLowerCase();
    if (row.reasons.includes('system-file')) key = 'system-file';
    else if (row.kind === 'video') key = 'whatsapp-video';
    else if (lower.includes('/private/')) key = 'whatsapp-private';
    else if (lower.includes('/sent/')) key = 'whatsapp-sent';
    else if (mediaGroupKinds.includes(row.kind ?? 'other')) key = 'whatsapp-received';
    else key = 'whatsapp-other';
  }
  const known = groups[key] ?? {
    label: reviewReasonLabels[primary ?? 'messenger-filename'],
    hint: '',
    order: 50,
  };
  return { key, ...known };
}
