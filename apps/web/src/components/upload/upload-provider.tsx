'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Upload } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { browserTransport } from '@/lib/upload/browser-transport';
import { fromDrop, type Chosen } from '@/lib/upload/collect';
import { UploadManager, type UploadSnapshot } from '@/lib/upload/engine';

interface Uploads {
  manager: UploadManager;
  snapshot: UploadSnapshot;
  open: boolean;
  setOpen: (open: boolean) => void;
  add: (chosen: Chosen[]) => void;
}

const UploadContext = createContext<Uploads | null>(null);

export function useUploads(): Uploads {
  const value = useContext(UploadContext);
  if (!value) throw new Error('useUploads needs an UploadProvider');
  return value;
}

/** At most a few renders a second while bytes are flowing. */
function throttled(subscribe: (listener: () => void) => () => void, everyMs: number) {
  return (listener: () => void) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribe(() => {
      timer ??= setTimeout(() => {
        timer = null;
        listener();
      }, everyMs);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  };
}

/**
 * One upload engine for the whole app: uploads carry on while you browse. Files can be
 * dropped anywhere on the window. New photos show up in the library as they finish.
 */
export function UploadProvider({ children }: { children: ReactNode }) {
  const [manager] = useState(() => new UploadManager(browserTransport));
  const subscribe = useMemo(() => throttled(manager.subscribe, 200), [manager]);
  const snapshot = useSyncExternalStore(subscribe, manager.getSnapshot, manager.getSnapshot);
  const [open, setOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const queryClient = useQueryClient();

  const add = useCallback(
    (chosen: Chosen[]) => {
      if (chosen.length === 0) return;
      manager.add(chosen);
      setOpen(true);
    },
    [manager],
  );

  // Refresh the library when more files have finished.
  const finished = snapshot.counts.done + snapshot.counts.duplicate;
  const seen = useRef(0);
  useEffect(() => {
    if (finished <= seen.current) return;
    seen.current = finished;
    for (const key of ['timeline', 'search', 'folder', 'facets', 'map-points'])
      void queryClient.invalidateQueries({ queryKey: [key] });
  }, [finished, queryClient]);

  // Leaving the page stops uploads in progress; ask first.
  useEffect(() => {
    if (!snapshot.busy) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [snapshot.busy]);

  // Drop files or folders anywhere.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (event: DragEvent) => {
      if (hasFiles(event)) event.preventDefault();
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event) || !event.dataTransfer) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      void fromDrop(event.dataTransfer).then(add);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [add]);

  const value = useMemo(() => ({ manager, snapshot, open, setOpen, add }), [manager, snapshot, open, add]);
  return (
    <UploadContext.Provider value={value}>
      {children}
      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-xl border-2 border-dashed border-focus bg-selection backdrop-blur-[2px]"
        >
          <div className="flex flex-col items-center gap-2 rounded-lg bg-surface-raised px-6 py-4 text-center shadow-lg">
            <Upload className="size-6 text-focus" />
            <p className="font-medium">Drop to upload</p>
            <p className="text-sm text-ink-muted">Files and whole folders, kept as they are</p>
          </div>
        </div>
      )}
    </UploadContext.Provider>
  );
}
