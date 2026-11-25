import { describe, expect, it } from 'vitest';
import { tokens, toCss, type ColorRole } from './index';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16) / 255);
  const [r, g, b] = channels.map((value) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

const pairs: [ColorRole, ColorRole, number][] = [
  ['ink', 'background', 4.5],
  ['ink', 'surface', 4.5],
  ['inkMuted', 'surface', 4.5],
  ['inkSubtle', 'surface', 4.5],
  ['onPrimary', 'primary', 4.5],
  ['onKeep', 'keep', 4.5],
  ['onSkip', 'skip', 4.5],
  ['keep', 'surface', 3],
  ['skip', 'surface', 3],
  ['focus', 'background', 3],
  // Navigation icon tiles: the glyph is a graphic, so 3:1 (WCAG 1.4.11).
  ...(
    ['tintBlue', 'tintViolet', 'tintAmber', 'tintRose', 'tintOrange', 'tintGreen', 'tintTeal', 'tintGray', 'tintSlate'] as const
  ).map((tint): [ColorRole, ColorRole, number] => ['onTint', tint, 3]),
];

describe('colour tokens', () => {
  for (const mode of ['light', 'dark'] as const) {
    it.each(pairs)(`${mode}: %s on %s meets %s:1`, (foreground, background, minimum) => {
      expect(contrast(tokens.color[mode][foreground], tokens.color[mode][background])).toBeGreaterThanOrEqual(
        minimum,
      );
    });
  }

  it('defines the same roles in both modes and emits every one as CSS', () => {
    expect(Object.keys(tokens.color.dark).sort()).toEqual(Object.keys(tokens.color.light).sort());
    const css = toCss();
    for (const role of Object.keys(tokens.color.light)) {
      expect(css).toContain(`--color-${role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:`);
    }
    expect(css).toContain("[data-theme='dark']");
    expect(css).toContain('prefers-reduced-motion');
  });
});
