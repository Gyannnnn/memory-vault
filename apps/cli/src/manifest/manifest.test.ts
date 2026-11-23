import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256Hex } from '@memory-vault/media';
import { describe, expect, it, vi } from 'vitest';
import { scanLocalSource } from '../commands/scan';
import { buildDryRunReport } from '../report/dry-run';
import { Manifest } from './manifest';

vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

function source() {
  const root = mkdtempSync(join(tmpdir(), 'vault-scan-'));
  mkdirSync(join(root, 'Camera'));
  mkdirSync(join(root, 'Trip'));
  mkdirSync(join(root, 'WhatsApp Images'));
  writeFileSync(join(root, 'Camera/a.jpg'), 'photo-a');
  writeFileSync(join(root, 'Trip/a.jpg'), 'photo-a');
  writeFileSync(join(root, 'Camera/b.mp4'), 'video-b');
  writeFileSync(join(root, 'WhatsApp Images/IMG-20240101-WA0001.jpg'), 'forward');
  writeFileSync(join(root, 'WhatsApp Images/IMG-20240101-WA0002.jpg'), 'photo-a');
  return root;
}

describe('scan + manifest', () => {
  it('hashes every file once and re-hashes only files that changed', async () => {
    const root = source();
    const manifest = new Manifest(':memory:');
    const first = await scanLocalSource(manifest, 'laptop:test', root);
    expect(first).toMatchObject({ entries: 5, hashed: 5, hashErrors: 0, interrupted: false });
    expect(manifest.files('laptop:test').find((file) => file.path === 'Camera/a.jpg')?.sha256).toBe(
      sha256Hex('photo-a'),
    );

    const second = await scanLocalSource(manifest, 'laptop:test', root);
    expect(second.hashed).toBe(0);

    writeFileSync(join(root, 'Camera/b.mp4'), 'video-b-edited');
    utimesSync(join(root, 'Camera/b.mp4'), new Date(), new Date(Date.now() + 5000));
    const third = await scanLocalSource(manifest, 'laptop:test', root);
    expect(third.hashed).toBe(1);
    expect(manifest.files('laptop:test').find((file) => file.path === 'Camera/b.mp4')?.sha256).toBe(
      sha256Hex('video-b-edited'),
    );
  });

  it('refuses to reuse a source id for a different folder', async () => {
    const manifest = new Manifest(':memory:');
    await scanLocalSource(manifest, 'laptop:test', source());
    await expect(scanLocalSource(manifest, 'laptop:test', source())).rejects.toThrow(/already registered/);
  });

  it('accounts for every file and routes content that also lives in a normal folder directly', async () => {
    const manifest = new Manifest(':memory:');
    await scanLocalSource(manifest, 'laptop:test', source());
    const report = buildDryRunReport(manifest, ['laptop:test']);
    expect(report.combined.found.files).toBe(5);
    expect(report.combined.uniqueContent.files).toBe(3);
    expect(report.combined.duplicateCopies.files).toBe(2);
    expect(report.combined.uploadDirectly.files).toBe(2);
    expect(report.combined.awaitingReview.files).toBe(1);
    expect(report.sources[0]!.review.files).toBe(2);
    expect(report.reviewPaths['laptop:test']!.map((entry) => entry.path)).toEqual([
      'WhatsApp Images/IMG-20240101-WA0001.jpg',
      'WhatsApp Images/IMG-20240101-WA0002.jpg',
    ]);
  });
});
