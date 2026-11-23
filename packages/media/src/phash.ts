import sharp from 'sharp';

const SIZE = 32;
const LOW = 8;

const cosines = Array.from({ length: SIZE }, (_, k) =>
  Array.from({ length: SIZE }, (_, n) => Math.cos(((2 * n + 1) * k * Math.PI) / (2 * SIZE))),
);

/**
 * 64-bit perceptual hash (DCT of a 32×32 greyscale image, low 8×8 frequencies
 * against their median). Visually similar images have a small Hamming distance.
 */
export async function perceptualHash(input: Buffer | string): Promise<string> {
  const pixels = await sharp(input, { failOn: 'none' })
    .rotate()
    .greyscale()
    .resize(SIZE, SIZE, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();

  const rows: number[][] = [];
  for (let y = 0; y < SIZE; y += 1) {
    rows.push(
      Array.from({ length: LOW }, (_, u) => {
        let sum = 0;
        for (let x = 0; x < SIZE; x += 1) sum += pixels[y * SIZE + x]! * cosines[u]![x]!;
        return sum;
      }),
    );
  }
  const coefficients: number[] = [];
  for (let v = 0; v < LOW; v += 1) {
    for (let u = 0; u < LOW; u += 1) {
      let sum = 0;
      for (let y = 0; y < SIZE; y += 1) sum += rows[y]![u]! * cosines[v]![y]!;
      coefficients.push(sum);
    }
  }
  const sorted = coefficients.slice(1).sort((a, b) => a - b);
  const median = (sorted[31]! + sorted[32]!) / 2;
  let bits = 0n;
  for (const value of coefficients) bits = (bits << 1n) | (value > median ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

export function hammingDistance(a: string, b: string): number {
  let difference = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (difference > 0n) {
    count += Number(difference & 1n);
    difference >>= 1n;
  }
  return count;
}
