export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function valid(time: WallTime): WallTime | null {
  const { year, month, day, hour, minute, second } = time;
  const ok =
    year >= 1900 &&
    year <= 2100 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= 31 &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59;
  return ok ? time : null;
}

const patterns: { pattern: RegExp; build: (match: RegExpExecArray) => WallTime }[] = [
  {
    // WhatsApp Image 2026-01-25 at 6.12.09 PM
    pattern: /(\d{4})-(\d{2})-(\d{2}) at (\d{1,2})\.(\d{2})\.(\d{2}) ?([AP]M)/i,
    build: (m) => {
      const hour12 = Number(m[4]) % 12;
      return {
        year: Number(m[1]),
        month: Number(m[2]),
        day: Number(m[3]),
        hour: m[7]!.toUpperCase() === 'PM' ? hour12 + 12 : hour12,
        minute: Number(m[5]),
        second: Number(m[6]),
      };
    },
  },
  {
    // Screenshot from 2025-05-05 15-38-16, 2025-05-05 15.38.16
    pattern: /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-.:](\d{2})[-.:](\d{2})/,
    build: (m) => ({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6]),
    }),
  },
  {
    // 20240901_173002, IMG_20240428_175439, VID20240820125415, PXL_20240101_101010123
    pattern: /(?:^|[^0-9])((?:19|20)\d{2})(\d{2})(\d{2})[_-]?(\d{2})(\d{2})(\d{2})/,
    build: (m) => ({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: Number(m[4]),
      minute: Number(m[5]),
      second: Number(m[6]),
    }),
  },
  {
    // IMG-20240319-WA0021 (date only: noon, to stay on the right day in any zone)
    pattern: /(?:^|[^0-9])((?:19|20)\d{2})(\d{2})(\d{2})-WA\d+/i,
    build: (m) => ({
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
      hour: 12,
      minute: 0,
      second: 0,
    }),
  },
];

/** Recovers the capture time that phones and messengers write into file names. */
export function wallTimeFromFileName(name: string): WallTime | null {
  for (const { pattern, build } of patterns) {
    const match = pattern.exec(name);
    if (match) {
      const time = valid(build(match));
      if (time) return time;
    }
  }
  return null;
}

/** Minutes the zone is ahead of UTC at the given instant. */
export function zoneOffsetMinutes(instant: number, timeZone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** Interprets a wall-clock time as local time in `timeZone`. */
export function wallTimeToInstant(time: WallTime, timeZone: string): { date: Date; offsetMinutes: number } {
  const naive = Date.UTC(time.year, time.month - 1, time.day, time.hour, time.minute, time.second);
  let offset = zoneOffsetMinutes(naive, timeZone);
  let instant = naive - offset * 60_000;
  const corrected = zoneOffsetMinutes(instant, timeZone);
  if (corrected !== offset) {
    offset = corrected;
    instant = naive - offset * 60_000;
  }
  return { date: new Date(instant), offsetMinutes: offset };
}
