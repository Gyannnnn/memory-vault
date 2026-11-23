import { describe, expect, it } from 'vitest';
import { extensionOf, mediaKindOf } from './media-kinds';
import { formatBytes, formatDuration } from './format';
import { estimateStorageCost } from './pricing';

describe('extensionOf', () => {
  it.each([
    ['photo.JPG', 'jpg'],
    ['a/b/clip.final.MP4', 'mp4'],
    ['.nomedia', ''],
    ['.temp-20250421_222548922_20.mp4', 'mp4'],
    ['.trashed-1767225600-IMG_1.heic', 'heic'],
    ['README', ''],
    ['dir.with.dots/file', ''],
  ])('%s → %s', (path, extension) => {
    expect(extensionOf(path)).toBe(extension);
  });
});

describe('mediaKindOf', () => {
  it.each([
    ['IMG_1.heic', 'photo'],
    ['RAW_1.dng', 'raw'],
    ['clip.mp4', 'video'],
    ['note.m4a', 'audio'],
    ['form.PDF', 'document'],
    ['mystery.xyz', 'other'],
    ['.nomedia', 'other'],
  ] as const)('%s → %s', (path, kind) => {
    expect(mediaKindOf(path)).toBe(kind);
  });
});

describe('formatting', () => {
  it('formats bytes in binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(87 * 1024 ** 3)).toBe('87.0 GB');
  });

  it('formats durations', () => {
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe('3h 12m');
    expect(formatDuration(2 * 86_400 + 5 * 3600)).toBe('2d 5h');
  });
});

describe('estimateStorageCost', () => {
  it('uses ap-south-1 Intelligent-Tiering prices', () => {
    const estimate = estimateStorageCost({ bytes: 100 * 1024 ** 3, objects: 0 });
    expect(estimate.firstMonth).toBeCloseTo(2.5);
    expect(estimate.idleAfterThirtyDays).toBeCloseTo(1.38);
    expect(estimate.idleAfterNinetyDays).toBeCloseTo(0.5);
  });
});
