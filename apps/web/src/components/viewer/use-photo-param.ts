'use client';

import { useSearchParams } from 'next/navigation';
import { useCallback, useRef } from 'react';

function withPhoto(id: string | null): string {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set('photo', id);
  else url.searchParams.delete('photo');
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * The open photo lives in the address (?photo=…): links to a photo work, and the browser's
 * Back button closes the viewer instead of leaving the page.
 */
export function usePhotoParam() {
  const photoId = useSearchParams().get('photo');
  const pushed = useRef(false);

  const open = useCallback((id: string) => {
    window.history.pushState(null, '', withPhoto(id));
    pushed.current = true;
  }, []);

  /** Moving between photos replaces the entry, so Back still closes the viewer in one step. */
  const show = useCallback((id: string) => window.history.replaceState(null, '', withPhoto(id)), []);

  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      window.history.back();
    } else {
      window.history.replaceState(null, '', withPhoto(null));
    }
  }, []);

  return { photoId, open, show, close };
}
