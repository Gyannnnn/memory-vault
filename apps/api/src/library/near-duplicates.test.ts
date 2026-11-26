import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { findGroups, hammingDistance, pairKey, type HashedItem } from './near-duplicates';

const hex = (value: bigint) => value.toString(16).padStart(16, '0');
const flip = (hash: string, bits: number[]) =>
  hex(bits.reduce((value, bit) => value ^ (1n << BigInt(bit)), BigInt(`0x${hash}`)));
const photo = (id: string, hash: string): HashedItem => ({ id, hash, kind: 'photo', durationMs: null });

describe('near-duplicate grouping', () => {
  it('measures bit differences', () => {
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('8000000000000001', '0000000000000000')).toBe(2);
  });

  it('finds every pair within 6 bits and none beyond, on random hashes', () => {
    for (let round = 0; round < 20; round += 1) {
      const items: HashedItem[] = [];
      for (let index = 0; index < 120; index += 1) {
        const base = randomBytes(8).toString('hex');
        items.push(photo(`b${round}-${index}`, base));
        // A near copy (0–8 bits off), so both sides of the line are exercised.
        const bits = [...new Set(Array.from({ length: index % 9 }, () => Math.floor(Math.random() * 64)))];
        items.push(photo(`n${round}-${index}`, flip(base, bits)));
      }
      const groups = findGroups(items);
      const hashOf = new Map(items.map((item) => [item.id, item.hash]));
      const grouped = new Set(groups.flat());
      // Every close pair is found: both end up grouped (with each other, or around a closer centre).
      for (let a = 0; a < items.length; a += 1) {
        for (let b = a + 1; b < items.length; b += 1) {
          if (hammingDistance(items[a]!.hash, items[b]!.hash) <= 6) {
            expect(grouped.has(items[a]!.id)).toBe(true);
            expect(grouped.has(items[b]!.id)).toBe(true);
          }
        }
      }
      // Every member is within 6 bits of its group's centre, and in one group only.
      for (const [centre, ...members] of groups)
        for (const id of members)
          expect(hammingDistance(hashOf.get(centre!)!, hashOf.get(id)!)).toBeLessThanOrEqual(6);
      expect(grouped.size).toBe(groups.flat().length);
    }
  });

  it('splits chains around a centre instead of grouping unrelated photos', () => {
    const start = '0000000000000000';
    // Each link 4 bits from the last: 0→1→2 is a chain, but 0 and 2 are 8 bits apart.
    const items = [
      photo('0', start),
      photo('1', flip(start, [0, 1, 2, 3])),
      photo('2', flip(start, [0, 1, 2, 3, 4, 5, 6, 7])),
    ];
    expect(findGroups(items)).toEqual([['0', '1']]);
  });

  it('keeps dismissed pairs apart, and photos apart from videos of a different length', () => {
    const base = 'f0f0f0f0f0f0f0f0';
    const items: HashedItem[] = [
      photo('a', base),
      photo('b', flip(base, [1, 2])),
      { id: 'v1', hash: base, kind: 'video', durationMs: 10_000 },
      { id: 'v2', hash: base, kind: 'video', durationMs: 10_600 },
      { id: 'v3', hash: base, kind: 'video', durationMs: 30_000 },
    ];
    expect(findGroups(items).map((group) => group.sort())).toEqual([
      ['a', 'b'],
      ['v1', 'v2'],
    ]);
    expect(findGroups(items, new Set([pairKey('a', 'b')])).map((group) => group.sort())).toEqual([
      ['v1', 'v2'],
    ]);
  });

  it('handles a library-sized set quickly', () => {
    const items = Array.from({ length: 20_000 }, (_, index) =>
      photo(String(index), randomBytes(8).toString('hex')),
    );
    const started = performance.now();
    findGroups(items);
    expect(performance.now() - started).toBeLessThan(3000);
  });
});
