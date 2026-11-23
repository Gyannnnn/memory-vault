const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Binary units (1 KB = 1024 B), matching how `du -h` and AWS storage billing count. */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(fractionDigits)} ${byteUnits[unit]}`;
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const seconds = Math.round(totalSeconds);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

export function formatUsd(amount: number): string {
  return amount < 0.01 && amount > 0 ? '< $0.01' : `$${amount.toFixed(2)}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
