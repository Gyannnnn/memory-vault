'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { formatMonth, formatShortMonth } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { GalleryLayout } from '../media/gallery-layout';

interface Props {
  layout: GalleryLayout;
  scrollMargin: number;
}

/**
 * The timeline's scroll bar: years at their position in the library; drag, click or use the
 * keyboard (it is a slider: arrows step a month, Page Up/Down a year) to jump through time.
 */
export function TimelineScrubber({ layout, scrollMargin }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [trackHeight, setTrackHeight] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);

  const total = Math.max(1, layout.height);
  const sections = layout.sections;

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer = new ResizeObserver(([entry]) => {
      setTrackHeight(entry!.contentRect.height);
      setViewportHeight(window.innerHeight);
    });
    observer.observe(track);
    const onScroll = () => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => setScrollTop(Math.max(0, window.scrollY - scrollMargin)));
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(frame.current);
    };
  }, [scrollMargin]);

  const sectionAt = useCallback(
    (offset: number) =>
      Math.max(
        0,
        sections.findLastIndex((section) => section.top <= offset),
      ),
    [sections],
  );
  const currentIndex = sectionAt(scrollTop + 1);
  const current = sections[currentIndex];

  const scrollToOffset = (offset: number) =>
    window.scrollTo({ top: Math.max(0, Math.min(offset, total)) + scrollMargin, behavior: 'instant' });
  const scrollToSection = (index: number) => {
    const target = sections[Math.max(0, Math.min(sections.length - 1, index))];
    if (target) scrollToOffset(target.top);
  };

  const offsetFromPointer = (event: PointerEvent) => {
    const rect = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) * total;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    scrollToOffset(offsetFromPointer(event));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const offset = offsetFromPointer(event);
    setHover(offset);
    if (dragging) scrollToOffset(offset);
  };
  const stopDragging = () => setDragging(false);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const yearOf = (index: number) => sections[index]?.key.slice(0, 4);
    const steps: Record<string, () => number> = {
      ArrowDown: () => currentIndex + 1,
      ArrowUp: () => currentIndex - 1,
      PageDown: () => {
        const year = yearOf(currentIndex);
        const next = sections.findIndex(
          (section, index) => index > currentIndex && section.key.slice(0, 4) !== year,
        );
        return next < 0 ? sections.length - 1 : next;
      },
      PageUp: () => {
        const year = yearOf(currentIndex);
        let index = currentIndex - 1;
        while (index > 0 && yearOf(index) === year) index -= 1;
        const previousYear = yearOf(index);
        while (index > 0 && yearOf(index - 1) === previousYear) index -= 1;
        return index;
      },
      Home: () => 0,
      End: () => sections.length - 1,
    };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault();
    scrollToSection(step());
  };

  // One label per year, at its newest month, skipping labels that would overlap.
  const years: { year: string; y: number }[] = [];
  for (const section of sections) {
    const year = section.key.slice(0, 4);
    if (years.at(-1)?.year === year) continue;
    const y = Math.min(trackHeight - 8, Math.max(8, (section.top / total) * trackHeight));
    if (years.length && y - years.at(-1)!.y < 18) continue;
    years.push({ year, y });
  }

  const indicatorY = (scrollTop / total) * trackHeight;
  const thumbHeight = Math.max(24, (viewportHeight / total) * trackHeight);
  const hoverSection = hover === null ? null : sections[sectionAt(hover)];
  const bubble = dragging ? current : hoverSection;
  const bubbleY = dragging
    ? indicatorY + thumbHeight / 2
    : hover === null
      ? 0
      : (hover / total) * trackHeight;

  if (sections.length < 2) return null;

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label="Jump to a month"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={sections.length - 1}
      aria-valuenow={currentIndex}
      aria-valuetext={current ? formatMonth(current.key) : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onPointerLeave={() => !dragging && setHover(null)}
      onKeyDown={onKeyDown}
      className={cn(
        'group/scrubber fixed top-28 right-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-20 w-11 cursor-ns-resize touch-none select-none outline-none sm:w-14 md:top-4 md:bottom-4',
        'focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-inset',
      )}
    >
      {years.map(({ year, y }) => (
        <span
          key={year}
          aria-hidden="true"
          className="absolute right-4 -translate-y-1/2 text-xs font-medium text-ink-subtle tabular-nums sm:right-5"
          style={{ top: y }}
        >
          {year}
        </span>
      ))}
      <span
        aria-hidden="true"
        className={cn(
          'absolute right-1 w-1 origin-right rounded-full bg-ink-subtle transition-[transform,background-color] duration-(--duration-fast)',
          'group-hover/scrubber:scale-x-150 group-hover/scrubber:bg-ink',
          dragging && 'scale-x-150 bg-ink',
        )}
        style={{ top: indicatorY, height: thumbHeight }}
      />
      {bubble && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-12 -translate-y-1/2 rounded-md bg-primary px-2.5 py-1 text-xs font-medium whitespace-nowrap text-on-primary shadow-md sm:right-16"
          style={{ top: bubbleY }}
        >
          {formatShortMonth(bubble.key)}
        </span>
      )}
    </div>
  );
}
