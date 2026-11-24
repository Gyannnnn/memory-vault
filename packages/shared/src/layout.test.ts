import { describe, expect, it } from 'vitest';
import { clampAspect, estimateRowsHeight, justifyRows, rowsHeight } from './layout';

const options = { width: 1000, rowHeight: 200, gap: 4 };

describe('justifyRows', () => {
  it('fills each full row exactly and keeps the last row at the preferred height', () => {
    const rows = justifyRows([1.5, 1.5, 1.5, 0.75, 1.5, 1], options);
    expect(rows).toHaveLength(2);
    for (const row of rows.slice(0, -1)) {
      const last = row.items.at(-1)!;
      expect(last.left + last.width).toBeCloseTo(options.width, 6);
    }
    const lastRow = rows.at(-1)!;
    expect(lastRow.height).toBe(200);
    expect(lastRow.items.at(-1)!.left + lastRow.items.at(-1)!.width).toBeLessThan(options.width);
  });

  it('places every item exactly once, in order', () => {
    const aspects = Array.from({ length: 57 }, (_, index) => [0.75, 1.33, 1, 2.5, 0.5][index % 5]!);
    const indexes = justifyRows(aspects, options).flatMap((row) => row.items.map((item) => item.index));
    expect(indexes).toEqual(aspects.map((_, index) => index));
  });

  it('shrinks a lone last item that would not fit at the preferred height', () => {
    const rows = justifyRows([2.5], { width: 300, rowHeight: 200, gap: 4 });
    expect(rows[0]!.height).toBe(120);
    expect(rows[0]!.items[0]!.width).toBe(300);
  });

  it('handles nothing', () => {
    expect(justifyRows([], options)).toEqual([]);
    expect(rowsHeight([], 4)).toBe(0);
  });
});

describe('helpers', () => {
  it('clamps aspect ratios and treats unknown sizes as square', () => {
    expect(clampAspect(4000, 3000)).toBeCloseTo(1.333, 3);
    expect(clampAspect(10_000, 1000)).toBe(2.5);
    expect(clampAspect(100, 1000)).toBe(0.5);
    expect(clampAspect(null, null)).toBe(1);
  });

  it('estimates within a row of the real layout', () => {
    const aspects = Array.from({ length: 200 }, (_, index) => (index % 3 === 0 ? 0.75 : 1.333));
    const real = rowsHeight(justifyRows(aspects, options), options.gap);
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(Math.abs(estimateRowsHeight(aspects.length, sum(aspects), options) - real)).toBeLessThan(
      options.rowHeight + options.gap,
    );
    // A month of uneven days, estimated day by day as the timeline does.
    const days = Array.from({ length: 20 }, (_, day) =>
      aspects.slice(day * 9, day * 9 + 1 + ((day * 7) % 9)),
    );
    const realDays = sum(days.map((group) => rowsHeight(justifyRows(group, options), options.gap)));
    const estimateDays = sum(days.map((group) => estimateRowsHeight(group.length, sum(group), options)));
    expect(Math.abs(estimateDays - realDays) / realDays).toBeLessThan(0.1);
  });
});
