'use client';

import type { AssetDetail } from '@memory-vault/shared';
import { formatBytes } from '@memory-vault/shared';
import { Camera, CalendarClock, ExternalLink, FileImage, FolderOpen, MapPin, X } from 'lucide-react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatWallTime } from '@/lib/format';
import { sourceLabel } from '@/lib/sources';

const MiniMap = dynamic(() => import('@/components/map/mini-map'), {
  ssr: false,
  loading: () => <Skeleton className="size-full rounded-none" />,
});

const timeSources: Record<string, string> = {
  exif: 'From the camera',
  'exif-local': 'From the camera; time zone assumed from your settings',
  'file-name': 'From the file name',
  'file-modified': 'From the file’s last-modified date; may not be when it was taken',
  unknown: 'Not read yet',
};

function offsetLabel(minutes: number | null): string | null {
  if (minutes === null) return null;
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, '0')}` : ''}`;
}

function exposureLine(exif: AssetDetail['exif']): string | null {
  const parts: string[] = [];
  if (exif.FNumber) parts.push(`ƒ/${exif.FNumber}`);
  if (exif.ExposureTime) {
    const value = exif.ExposureTime;
    parts.push(
      typeof value === 'number' && value < 1
        ? `1/${Math.round(1 / value)} s`
        : `${String(value).replace(/ ?s$/, '')} s`,
    );
  }
  if (exif.ISO) parts.push(`ISO ${exif.ISO}`);
  if (exif.FocalLength) {
    const focal = String(exif.FocalLength).replace(/\.0 mm$/, ' mm');
    parts.push(
      exif.FocalLengthIn35mmFormat ? `${focal} (${String(exif.FocalLengthIn35mmFormat)} equiv.)` : focal,
    );
  }
  return parts.length ? parts.join(' · ') : null;
}

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="flex gap-3 py-4">
      <span className="mt-0.5 text-ink-subtle" aria-hidden="true">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="sr-only">{title}</h3>
        {children}
      </div>
    </section>
  );
}

export function InfoPanel({
  detail,
  loading,
  onClose,
}: {
  detail: AssetDetail | undefined;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label="Photo details"
      className="flex max-h-[60dvh] w-full shrink-0 flex-col overflow-y-auto border-t bg-surface md:max-h-none md:w-[360px] md:border-t-0 md:border-l"
    >
      <div className="sticky top-0 z-10 flex h-14 items-center justify-between bg-surface px-4">
        <h2 className="text-sm font-medium">Details</h2>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close details">
          <X />
        </Button>
      </div>
      {loading || !detail ? (
        <div className="space-y-4 px-4 py-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <div className="divide-y px-4 pb-6 text-sm">
          {!detail.processing.done && (
            <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
              Still being processed. Its date, place and preview appear when that finishes.
            </p>
          )}
          <Section icon={<CalendarClock className="size-4" />} title="Taken">
            <p className="font-medium">{formatWallTime(detail.localAt)}</p>
            <p className="mt-0.5 text-xs text-ink-subtle">
              {[
                offsetLabel(detail.takenAtOffsetMinutes),
                timeSources[detail.takenAtSource] ?? detail.takenAtSource,
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </Section>

          {detail.location && (
            <Section icon={<MapPin className="size-4" />} title="Place">
              {detail.location.place ? (
                <p className="font-medium">
                  {[detail.location.place.name, detail.location.place.admin1, detail.location.place.country]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              ) : (
                <p className="font-medium">Unnamed place</p>
              )}
              <p className="mt-0.5 text-xs text-ink-subtle tabular-nums">
                {detail.location.latitude.toFixed(5)}, {detail.location.longitude.toFixed(5)}
                {detail.location.altitude !== null ? ` · ${Math.round(detail.location.altitude)} m` : ''}
              </p>
              <div className="mt-3 h-40 overflow-hidden rounded-md ring-1 ring-border">
                <MiniMap latitude={detail.location.latitude} longitude={detail.location.longitude} dark />
              </div>
              <p className="mt-1 text-xs text-ink-subtle">
                Map © OpenMapTiles © OpenStreetMap contributors, via OpenFreeMap
              </p>
              <Link
                href={`/map?lat=${detail.location.latitude}&lng=${detail.location.longitude}&z=13`}
                className="mt-2 inline-flex min-h-9 items-center text-xs font-medium underline-offset-4 hover:underline"
              >
                Show on the library map
              </Link>
            </Section>
          )}

          {(detail.camera.model || exposureLine(detail.exif)) && (
            <Section icon={<Camera className="size-4" />} title="Camera">
              <p className="font-medium">
                {detail.camera.model ?? 'Unknown camera'}
                {detail.camera.make &&
                !detail.camera.model?.toLowerCase().startsWith(detail.camera.make.toLowerCase())
                  ? ` · ${detail.camera.make}`
                  : ''}
              </p>
              {detail.camera.lens && <p className="mt-0.5 text-xs text-ink-muted">{detail.camera.lens}</p>}
              {exposureLine(detail.exif) && (
                <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{exposureLine(detail.exif)}</p>
              )}
            </Section>
          )}

          <Section icon={<FileImage className="size-4" />} title="File">
            <p className="font-medium break-all">{detail.name}</p>
            <p className="mt-0.5 text-xs text-ink-muted tabular-nums">
              {[
                formatBytes(detail.sizeBytes),
                detail.width && detail.height ? `${detail.width} × ${detail.height}` : null,
                detail.width && detail.height
                  ? `${((detail.width * detail.height) / 1_000_000).toFixed(1)} MP`
                  : null,
                detail.extension.toUpperCase(),
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
            <a
              href={detail.originalUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-flex min-h-9 items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
            >
              Open the original
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          </Section>

          <Section icon={<FolderOpen className="size-4" />} title="Where it came from">
            <ul className="space-y-2">
              {detail.folders.map((folder) => (
                <li key={folder.path}>
                  <Link
                    href={`/folders/${folder.folderId}`}
                    className="block text-xs break-all underline-offset-4 hover:underline"
                  >
                    {folder.path}
                  </Link>
                </li>
              ))}
            </ul>
            {detail.origins.length > 1 && (
              <p className="mt-2 text-xs text-ink-subtle">
                The same file was found in {detail.origins.length} places:{' '}
                {[...new Set(detail.origins.map((origin) => sourceLabel(origin.sourceId)))].join(', ')}. It is
                stored once.
              </p>
            )}
          </Section>

          {detail.location?.place && (
            <p className="pt-4 text-xs text-ink-subtle">Place names from GeoNames (CC BY 4.0).</p>
          )}
        </div>
      )}
    </aside>
  );
}
