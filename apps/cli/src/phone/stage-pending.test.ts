import { describe, expect, it } from 'vitest';
import type { PendingOriginal } from '@memory-vault/shared';
import { fitsWindow, pullFailure, stagingOrder, stagingPath } from './stage-pending';

const item = (assetId: string, kind: PendingOriginal['kind'], localAt: string): PendingOriginal => ({
  assetId,
  kind,
  localAt,
  sizeBytes: 1,
  sha256: '0'.repeat(64),
  paths: [`DCIM/${assetId}`],
});

describe('stage-pending', () => {
  it('stages in the order the worker runs: non-videos newest first, then videos newest first', () => {
    const ordered = stagingOrder([
      item('old-photo', 'photo', '2024-01-01T00:00:00.000'),
      item('new-video', 'video', '2026-11-22T10:00:00.000'),
      item('new-photo', 'photo', '2026-11-22T09:24:44.000'),
      item('old-video', 'video', '2023-05-01T00:00:00.000'),
      item('file', 'other', '2025-01-01T00:00:00.000'),
    ]);
    expect(ordered.map((entry) => entry.assetId)).toEqual([
      'new-photo',
      'file',
      'old-photo',
      'new-video',
      'old-video',
    ]);
  });

  it('keeps staged copies within the window, but always lets one file through', () => {
    const gb = 1024 ** 3;
    expect(fitsWindow(0, 10 * gb, 4 * gb)).toBe(true);
    expect(fitsWindow(3 * gb, gb, 4 * gb)).toBe(true);
    expect(fitsWindow(3 * gb, gb + 1, 4 * gb)).toBe(false);
  });

  it('never stages outside the staging folder', () => {
    const root = '/home/me/vault-staging/phone-s21fe';
    expect(stagingPath(root, 'DCIM/Camera/a b.jpg')).toBe(`${root}/DCIM/Camera/a b.jpg`);
    expect(stagingPath(root, "WhatsApp/it's.jpg")).toBe(`${root}/WhatsApp/it's.jpg`);
    expect(stagingPath(root, '../laptop-s21fe/x.jpg')).toBeNull();
    expect(stagingPath(root, 'DCIM/../../x.jpg')).toBeNull();
    expect(stagingPath(root, '/etc/passwd')).toBeNull();
    expect(stagingPath(root, '')).toBeNull();
    expect(stagingPath(root, '.')).toBeNull();
    expect(stagingPath(root, 'a\0b')).toBeNull();
  });

  it('tells a missing file apart from a phone that went away', () => {
    expect(
      pullFailure(
        "adb: error: failed to stat remote object '/storage/emulated/0/DCIM/a.jpg': No such file or directory",
      ),
    ).toBe('missing');
    // Unplugged mid-run (the message seen on 2026-11-24), and other "phone not ready" states.
    expect(pullFailure("adb: error: failed to get feature set: device 'RZCX30G3QLK' not found")).toBe(
      'phone',
    );
    expect(pullFailure('adb: no devices/emulators found')).toBe('phone');
    expect(pullFailure('adb: device offline')).toBe('phone');
    expect(pullFailure('adb: device unauthorized.')).toBe('phone');
    expect(pullFailure('adb: error: closed')).toBe('phone');
    expect(pullFailure('adb: error: cannot create file/directory: Permission denied')).toBe('other');
  });
});
