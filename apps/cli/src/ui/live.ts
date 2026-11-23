import { formatBytes, formatDuration } from '@memory-vault/shared';

/** Redraws a block of lines in place on a TTY; prints a line every few seconds otherwise. */
export class LiveView {
  private drawnLines = 0;
  private lastPlainAt = 0;

  constructor(
    private readonly stream: NodeJS.WriteStream = process.stderr,
    private readonly plainIntervalMs = 5000,
  ) {}

  get interactive(): boolean {
    return Boolean(this.stream.isTTY);
  }

  render(lines: string[]): void {
    if (this.interactive) {
      const width = this.stream.columns || 120;
      const clipped = lines.map((line) => (line.length > width - 1 ? `${line.slice(0, width - 2)}…` : line));
      const up = this.drawnLines > 0 ? `\x1b[${this.drawnLines}A` : '';
      this.stream.write(`${up}\r\x1b[J${clipped.join('\n')}\n`);
      this.drawnLines = clipped.length;
      return;
    }
    const now = Date.now();
    if (now - this.lastPlainAt >= this.plainIntervalMs) {
      this.lastPlainAt = now;
      this.stream.write(`${lines.join(' | ')}\n`);
    }
  }

  finish(lines: string[] = []): void {
    if (this.interactive && this.drawnLines > 0) {
      this.stream.write(`\x1b[${this.drawnLines}A\r\x1b[J`);
    }
    this.drawnLines = 0;
    if (lines.length > 0) this.stream.write(`${lines.join('\n')}\n`);
  }
}

/** Exponentially weighted transfer rate, robust to bursty progress callbacks. */
export class RateMeter {
  private rate = 0;
  private pending = 0;
  private lastSampleAt = performance.now();
  private readonly startedAt = performance.now();
  total = 0;

  constructor(private readonly halfLifeSeconds = 5) {}

  add(amount: number): void {
    this.pending += amount;
    this.total += amount;
  }

  perSecond(): number {
    const now = performance.now();
    const elapsed = (now - this.lastSampleAt) / 1000;
    if (elapsed >= 0.25) {
      const instant = this.pending / elapsed;
      const alpha = 1 - Math.pow(0.5, elapsed / this.halfLifeSeconds);
      this.rate = this.rate === 0 ? instant : this.rate + alpha * (instant - this.rate);
      this.pending = 0;
      this.lastSampleAt = now;
    }
    return this.rate;
  }

  elapsedSeconds(): number {
    return (performance.now() - this.startedAt) / 1000;
  }

  etaSeconds(remaining: number): number {
    const rate = this.perSecond();
    return rate > 0 ? remaining / rate : Number.POSITIVE_INFINITY;
  }
}

export function bar(fraction: number, width = 24): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(fraction) ? fraction : 0));
  const filled = Math.round(clamped * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

export function progressLine(label: string, done: number, total: number, meter: RateMeter): string {
  const fraction = total > 0 ? done / total : 1;
  const rate = meter.perSecond();
  const eta = meter.etaSeconds(total - done);
  return `${label} ${bar(fraction)} ${(fraction * 100).toFixed(1).padStart(5)}%  ${formatBytes(done)} / ${formatBytes(total)}  ${formatBytes(rate)}/s  ETA ${Number.isFinite(eta) ? formatDuration(eta) : '—'}`;
}
