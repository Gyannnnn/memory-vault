/**
 * One design language for web, mobile and local tools. Neutral "gallery" surfaces
 * so photographs carry the colour; semantic colours only where meaning needs them.
 */

const lightColors = {
  background: '#FAFAFA',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#F2F2F3',
  ink: '#0A0A0B',
  inkMuted: '#52525B',
  inkSubtle: '#71717A',
  inkInverse: '#FAFAFA',
  border: '#E4E4E7',
  borderStrong: '#D4D4D8',
  primary: '#18181B',
  onPrimary: '#FFFFFF',
  focus: '#2563EB',
  keep: '#15803D',
  keepSoft: '#DCFCE7',
  onKeep: '#FFFFFF',
  skip: '#B91C1C',
  skipSoft: '#FEE2E2',
  onSkip: '#FFFFFF',
  warning: '#B45309',
  warningSoft: '#FEF3C7',
  info: '#1D4ED8',
  infoSoft: '#DBEAFE',
  scrim: 'rgba(10, 10, 11, 0.72)',
  selection: 'rgba(37, 99, 235, 0.14)',
} as const;

export type ColorRole = keyof typeof lightColors;

const darkColors: Record<ColorRole, string> = {
  background: '#09090B',
  surface: '#111113',
  surfaceRaised: '#18181B',
  surfaceSunken: '#0C0C0E',
  ink: '#FAFAFA',
  inkMuted: '#A1A1AA',
  inkSubtle: '#8B8B94',
  inkInverse: '#0A0A0B',
  border: '#27272A',
  borderStrong: '#3F3F46',
  primary: '#FAFAFA',
  onPrimary: '#0A0A0B',
  focus: '#60A5FA',
  keep: '#4ADE80',
  keepSoft: 'rgba(74, 222, 128, 0.14)',
  onKeep: '#052E16',
  skip: '#F87171',
  skipSoft: 'rgba(248, 113, 113, 0.14)',
  onSkip: '#450A0A',
  warning: '#FBBF24',
  warningSoft: 'rgba(251, 191, 36, 0.14)',
  info: '#60A5FA',
  infoSoft: 'rgba(96, 165, 250, 0.14)',
  scrim: 'rgba(0, 0, 0, 0.82)',
  selection: 'rgba(96, 165, 250, 0.18)',
};

export const tokens = {
  color: { light: lightColors as Record<ColorRole, string>, dark: darkColors },
  /** 4 px base scale; keys are multiples of 4 px. */
  space: { 0: 0, 0.5: 2, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64, 20: 80 },
  radius: { sm: 6, md: 10, lg: 14, xl: 20, full: 9999 },
  font: {
    sans: [
      'Inter',
      'Inter Variable',
      'ui-sans-serif',
      'system-ui',
      '-apple-system',
      'Segoe UI',
      'Roboto',
      'sans-serif',
    ],
    mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
  },
  fontSize: { xs: 12, sm: 13, md: 14, base: 16, lg: 18, xl: 20, '2xl': 24, '3xl': 30, '4xl': 36 },
  lineHeight: { tight: 1.2, snug: 1.35, normal: 1.5 },
  fontWeight: { regular: 400, medium: 500, semibold: 600, bold: 700 },
  letterSpacing: { tight: '-0.015em', normal: '0', wide: '0.02em' },
  motion: {
    duration: { fast: 120, base: 200, slow: 280 },
    easing: {
      standard: 'cubic-bezier(0.2, 0, 0, 1)',
      enter: 'cubic-bezier(0, 0, 0, 1)',
      exit: 'cubic-bezier(0.3, 0, 1, 1)',
    },
  },
  shadow: {
    sm: '0 1px 2px rgba(0, 0, 0, 0.06)',
    md: '0 4px 12px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.06)',
    lg: '0 16px 40px rgba(0, 0, 0, 0.16), 0 4px 12px rgba(0, 0, 0, 0.08)',
  },
  layer: { base: 0, sticky: 10, overlay: 40, dialog: 50, toast: 60 },
  target: { min: 44 },
} as const;

const kebab = (value: string) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const spaceName = (key: string) => key.replace('.', '-');

function colorVariables(colors: Record<ColorRole, string>): string {
  return Object.entries(colors)
    .map(([role, value]) => `  --color-${kebab(role)}: ${value};`)
    .join('\n');
}

/**
 * CSS custom properties for every token. Dark mode follows the system unless the
 * page sets data-theme="light" or data-theme="dark" on <html>.
 */
export function toCss(): string {
  const statics = [
    ...Object.entries(tokens.space).map(([key, value]) => `  --space-${spaceName(key)}: ${value}px;`),
    ...Object.entries(tokens.radius).map(([key, value]) => `  --radius-${key}: ${value}px;`),
    `  --font-sans: ${tokens.font.sans.map((name) => (name.includes(' ') ? `"${name}"` : name)).join(', ')};`,
    `  --font-mono: ${tokens.font.mono.map((name) => (name.includes(' ') ? `"${name}"` : name)).join(', ')};`,
    ...Object.entries(tokens.fontSize).map(([key, value]) => `  --text-${key}: ${value / 16}rem;`),
    ...Object.entries(tokens.lineHeight).map(([key, value]) => `  --leading-${key}: ${value};`),
    ...Object.entries(tokens.fontWeight).map(([key, value]) => `  --weight-${key}: ${value};`),
    ...Object.entries(tokens.letterSpacing).map(([key, value]) => `  --tracking-${key}: ${value};`),
    ...Object.entries(tokens.motion.duration).map(([key, value]) => `  --duration-${key}: ${value}ms;`),
    ...Object.entries(tokens.motion.easing).map(([key, value]) => `  --ease-${key}: ${value};`),
    ...Object.entries(tokens.shadow).map(([key, value]) => `  --shadow-${key}: ${value};`),
    ...Object.entries(tokens.layer).map(([key, value]) => `  --layer-${key}: ${value};`),
    `  --target-min: ${tokens.target.min}px;`,
  ].join('\n');
  const light = colorVariables(tokens.color.light);
  const dark = colorVariables(tokens.color.dark);
  return [
    `:root {\n${statics}\n${light}\n  color-scheme: light;\n}`,
    `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme='light']) {\n${dark.replace(/^/gm, '  ')}\n    color-scheme: dark;\n  }\n}`,
    // Any element can opt into the dark palette (e.g. the photo viewer), not only the page root.
    `:root[data-theme='dark'],\n[data-theme='dark'] {\n${dark}\n  color-scheme: dark;\n}`,
    `@media (prefers-reduced-motion: reduce) {\n  :root {\n    --duration-fast: 0ms;\n    --duration-base: 0ms;\n    --duration-slow: 0ms;\n  }\n}`,
  ].join('\n\n');
}
