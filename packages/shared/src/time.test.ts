import { describe, expect, it } from 'vitest';
import { wallTimeFromFileName, wallTimeToInstant } from './time';

describe('wallTimeFromFileName', () => {
  it.each([
    ['20240901_173002.mp4', '2024-09-01 17:30:02'],
    ['IMG_20240428_175439.jpg', '2024-04-28 17:54:39'],
    ['VID20240820125415.mp4', '2024-08-20 12:54:15'],
    ['.temp-20250421_222548922_20.mp4', '2025-04-21 22:25:48'],
    ['WhatsApp Video 2026-01-25 at 6.12.09 PM (1).mp4', '2026-01-25 18:12:09'],
    ['WhatsApp Image 2026-01-25 at 12.05.01 AM.jpeg', '2026-01-25 00:05:01'],
    ['Screenshot from 2025-05-05 15-38-16.png', '2025-05-05 15:38:16'],
    ['IMG-20240319-WA0021.jpg', '2024-03-19 12:00:00'],
    ['Screenshot_20250101-101010_Chrome.jpg', '2025-01-01 10:10:10'],
  ])('%s → %s', (name, expected) => {
    const time = wallTimeFromFileName(name);
    expect(time).not.toBeNull();
    const { year, month, day, hour, minute, second } = time!;
    const pad = (value: number) => String(value).padStart(2, '0');
    expect(`${year}-${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}:${pad(second)}`).toBe(expected);
  });

  it.each(['photo.jpg', 'IMG_9999.HEIC', '20241399_101010.jpg', 'me.jpg'])('finds nothing in %s', (name) => {
    expect(wallTimeFromFileName(name)).toBeNull();
  });
});

describe('wallTimeToInstant', () => {
  it('applies the zone offset', () => {
    const result = wallTimeToInstant(
      { year: 2024, month: 9, day: 1, hour: 17, minute: 30, second: 2 },
      'Asia/Kolkata',
    );
    expect(result.date.toISOString()).toBe('2024-09-01T12:00:02.000Z');
    expect(result.offsetMinutes).toBe(330);
  });

  it('handles daylight saving time', () => {
    const summer = wallTimeToInstant(
      { year: 2024, month: 7, day: 1, hour: 12, minute: 0, second: 0 },
      'Europe/London',
    );
    const winter = wallTimeToInstant(
      { year: 2024, month: 1, day: 1, hour: 12, minute: 0, second: 0 },
      'Europe/London',
    );
    expect(summer.offsetMinutes).toBe(60);
    expect(winter.offsetMinutes).toBe(0);
  });
});
