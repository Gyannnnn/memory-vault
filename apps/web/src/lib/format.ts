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

// Capture times are wall-clock times without a zone ("2025-01-01T09:30:00.000"): they are
// shown exactly as written, by reading them as UTC and formatting in UTC.
const wall = (localAt: string) => new Date(`${localAt.slice(0, 23)}Z`);
const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const shortMonthFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});
const dayYearFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});
const wallFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'UTC',
});

/** "2026-08" → "August 2026" */
export const formatMonth = (month: string) => monthFormat.format(wall(`${month}-01T00:00:00.000`));
/** "2026-08" → "Aug 2026" */
export const formatShortMonth = (month: string) => shortMonthFormat.format(wall(`${month}-01T00:00:00.000`));

/** "2026-08-04" → "Tue, 4 Aug", with the year when it isn't this year. */
export function formatDay(day: string): string {
  const date = wall(`${day}T00:00:00.000`);
  return (date.getUTCFullYear() === new Date().getFullYear() ? dayFormat : dayYearFormat).format(date);
}

/** Wall-clock capture time → "4 Aug 2026, 14:32" */
export const formatWallTime = (localAt: string) => wallFormat.format(wall(localAt));

/** Video length → "0:42" or "1:02:03" */
export function formatClock(milliseconds: number): string {
  const total = Math.round(milliseconds / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
}
