import { fileNameOf } from '../media-kinds';

export const reviewReasons = [
  'whatsapp',
  'telegram',
  'other-app-media',
  'screenshot',
  'screen-recording',
  'downloads',
  'messenger-filename',
  'phone-trash',
  'temp-file',
  'system-file',
  'thumbnail-cache',
  'near-duplicate',
  'classifier',
] as const;

export type ReviewReason = (typeof reviewReasons)[number];

export const reviewReasonLabels: Record<ReviewReason, string> = {
  whatsapp: 'WhatsApp media',
  telegram: 'Telegram media',
  'other-app-media': 'Other app media',
  screenshot: 'Screenshots',
  'screen-recording': 'Screen recordings',
  downloads: 'Downloads',
  'messenger-filename': 'Messenger files outside your folders',
  'phone-trash': 'In the phone’s trash',
  'temp-file': 'Temporary or incomplete files',
  'system-file': 'System marker files',
  'thumbnail-cache': 'Thumbnail cache',
  'near-duplicate': 'Near-duplicates of other photos',
  classifier: 'Looks like a meme, forward or greeting',
};

export type FileRoute = 'direct' | 'review';

export interface PathClassification {
  route: FileRoute;
  reasons: ReviewReason[];
}

const messengerFileName = [
  /^(IMG|VID|AUD|PTT|STK|DOC)-\d{8}-WA\d+/i,
  /^WhatsApp (Image|Video|Audio|Ptt|Document) \d{4}-\d{2}-\d{2} at /i,
];

const systemFileNames = new Set(['.nomedia', 'thumbs.db', '.ds_store', 'desktop.ini']);

const whatsappPackages = new Set(['com.whatsapp', 'com.whatsapp.w4b']);
const telegramPackages = new Set([
  'org.telegram.messenger',
  'org.telegram.messenger.web',
  'org.thunderdog.challegram',
]);

const knownFolders = [
  /^dcim$/,
  /^camera$/,
  /^cshot$/,
  /^pictures$/,
  /^movies$/,
  /^music$/,
  /^downloads?$/,
  /^documents$/,
  /^recordings?$/,
  /^screenshots?$/,
  /^screen ?recordings?$/,
  /^android$/,
  /^media$/,
  /^data$/,
  /^sent$/,
  /^private$/,
  /^\.statuses$/,
  /^\.thumbnails$/,
  /whatsapp/,
  /telegram/,
  /^(com|org|net|in|io)\./,
];

function isUserNamedFolder(segment: string): boolean {
  const lower = segment.toLowerCase();
  return !knownFolders.some((pattern) => pattern.test(lower));
}

/**
 * Decides from a file's path alone whether it may upload directly or must wait for
 * the owner's review. Paths are relative to the source root and use "/" separators.
 */
export function classifyPath(relativePath: string): PathClassification {
  const segments = relativePath.split('/').filter(Boolean);
  const fileName = fileNameOf(relativePath);
  const folders = segments.slice(0, -1);
  const lowerFolders = folders.map((segment) => segment.toLowerCase());
  const lowerName = fileName.toLowerCase();
  const reasons = new Set<ReviewReason>();

  const androidMediaPackage =
    lowerFolders[0] === 'android' && lowerFolders[1] === 'media' ? lowerFolders[2] : undefined;

  if (lowerFolders.some((folder) => folder.includes('whatsapp') || whatsappPackages.has(folder))) {
    reasons.add('whatsapp');
  }
  if (lowerFolders.some((folder) => folder.includes('telegram') || telegramPackages.has(folder))) {
    reasons.add('telegram');
  }
  if (
    androidMediaPackage &&
    !whatsappPackages.has(androidMediaPackage) &&
    !telegramPackages.has(androidMediaPackage)
  ) {
    reasons.add('other-app-media');
  }
  if (lowerFolders.some((folder) => /^screenshots?$/.test(folder)) || /^screenshot[_\- ]/i.test(fileName)) {
    reasons.add('screenshot');
  }
  if (
    lowerFolders.some((folder) => /^screen ?recordings?$/.test(folder)) ||
    /^screen[_ -]?recording/i.test(fileName)
  ) {
    reasons.add('screen-recording');
  }
  if (lowerFolders.some((folder) => folder === 'download' || folder === 'downloads')) {
    reasons.add('downloads');
  }
  if (
    !reasons.has('whatsapp') &&
    !reasons.has('telegram') &&
    messengerFileName.some((pattern) => pattern.test(fileName)) &&
    !folders.some(isUserNamedFolder)
  ) {
    reasons.add('messenger-filename');
  }
  if (lowerName.startsWith('.trashed-')) reasons.add('phone-trash');
  if (/^\.(temp|pending)-/.test(lowerName) || /\.(tmp|part|crdownload)$/.test(lowerName)) {
    reasons.add('temp-file');
  }
  if (systemFileNames.has(lowerName) || lowerName.startsWith('.thumbdata')) reasons.add('system-file');
  if (lowerFolders.includes('.thumbnails')) reasons.add('thumbnail-cache');

  const ordered = reviewReasons.filter((reason) => reasons.has(reason));
  return { route: ordered.length > 0 ? 'review' : 'direct', reasons: ordered };
}
