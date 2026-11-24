const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** "just now", "5 minutes ago", "yesterday", then a plain date after a week. */
export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  if (abs < 3600) return relativeFormat.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relativeFormat.format(Math.round(seconds / 3600), 'hour');
  if (abs < 7 * 86_400) return relativeFormat.format(Math.round(seconds / 86_400), 'day');
  return formatDate(iso);
}
