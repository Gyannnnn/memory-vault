'use client';

/* eslint-disable @next/next/no-img-element -- presigned S3 WebP derivatives */
import type { ShareKind, ShareLinkSummary } from '@memory-vault/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookImage, Check, Copy, Folder, Image as ImageIcon, Link2Off, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { shareUrl } from '@/components/sharing/share-dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { LoadError, Row, Rows, RowsLoading, Section } from '../security/section';

const KIND_ICON: Record<ShareKind, typeof Folder> = { photo: ImageIcon, album: BookImage, folder: Folder };
const KIND_LABEL: Record<ShareKind, string> = { photo: 'Photo', album: 'Album', folder: 'Folder' };

const date = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

function statusText(link: ShareLinkSummary): string {
  if (link.status === 'revoked') return 'Turned off';
  if (link.status === 'expired') return 'Expired';
  return link.expiresAt ? `Until ${date(link.expiresAt)}` : 'No expiry';
}

function meta(link: ShareLinkSummary): string {
  return [
    KIND_LABEL[link.kind],
    `made ${date(link.createdAt)}`,
    link.hasPassword ? 'password' : null,
    link.allowDownload ? 'downloads on' : 'view only',
    link.openCount ? `opened ${link.openCount.toLocaleString()}×` : 'not opened yet',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function SharingSettings() {
  const queryClient = useQueryClient();
  const links = useQuery({
    queryKey: ['shares'],
    queryFn: async () => (await api<{ items: ShareLinkSummary[] }>('/shares')).items,
  });
  const [copied, setCopied] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ShareLinkSummary | null>(null);
  const [busy, setBusy] = useState(false);

  const copy = async (link: ShareLinkSummary) => {
    try {
      await navigator.clipboard.writeText(shareUrl(link.token));
      setCopied(link.id);
      setTimeout(() => setCopied((current) => (current === link.id ? null : current)), 2000);
    } catch {
      toast.error('Copying didn’t work', { description: shareUrl(link.token) });
    }
  };

  const revoke = async () => {
    if (!revoking) return;
    setBusy(true);
    try {
      await api(`/shares/${revoking.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['shares'] });
      toast.success('Link turned off');
      setRevoking(null);
    } catch (error) {
      toast.error('The link is still on', { description: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section
        title="Share links"
        description="Links you made to photos, albums and folders. Anyone with a link that's on can see what it shows."
      >
        {links.isPending ? (
          <RowsLoading count={3} />
        ) : links.isError ? (
          <LoadError message="Your links couldn’t be loaded." onRetry={() => void links.refetch()} />
        ) : links.data.length === 0 ? (
          <p className="text-sm text-ink-muted">
            No links yet. Choose Share on a photo, an album or a folder to make one.
          </p>
        ) : (
          <Rows>
            {links.data.map((link) => {
              const Icon = KIND_ICON[link.kind];
              const active = link.status === 'active';
              return (
                <Row
                  key={link.id}
                  icon={
                    link.cover ? (
                      <img src={link.cover.sm} alt="" className="size-9 rounded-md object-cover" />
                    ) : (
                      <Icon className="size-4" aria-hidden="true" />
                    )
                  }
                  title={
                    <span className={cn(!active && 'text-ink-muted')}>
                      {link.title ?? 'No longer in your library'}
                    </span>
                  }
                  badge={
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-xs font-medium',
                        active ? 'bg-keep-soft text-keep' : 'bg-surface-sunken text-ink-muted',
                      )}
                    >
                      {statusText(link)}
                    </span>
                  }
                  meta={meta(link)}
                  actions={
                    active && (
                      <>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => void copy(link)}
                              aria-label="Copy link"
                            >
                              {copied === link.id ? <Check /> : <Copy />}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>{copied === link.id ? 'Copied' : 'Copy link'}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => setRevoking(link)}
                              aria-label="Turn off link"
                            >
                              <Link2Off />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent>Turn off link</TooltipContent>
                        </Tooltip>
                      </>
                    )
                  }
                />
              );
            })}
          </Rows>
        )}
      </Section>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn off this link?</AlertDialogTitle>
            <AlertDialogDescription>
              Anyone who has it will see “This link isn’t available”. Nothing in your library changes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it on</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={(event) => {
                event.preventDefault();
                void revoke();
              }}
            >
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Turn off
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
