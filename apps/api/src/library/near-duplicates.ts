/**
 * Near-duplicate grouping over 64-bit perceptual hashes. Two items match when their hashes
 * differ in at most `maxDistance` bits (and, for videos, their lengths are within a second).
 * Candidates come from banding: the 64 bits are cut into maxDistance + 1 bands, so any two
 * hashes within the distance agree on at least one whole band (pigeonhole). Matches are
 * joined with union-find, then each joined set is split around centres, taken in input
 * order (so pass the best copies first): every member of a group is within the distance of
 * its centre. Without that, chains of near matches (A like B like C…) would put unrelated
 * photos together.
 */

export interface HashedItem {
  id: string;
  /** 16 hex digits. */
  hash: string;
  kind: 'photo' | 'raw' | 'video';
  durationMs: number | null;
}

export const MAX_DISTANCE = 6;

const popcount32 = (value: number) => {
  let x = value - ((value >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/** Bits that differ between two 16-hex-digit hashes. */
export function hammingDistance(a: string, b: string): number {
  return (
    popcount32((parseInt(a.slice(0, 8), 16) ^ parseInt(b.slice(0, 8), 16)) >>> 0) +
    popcount32((parseInt(a.slice(8), 16) ^ parseInt(b.slice(8), 16)) >>> 0)
  );
}

/** Bit ranges [start, width] covering 0–63 in `count` bands as even as possible. */
function bands(count: number): [number, number][] {
  const result: [number, number][] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    const width = Math.floor(64 / count) + (index < 64 % count ? 1 : 0);
    result.push([start, width]);
    start += width;
  }
  return result;
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

const comparable = (a: HashedItem, b: HashedItem) =>
  a.kind === 'video' || b.kind === 'video'
    ? a.kind === 'video' &&
      b.kind === 'video' &&
      a.durationMs !== null &&
      b.durationMs !== null &&
      Math.abs(a.durationMs - b.durationMs) <= 1000
    : true;

/** Groups of two or more ids around a centre (the first id); pairs in `dismissed` never match. */
export function findGroups(
  items: HashedItem[],
  dismissed: ReadonlySet<string> = new Set(),
  maxDistance = MAX_DISTANCE,
): string[][] {
  const hi = items.map((item) => parseInt(item.hash.slice(0, 8), 16) >>> 0);
  const lo = items.map((item) => parseInt(item.hash.slice(8), 16) >>> 0);
  // Each item's value in each band (bands are at most 10 bits wide).
  const values = bands(maxDistance + 1).map(([start, width]) =>
    items.map((item) => Number((BigInt(`0x${item.hash}`) >> BigInt(start)) & ((1n << BigInt(width)) - 1n))),
  );
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };

  values.forEach((band, bandIndex) => {
    const buckets = new Map<number, number[]>();
    band.forEach((value, index) => {
      const bucket = buckets.get(value);
      if (bucket) bucket.push(index);
      else buckets.set(value, [index]);
    });
    for (const bucket of buckets.values()) {
      for (let i = 0; i < bucket.length; i += 1) {
        for (let j = i + 1; j < bucket.length; j += 1) {
          const a = bucket[i]!;
          const b = bucket[j]!;
          // Already compared in an earlier band they share.
          let seen = false;
          for (let earlier = 0; earlier < bandIndex && !seen; earlier += 1)
            seen = values[earlier]![a] === values[earlier]![b];
          if (seen) continue;
          const distance = popcount32((hi[a]! ^ hi[b]!) >>> 0) + popcount32((lo[a]! ^ lo[b]!) >>> 0);
          if (distance > maxDistance || !comparable(items[a]!, items[b]!)) continue;
          if (dismissed.has(pairKey(items[a]!.id, items[b]!.id))) continue;
          parent[find(a)] = find(b);
        }
      }
    }
  });

  const components = new Map<number, number[]>();
  items.forEach((_, index) => {
    const root = find(index);
    const component = components.get(root);
    if (component) component.push(index);
    else components.set(root, [index]);
  });

  const groups: string[][] = [];
  for (const component of components.values()) {
    if (component.length < 2) continue;
    const taken = new Set<number>();
    for (const centre of component) {
      if (taken.has(centre)) continue;
      taken.add(centre);
      const group = [items[centre]!.id];
      for (const other of component) {
        if (taken.has(other)) continue;
        const distance =
          popcount32((hi[centre]! ^ hi[other]!) >>> 0) + popcount32((lo[centre]! ^ lo[other]!) >>> 0);
        if (
          distance <= maxDistance &&
          comparable(items[centre]!, items[other]!) &&
          !dismissed.has(pairKey(items[centre]!.id, items[other]!.id))
        ) {
          taken.add(other);
          group.push(items[other]!.id);
        }
      }
      if (group.length > 1) groups.push(group);
    }
  }
  return groups;
}
