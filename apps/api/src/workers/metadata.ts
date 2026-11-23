import { ExifDate, ExifDateTime, type Tags } from 'exiftool-vendored';
import { wallTimeFromFileName, wallTimeToInstant } from '@memory-vault/shared';

export interface ExtractedMetadata {
  takenAt: Date | null;
  takenAtOffsetMinutes: number | null;
  takenAtSource: 'exif' | 'exif-local' | 'file-name' | 'file-modified' | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  gpsAltitude: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  isMotionPhoto: boolean;
  exif: Record<string, string | number | boolean>;
}

const DATE_TAGS = [
  'SubSecDateTimeOriginal',
  'DateTimeOriginal',
  'SubSecCreateDate',
  'CreateDate',
  'MediaCreateDate',
  'TrackCreateDate',
  'DateCreated',
] as const;

const KEPT_TAGS = [
  'Make',
  'Model',
  'LensModel',
  'Software',
  'FNumber',
  'ExposureTime',
  'ISO',
  'FocalLength',
  'FocalLengthIn35mmFormat',
  'Flash',
  'WhiteBalance',
  'ExposureProgram',
  'MeteringMode',
  'Orientation',
  'ImageWidth',
  'ImageHeight',
  'ColorSpace',
  'DateTimeOriginal',
  'OffsetTimeOriginal',
  'CreateDate',
  'GPSLatitude',
  'GPSLongitude',
  'GPSAltitude',
  'GPSDateTime',
  'Duration',
  'VideoFrameRate',
  'AvgBitrate',
  'CompressorName',
  'AudioFormat',
  'MIMEType',
  'FileType',
  'Megapixels',
  'HDRHeadroom',
  'MotionPhoto',
  'MicroVideo',
] as const;

function toPlain(value: unknown): string | number | boolean | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.length <= 500 ? value : undefined;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof ExifDateTime || value instanceof ExifDate) return value.toString() ?? undefined;
  return undefined;
}

function signedCoordinate(value: unknown, ref: unknown, negative: string): number | null {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  return typeof ref === 'string' && ref.toUpperCase().startsWith(negative) && number > 0 ? -number : number;
}

function orientedSize(tags: Tags): { width: number | null; height: number | null } {
  const width = Number(tags.ImageWidth ?? tags.ExifImageWidth);
  const height = Number(tags.ImageHeight ?? tags.ExifImageHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: null, height: null };
  }
  const orientation = Number(tags.Orientation);
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

/**
 * Picks the capture time: EXIF with its zone, EXIF wall time in the owner's zone,
 * the time written into the file name, then the file's own modification time.
 */
function captureTime(
  tags: Tags,
  context: { fileName: string; timeZone: string; fileModifiedAt: Date | null },
): Pick<ExtractedMetadata, 'takenAt' | 'takenAtOffsetMinutes' | 'takenAtSource'> {
  for (const name of DATE_TAGS) {
    const value = (tags as Record<string, unknown>)[name];
    if (!(value instanceof ExifDateTime) || value.year < 1971) continue;
    if (value.hasZone) {
      return {
        takenAt: value.toDate(),
        takenAtOffsetMinutes: value.tzoffsetMinutes ?? null,
        takenAtSource: 'exif',
      };
    }
    const local = wallTimeToInstant(
      {
        year: value.year,
        month: value.month,
        day: value.day,
        hour: value.hour,
        minute: value.minute,
        second: value.second,
      },
      context.timeZone,
    );
    return { takenAt: local.date, takenAtOffsetMinutes: local.offsetMinutes, takenAtSource: 'exif-local' };
  }
  const fromName = wallTimeFromFileName(context.fileName);
  if (fromName) {
    const local = wallTimeToInstant(fromName, context.timeZone);
    return { takenAt: local.date, takenAtOffsetMinutes: local.offsetMinutes, takenAtSource: 'file-name' };
  }
  if (context.fileModifiedAt) {
    return { takenAt: context.fileModifiedAt, takenAtOffsetMinutes: null, takenAtSource: 'file-modified' };
  }
  return { takenAt: null, takenAtOffsetMinutes: null, takenAtSource: null };
}

export function normalizeMetadata(
  tags: Tags,
  context: { fileName: string; timeZone: string; fileModifiedAt: Date | null },
): ExtractedMetadata {
  const record = tags as Record<string, unknown>;
  const latitude = signedCoordinate(tags.GPSLatitude, tags.GPSLatitudeRef, 'S');
  const longitude = signedCoordinate(tags.GPSLongitude, tags.GPSLongitudeRef, 'W');
  const altitude = Number(tags.GPSAltitude);
  const durationSeconds = Number(tags.Duration);
  const exif: Record<string, string | number | boolean> = {};
  for (const name of KEPT_TAGS) {
    const value = toPlain(record[name]);
    if (value !== undefined) exif[name] = value;
  }
  const text = (value: unknown) =>
    typeof value === 'string' && value.trim() ? value.trim().slice(0, 200) : null;
  return {
    ...captureTime(tags, context),
    gpsLatitude: latitude !== null && longitude !== null ? latitude : null,
    gpsLongitude: latitude !== null && longitude !== null ? longitude : null,
    gpsAltitude: latitude !== null && Number.isFinite(altitude) ? altitude : null,
    cameraMake: text(tags.Make),
    cameraModel: text(tags.Model),
    lensModel: text(tags.LensModel),
    ...orientedSize(tags),
    durationMs:
      Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds * 1000) : null,
    isMotionPhoto:
      Number(record.MotionPhoto) === 1 ||
      Number(record.MicroVideo) === 1 ||
      'EmbeddedVideoFile' in record ||
      'MotionPhotoVideo' in record,
    exif,
  };
}
