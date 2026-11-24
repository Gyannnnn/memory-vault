import { describe, expect, it } from 'vitest';
import { isHevcHeif } from './media-tools';

const ftyp = (major: string, ...compatible: string[]) => {
  const size = 16 + compatible.length * 4;
  const box = Buffer.alloc(size + 8);
  box.writeUInt32BE(size, 0);
  box.write(`ftyp${major}`, 4, 'latin1');
  compatible.forEach((brand, index) => box.write(brand, 16 + index * 4, 'latin1'));
  box.write('mdat', size + 4, 'latin1');
  return box;
};

describe('isHevcHeif', () => {
  it('spots HEIC by content, whatever the file is called', () => {
    // The header of an Instagram photo saved on the phone as IMG_…_193.jpg.
    expect(
      isHevcHeif(Buffer.from('000000186674797068656963000000006d69663168656963000000016d646174', 'hex')),
    ).toBe(true);
    expect(isHevcHeif(ftyp('mif1', 'mif1', 'heic'))).toBe(true);
    expect(isHevcHeif(ftyp('heix', 'mif1'))).toBe(true);
  });

  it('leaves JPEG, AVIF and video alone', () => {
    expect(isHevcHeif(Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'))).toBe(false);
    expect(isHevcHeif(ftyp('avif', 'mif1', 'avif', 'miaf'))).toBe(false);
    expect(isHevcHeif(ftyp('isom', 'isom', 'iso2', 'mp41'))).toBe(false);
    expect(isHevcHeif(Buffer.alloc(8))).toBe(false);
  });
});
