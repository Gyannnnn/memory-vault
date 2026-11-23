export const mediaKinds = ['photo', 'raw', 'video', 'audio', 'document', 'other'] as const;
export type MediaKind = (typeof mediaKinds)[number];

const extensionsByKind: Record<Exclude<MediaKind, 'other'>, readonly string[]> = {
  photo: [
    'jpg',
    'jpeg',
    'jpe',
    'heic',
    'heif',
    'hif',
    'png',
    'webp',
    'gif',
    'bmp',
    'tif',
    'tiff',
    'avif',
    'jxl',
  ],
  raw: ['dng', 'cr2', 'cr3', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'raf', 'srw', 'pef', 'raw'],
  video: [
    'mp4',
    'm4v',
    'mov',
    '3gp',
    '3g2',
    'mkv',
    'webm',
    'avi',
    'mts',
    'm2ts',
    'ts',
    'wmv',
    'flv',
    'mpg',
    'mpeg',
  ],
  audio: ['m4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'wav', 'amr', 'awb', 'flac', 'wma', 'mid', 'midi'],
  document: [
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'odt',
    'ods',
    'odp',
    'rtf',
    'txt',
    'md',
    'csv',
    'json',
    'xml',
    'html',
    'epub',
    'vcf',
    'zip',
    'rar',
    '7z',
    'apk',
  ],
};

const kindByExtension = new Map<string, MediaKind>(
  Object.entries(extensionsByKind).flatMap(([kind, extensions]) =>
    extensions.map((extension) => [extension, kind as MediaKind] as const),
  ),
);

export function fileNameOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export function extensionOf(path: string): string {
  const name = fileNameOf(path).replace(/^\.+/, '');
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function mediaKindOf(path: string): MediaKind {
  return kindByExtension.get(extensionOf(path)) ?? 'other';
}

export function isVisualMedia(kind: MediaKind): boolean {
  return kind === 'photo' || kind === 'raw' || kind === 'video';
}

const mimeTypes: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  heic: 'image/heic',
  heif: 'image/heif',
  hif: 'image/heif',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  jxl: 'image/jxl',
  dng: 'image/x-adobe-dng',
  cr2: 'image/x-canon-cr2',
  cr3: 'image/x-canon-cr3',
  nef: 'image/x-nikon-nef',
  arw: 'image/x-sony-arw',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  '3gp': 'video/3gpp',
  '3g2': 'video/3gpp2',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mts: 'video/mp2t',
  m2ts: 'video/mp2t',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  amr: 'audio/amr',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  vcf: 'text/vcard',
  apk: 'application/vnd.android.package-archive',
};

export function mimeTypeOf(path: string): string {
  return mimeTypes[extensionOf(path)] ?? 'application/octet-stream';
}
