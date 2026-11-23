import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { hammingDistance, perceptualHash } from './phash';

function gradient(width: number, height: number, flip = false): Promise<Buffer> {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = Math.round(((flip ? width - x : x) / width) * 200 + (y / height) * 55);
      pixels.set([value, (value * 3) % 256, 255 - value], (y * width + x) * 3);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 90 })
    .toBuffer();
}

describe('perceptualHash', () => {
  it('is stable across resizing and recompression', async () => {
    const original = await gradient(800, 600);
    const smaller = await sharp(original).resize(400).jpeg({ quality: 60 }).toBuffer();
    const a = await perceptualHash(original);
    const b = await perceptualHash(smaller);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingDistance(a, b)).toBeLessThanOrEqual(6);
  });

  it('separates different images', async () => {
    const a = await perceptualHash(await gradient(800, 600));
    const b = await perceptualHash(await gradient(800, 600, true));
    expect(hammingDistance(a, b)).toBeGreaterThan(10);
  });
});
