import { describe, expect, it } from 'vitest';
import { classifyPath } from './rules';

describe('classifyPath', () => {
  it.each([
    's21 fe camera/Camera/20240901_173002.mp4',
    's21 fe camera/Camera/Cshot/2024/IMG_0001.jpg',
    'Koraput 3rd year/IMG_20240428_175439.jpg',
    'Koraput 3rd year/IMG-20240319-WA0021.jpg',
    'DCIM/Camera/20250101_101010.heic',
    'Pictures/Edited/photo.jpg',
    'Documents/Invoice 2026.pdf',
    'Notes_260627_145835.jpg',
    'Mov/clip.mp4',
  ])('uploads %s directly', (path) => {
    expect(classifyPath(path)).toEqual({ route: 'direct', reasons: [] });
  });

  it.each([
    ['WhatsApp Images/IMG-20240319-WA0021.jpg', ['whatsapp']],
    ['WhatsApp Images/Sent/IMG-20240319-WA0022.jpg', ['whatsapp']],
    ['WhatsApp Images/Private/.nomedia', ['whatsapp', 'system-file']],
    ['WhatsApp Video 2026-01-25 at 6.12.09 PM (1).mp4', ['messenger-filename']],
    ['Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/IMG-20250101-WA0001.jpg', ['whatsapp']],
    ['Android/media/org.telegram.messenger/Telegram/Telegram Images/123_456.jpg', ['telegram']],
    ['Android/media/com.instagram.android/Instagram/reel.mp4', ['other-app-media']],
    ['DCIM/Screenshots/Screenshot_20250101_101010_Chrome.jpg', ['screenshot']],
    ['Pictures/Screenshot_20250101_101010.png', ['screenshot']],
    ['DCIM/Screen recordings/Screen_Recording_20250101.mp4', ['screen-recording']],
    ['Download/download (1).jpg', ['downloads']],
    ['DCIM/Camera/IMG-20240319-WA0021.jpg', ['messenger-filename']],
    ['DCIM/Camera/.trashed-1767225600-20251201_101010.jpg', ['phone-trash']],
    ['Android/.Trash/com.sec.android.gallery3d/1700000000000/IMG_1.jpg', ['phone-trash']],
    ['s21 fe camera/Camera/.temp-20250421_222548922_20.mp4', ['temp-file']],
    ['DCIM/Camera/.pending-1767225600-20251201_101010.mp4', ['temp-file']],
    ['DCIM/.thumbnails/1234.jpg', ['thumbnail-cache']],
    ['DCIM/.thumbnails/.thumbdata4--1967290299', ['system-file', 'thumbnail-cache']],
  ])('sends %s to review', (path, reasons) => {
    expect(classifyPath(path)).toEqual({ route: 'review', reasons });
  });
});
