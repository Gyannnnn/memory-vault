/** Width-to-height ratios outside this range are cropped to it, so panoramas and slivers stay usable. */
export const MIN_ASPECT = 0.5;
export const MAX_ASPECT = 2.5;

export const clampAspect = (width: number | null, height: number | null): number => {
  const aspect = width && height ? width / height : 1;
  return Math.min(MAX_ASPECT, Math.max(MIN_ASPECT, aspect));
};

export interface JustifiedOptions {
  /** Available width in px. */
  width: number;
  /** Preferred row height in px; full rows end up close to it. */
  rowHeight: number;
  /** Space between items and rows in px. */
  gap: number;
}

export interface JustifiedRow {
  height: number;
  items: { index: number; left: number; width: number }[];
}

/**
 * Packs items into rows that exactly fill the width (like Google Photos or Flickr):
 * a row keeps taking items until it would be taller than wide enough, then scales
 * to fit. The last row keeps the preferred height instead of stretching.
 */
export function justifyRows(aspects: readonly number[], options: JustifiedOptions): JustifiedRow[] {
  const { width, rowHeight, gap } = options;
  const rows: JustifiedRow[] = [];
  let start = 0;
  let sum = 0;

  const emit = (end: number, height: number) => {
    let left = 0;
    const items = [];
    for (let index = start; index <= end; index += 1) {
      const itemWidth = aspects[index]! * height;
      items.push({ index, left, width: itemWidth });
      left += itemWidth + gap;
    }
    rows.push({ height, items });
  };

  for (let index = 0; index < aspects.length; index += 1) {
    sum += aspects[index]!;
    const gaps = gap * (index - start);
    if (sum * rowHeight + gaps >= width) {
      emit(index, (width - gaps) / sum);
      start = index + 1;
      sum = 0;
    }
  }
  if (start < aspects.length) {
    const gaps = gap * (aspects.length - 1 - start);
    emit(aspects.length - 1, Math.min(rowHeight, (width - gaps) / sum));
  }
  return rows;
}

/** Height of `rows` laid out one after another with `gap` between them. */
export const rowsHeight = (rows: readonly JustifiedRow[], gap: number): number =>
  rows.reduce((total, row) => total + row.height, 0) + Math.max(0, rows.length - 1) * gap;

/**
 * A close guess at the height of a group of photos before they are loaded: lays out the
 * same number of photos with the group's average shape.
 */
export function estimateRowsHeight(count: number, aspectSum: number, options: JustifiedOptions): number {
  if (count <= 0 || aspectSum <= 0) return 0;
  return rowsHeight(justifyRows(new Array<number>(count).fill(aspectSum / count), options), options.gap);
}
