import type { AssetTile } from '@memory-vault/shared';
import { clampAspect, estimateRowsHeight, justifyRows, type JustifiedOptions } from '@memory-vault/shared';

export interface GallerySection {
  key: string;
  title: string;
  /** Loaded items, newest first; undefined while the section hasn't been fetched. */
  items?: AssetTile[];
  /** For sections not loaded yet: per day [count, sum of aspect ratios]. */
  estimate?: [number, number][];
  /** Split the section into day groups with their own labels. */
  groupByDay: boolean;
}

export interface PlacedTile {
  tile: AssetTile;
  left: number;
  width: number;
}

export type Block =
  | { kind: 'section'; key: string; top: number; height: number; title: string; section: string }
  | { kind: 'day'; key: string; top: number; height: number; day: string }
  | { kind: 'row'; key: string; top: number; height: number; tileHeight: number; items: PlacedTile[] }
  /** Several small days side by side, each with its label above its photos. */
  | {
      kind: 'packed';
      key: string;
      top: number;
      height: number;
      tileHeight: number;
      labelHeight: number;
      segments: { day: string; left: number; items: PlacedTile[] }[];
    }
  | { kind: 'placeholder'; key: string; top: number; height: number; section: string };

/** Omit that keeps the union's members apart. */
type WithoutTop<T> = T extends unknown ? Omit<T, 'top'> : never;

export interface GalleryLayout {
  blocks: Block[];
  /** Where each section starts and how tall it is, for the scrubber and scroll anchoring. */
  sections: { key: string; title: string; top: number; height: number; loaded: boolean }[];
  height: number;
}

export interface LayoutMetrics extends JustifiedOptions {
  sectionHeader: number;
  dayHeader: number;
  /** Space between days packed into one row. */
  dayGap: number;
}

export function metricsFor(width: number): LayoutMetrics {
  const compact = width < 640;
  return {
    width,
    rowHeight: compact ? 112 : width < 1100 ? 168 : 216,
    gap: compact ? 2 : 4,
    sectionHeader: compact ? 56 : 72,
    dayHeader: compact ? 32 : 40,
    dayGap: compact ? 12 : 20,
  };
}

interface Day {
  day: string;
  count: number;
  aspectSum: number;
  items?: AssetTile[];
}

function daysOf(items: AssetTile[], byDay: boolean): Day[] {
  const days: Day[] = [];
  for (const item of items) {
    const day = byDay ? item.localAt.slice(0, 10) : '';
    const last = days.at(-1);
    const aspect = clampAspect(item.width, item.height);
    if (last && last.day === day) {
      last.items!.push(item);
      last.count += 1;
      last.aspectSum += aspect;
    } else {
      days.push({ day, count: 1, aspectSum: aspect, items: [item] });
    }
  }
  return days;
}

/**
 * Lays out one section's days: a day that fills at least a row gets its own label and
 * justified rows; smaller days are packed side by side at the preferred row height.
 * With `emit` absent it only measures, so unloaded sections get a matching estimate.
 */
function layoutDays(
  days: Day[],
  metrics: LayoutMetrics,
  withLabels: boolean,
  emit?: (block: WithoutTop<Block>) => void,
  keyPrefix = '',
): number {
  const { width, rowHeight, gap, dayHeader, dayGap } = metrics;
  const label = withLabels ? dayHeader : 0;
  let height = 0;
  let packed: { day: Day; left: number; width: number }[] = [];
  let packedWidth = 0;

  const flush = () => {
    if (!packed.length) return;
    const blockHeight = label + rowHeight + gap;
    height += blockHeight;
    emit?.({
      kind: 'packed',
      key: `${keyPrefix}pk:${packed[0]!.day.day}`,
      height: blockHeight,
      tileHeight: rowHeight,
      labelHeight: label,
      segments: packed.map(({ day, left }) => {
        let x = 0;
        return {
          day: day.day,
          left,
          items: (day.items ?? []).map((tile) => {
            const tileWidth = clampAspect(tile.width, tile.height) * rowHeight;
            const placed = { tile, left: x, width: tileWidth };
            x += tileWidth + gap;
            return placed;
          }),
        };
      }),
    });
    packed = [];
    packedWidth = 0;
  };

  for (const day of days) {
    const natural = day.aspectSum * rowHeight + gap * (day.count - 1);
    if (withLabels && natural < width) {
      const left = packed.length ? packedWidth + dayGap : 0;
      if (left + natural > width) flush();
      const start = packed.length ? packedWidth + dayGap : 0;
      packed.push({ day, left: start, width: natural });
      packedWidth = start + natural;
      continue;
    }
    flush();
    if (withLabels) {
      height += label;
      emit?.({ kind: 'day', key: `${keyPrefix}d:${day.day}`, height: label, day: day.day });
    }
    if (day.items && emit) {
      const rows = justifyRows(
        day.items.map((item) => clampAspect(item.width, item.height)),
        metrics,
      );
      rows.forEach((row, index) => {
        height += row.height + gap;
        emit({
          kind: 'row',
          key: `${keyPrefix}r:${day.day}:${index}`,
          height: row.height + gap,
          tileHeight: row.height,
          items: row.items.map((cell) => ({
            tile: day.items![cell.index]!,
            left: cell.left,
            width: cell.width,
          })),
        });
      });
    } else {
      height += estimateRowsHeight(day.count, day.aspectSum, metrics) + gap;
    }
  }
  flush();
  return height;
}

/**
 * Turns sections into absolutely positioned blocks (headers and rows). Heights are
 * computed, never measured, so the page height is known before anything renders.
 */
export function layoutGallery(sections: GallerySection[], metrics: LayoutMetrics): GalleryLayout {
  const blocks: Block[] = [];
  const geometry: GalleryLayout['sections'] = [];
  let top = 0;
  const push = (block: WithoutTop<Block>) => {
    blocks.push({ ...block, top });
    top += block.height;
  };

  for (const section of sections) {
    const start = top;
    push({
      kind: 'section',
      key: `s:${section.key}`,
      height: metrics.sectionHeader,
      title: section.title,
      section: section.key,
    });
    if (section.items) {
      layoutDays(
        daysOf(section.items, section.groupByDay),
        metrics,
        section.groupByDay,
        push,
        `${section.key}:`,
      );
    } else {
      const days: Day[] = (section.estimate ?? []).map(([count, aspectSum], index) => ({
        day: String(index),
        count,
        aspectSum,
      }));
      const height = layoutDays(days, metrics, section.groupByDay);
      push({
        kind: 'placeholder',
        key: `p:${section.key}`,
        height: Math.max(height, metrics.rowHeight),
        section: section.key,
      });
    }
    geometry.push({
      key: section.key,
      title: section.title,
      top: start,
      height: top - start,
      loaded: Boolean(section.items),
    });
  }

  return { blocks, sections: geometry, height: top };
}
