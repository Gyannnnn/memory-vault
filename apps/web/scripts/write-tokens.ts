import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokens, toCss } from '@memory-vault/tokens';

const kebab = (value: string) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const quoteFont = (names: readonly string[]) =>
  names.map((name) => (name.includes(' ') ? `"${name}"` : name)).join(', ');

/** shadcn/ui's semantic names, mapped onto our token roles so its components follow light and dark. */
const shadcnAliases: Record<string, string> = {
  foreground: 'ink',
  card: 'surface',
  'card-foreground': 'ink',
  popover: 'surface-raised',
  'popover-foreground': 'ink',
  'primary-foreground': 'on-primary',
  secondary: 'surface-sunken',
  'secondary-foreground': 'ink',
  muted: 'surface-sunken',
  'muted-foreground': 'ink-muted',
  accent: 'surface-sunken',
  'accent-foreground': 'ink',
  destructive: 'skip',
  'destructive-foreground': 'on-skip',
  input: 'border-strong',
  ring: 'focus',
};

const theme = [
  '@theme {',
  '  --color-*: initial;',
  ...Object.entries(tokens.color.light).map(([role, value]) => `  --color-${kebab(role)}: ${value};`),
  `  --font-sans: var(--font-inter), ${quoteFont(tokens.font.sans)};`,
  `  --font-mono: ${quoteFont(tokens.font.mono)};`,
  ...Object.entries(tokens.radius).map(([key, value]) => `  --radius-${key}: ${value}px;`),
  ...Object.entries(tokens.shadow).map(([key, value]) => `  --shadow-${key}: ${value};`),
  `  --ease-standard: ${tokens.motion.easing.standard};`,
  '}',
  '',
  '@theme inline {',
  ...Object.entries(shadcnAliases).map(([name, role]) => `  --color-${name}: var(--color-${role});`),
  '}',
].join('\n');

const target = join(dirname(fileURLToPath(import.meta.url)), '../src/app/tokens.generated.css');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `/* Generated from @memory-vault/tokens. Do not edit. */\n${theme}\n\n${toCss()}\n`);
