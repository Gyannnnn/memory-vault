'use client';

import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDay } from '@/lib/format';
import { cn } from '@/lib/utils';
import { layoutGallery, metricsFor, type GalleryLayout, type GallerySection } from './gallery-layout';
import { MediaTile } from './media-tile';

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Keeps what's on screen in place when sections above it change height (a month finishing
 * loading, or a resize): finds the section at the top of the viewport before and after.
 */
function useScrollAnchor(layout: GalleryLayout | null, scrollMargin: number) {
  const previous = useRef<GalleryLayout | null>(null);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = layout;
    if (!before || !layout) return;
    const viewportTop = window.scrollY - scrollMargin;
    if (viewportTop <= 0) return;
    const anchor = before.sections.find(
      (section) => viewportTop >= section.top && viewportTop < section.top + section.height,
    );
    const now = anchor && layout.sections.find((section) => section.key === anchor.key);
    if (!anchor || !now) return;
    const within =
      anchor.height === now.height
        ? viewportTop - anchor.top
        : ((viewportTop - anchor.top) / anchor.height) * now.height;
    const target = now.top + within;
    if (Math.abs(target - viewportTop) > 1)
      window.scrollTo({ top: target + scrollMargin, behavior: 'instant' });
  }, [layout, scrollMargin]);
}

export interface VirtualGalleryProps {
  sections: GallerySection[];
  onOpen: (id: string) => void;
  /** Sections whose placeholders are on or near the screen and should be fetched. */
  onNeedSections?: (keys: string[]) => void;
  /** The end of the list is near: load the next page. */
  onEndReached?: () => void;
  /** Gives the parent the layout, e.g. for a scrubber. */
  onLayout?: (layout: GalleryLayout, scrollMargin: number) => void;
  className?: string;
  footer?: ReactNode;
}

export function VirtualGallery({
  sections,
  onOpen,
  onNeedSections,
  onEndReached,
  onLayout,
  className,
  footer,
}: VirtualGalleryProps) {
  const [containerRef, width] = useWidth<HTMLDivElement>();
  const [scrollMargin, setScrollMargin] = useState(0);
  const layout = useMemo(
    () => (width > 0 ? layoutGallery(sections, metricsFor(width)) : null),
    [sections, width],
  );
  const blocks = useMemo(() => layout?.blocks ?? [], [layout]);

  // Where the gallery starts on the page; content above it (e.g. "On this day") can load later.
  useLayoutEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const measure = () => {
      const offset = Math.round(element.getBoundingClientRect().top + window.scrollY);
      setScrollMargin((current) => (current === offset ? current : offset));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [containerRef]);

  const virtualizer = useWindowVirtualizer({
    count: blocks.length,
    estimateSize: (index) => blocks[index]!.height,
    getItemKey: (index) => blocks[index]!.key,
    overscan: 6,
    scrollMargin,
  });

  // Heights are computed, so re-read them all whenever the layout changes.
  useLayoutEffect(() => virtualizer.measure(), [virtualizer, blocks]);
  useScrollAnchor(layout, scrollMargin);
  useEffect(() => {
    if (layout) onLayout?.(layout, scrollMargin);
  }, [layout, scrollMargin, onLayout]);

  const items = virtualizer.getVirtualItems();
  const first = items[0]?.index ?? 0;
  const last = items.at(-1)?.index ?? -1;

  useEffect(() => {
    if (!onNeedSections || last < 0) return;
    const wanted = new Set<string>();
    // Look a little further than what's rendered, so scrolling rarely meets a placeholder.
    for (let index = Math.max(0, first - 4); index <= Math.min(blocks.length - 1, last + 4); index += 1) {
      const block = blocks[index]!;
      if (block.kind === 'placeholder') wanted.add(block.section);
    }
    if (wanted.size) onNeedSections([...wanted]);
  }, [first, last, blocks, onNeedSections]);

  useEffect(() => {
    if (onEndReached && last >= 0 && last >= blocks.length - 3) onEndReached();
  }, [last, blocks.length, onEndReached]);

  return (
    <div ref={containerRef} className={cn('relative w-full', className)}>
      <div style={{ height: layout?.height ?? 0 }} className="relative w-full">
        {items.map((item) => {
          const block = blocks[item.index]!;
          const style = {
            position: 'absolute' as const,
            top: 0,
            left: 0,
            width: '100%',
            height: block.height,
            transform: `translateY(${item.start - scrollMargin}px)`,
          };
          switch (block.kind) {
            case 'section':
              return (
                <div key={item.key} style={style} className="flex items-end pb-3">
                  <h2 className="text-lg font-semibold tracking-tight">{block.title}</h2>
                </div>
              );
            case 'day':
              return (
                <div key={item.key} style={style} className="flex items-center">
                  <h3 className="text-sm font-medium text-ink-muted">{formatDay(block.day)}</h3>
                </div>
              );
            case 'row':
              return (
                <div key={item.key} style={style}>
                  {block.items.map((cell) => (
                    <MediaTile
                      key={cell.tile.id}
                      tile={cell.tile}
                      width={cell.width}
                      height={block.tileHeight}
                      onOpen={onOpen}
                      className="absolute top-0"
                      style={{ left: cell.left }}
                    />
                  ))}
                </div>
              );
            case 'packed':
              return (
                <div key={item.key} style={style}>
                  {block.segments.map((segment) => (
                    <div key={segment.day} className="absolute top-0 h-full" style={{ left: segment.left }}>
                      <h3 className="flex h-8 items-center text-sm font-medium whitespace-nowrap text-ink-muted sm:h-10">
                        {formatDay(segment.day)}
                      </h3>
                      <div className="relative" style={{ height: block.tileHeight }}>
                        {segment.items.map((cell) => (
                          <MediaTile
                            key={cell.tile.id}
                            tile={cell.tile}
                            width={cell.width}
                            height={block.tileHeight}
                            onOpen={onOpen}
                            className="absolute top-0"
                            style={{ left: cell.left }}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              );
            case 'placeholder':
              return (
                <div key={item.key} style={style} aria-hidden="true" className="overflow-hidden">
                  <Skeleton className="h-full w-full rounded-none opacity-60" />
                </div>
              );
          }
        })}
      </div>
      {footer}
    </div>
  );
}
