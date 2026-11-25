import type { AssetTile } from '@memory-vault/shared';
import { formatMonth } from '@/lib/format';
import type { GallerySection } from './gallery-layout';

/** Groups items (already newest first) into one section per month, keeping their order. */
export function sectionsByMonth(items: AssetTile[]): GallerySection[] {
  const sections: GallerySection[] = [];
  for (const item of items) {
    const month = item.localAt.slice(0, 7);
    const last = sections.at(-1);
    if (last?.key === month) last.items!.push(item);
    else sections.push({ key: month, title: formatMonth(month), items: [item], groupByDay: false });
  }
  return sections;
}
