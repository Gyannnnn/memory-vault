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
