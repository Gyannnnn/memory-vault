'use client';

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from 'react';

const MAX_SCALE = 5;
const SWIPE_DISTANCE = 80;

export interface ZoomControls {
  /** +1 zooms in, -1 out, 0 back to fit. */
  zoom(step: -1 | 0 | 1): void;
}

interface Transform {
  scale: number;
  x: number;
  y: number;
}

/**
 * Pan and zoom for one photo, plus swipe to move between photos.
 * Wheel or pinch zooms around the pointer; double-click toggles 2.5×; drag pans while zoomed;
 * a horizontal swipe at 1× moves to the neighbour and a downward swipe closes.
 */
export function ZoomStage({
  children,
  aspect,
  onSwipe,
  onSwipeDown,
  onZoomChange,
  controls,
}: {
  children: ReactNode;
  /** Width / height of what is shown; it is fitted inside the stage. */
  aspect: number;
  onSwipe: (direction: 'previous' | 'next') => void;
  onSwipeDown: () => void;
  onZoomChange?: (scale: number) => void;
  /** For zoom buttons and keys outside the stage. */
  controls?: Ref<ZoomControls>;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [transform, setTransformState] = useState<Transform>({ scale: 1, x: 0, y: 0 });
  const [animate, setAnimate] = useState(false);
  const [swipe, setSwipe] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{
    startX: number;
    startY: number;
    startTransform: Transform;
    pinchDistance?: number;
  } | null>(null);
  const transformRef = useRef(transform);
  /** Updates the ref at once, so several wheel events before the next render build on each other. */
  const setTransform = (next: Transform) => {
    transformRef.current = next;
    setTransformState(next);
  };
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const observer = new ResizeObserver(([entry]) =>
      setStageSize({ width: entry!.contentRect.width, height: entry!.contentRect.height }),
    );
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  const fittedWidth = Math.min(stageSize.width, stageSize.height * aspect);
  const fitted = { width: fittedWidth, height: fittedWidth / aspect };

  const clamp = (next: Transform): Transform => {
    const stage = stageRef.current;
    const content = contentRef.current;
    if (!stage || !content) return next;
    const scale = Math.min(MAX_SCALE, Math.max(1, next.scale));
    if (scale === 1) return { scale: 1, x: 0, y: 0 };
    const maxX = Math.max(0, (content.offsetWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (content.offsetHeight * scale - stage.clientHeight) / 2);
    return { scale, x: Math.min(maxX, Math.max(-maxX, next.x)), y: Math.min(maxY, Math.max(-maxY, next.y)) };
  };

  /** Zoom so the point under (clientX, clientY) stays under it. */
  const zoomAt = (scale: number, clientX?: number, clientY?: number) => {
    const stage = stageRef.current!;
    const rect = stage.getBoundingClientRect();
    const current = transformRef.current;
    const px = (clientX ?? rect.left + rect.width / 2) - (rect.left + rect.width / 2);
    const py = (clientY ?? rect.top + rect.height / 2) - (rect.top + rect.height / 2);
    const ratio = Math.min(MAX_SCALE, Math.max(1, scale)) / current.scale;
    setTransform(clamp({ scale, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio }));
  };

  useEffect(() => onZoomChange?.(transform.scale), [transform.scale, onZoomChange]);

  useImperativeHandle(controls, () => ({
    zoom(step) {
      setAnimate(true);
      const scale = transformRef.current.scale;
      if (step === 0) setTransform({ scale: 1, x: 0, y: 0 });
      else zoomAt(step > 0 ? scale * 1.6 : scale / 1.6);
    },
  }));

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setAnimate(false);
      zoomAt(transformRef.current.scale * Math.exp(-event.deltaY * 0.002), event.clientX, event.clientY);
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- zoomAt reads refs only
  }, []);

  const onPointerDown = (event: ReactPointerEvent) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    setAnimate(false);
    const [a, b] = [...pointers.current.values()];
    gesture.current = {
      startX: event.clientX,
      startY: event.clientY,
      startTransform: transformRef.current,
      ...(a && b ? { pinchDistance: Math.hypot(a.x - b.x, a.y - b.y) } : {}),
    };
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const start = gesture.current;
    const [a, b] = [...pointers.current.values()];
    if (a && b && start.pinchDistance) {
      const scale = start.startTransform.scale * (Math.hypot(a.x - b.x, a.y - b.y) / start.pinchDistance);
      zoomAt(scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const dx = event.clientX - start.startX;
    const dy = event.clientY - start.startY;
    if (start.startTransform.scale > 1) {
      setTransform(
        clamp({ ...start.startTransform, x: start.startTransform.x + dx, y: start.startTransform.y + dy }),
      );
    } else if (event.pointerType !== 'mouse' || event.buttons === 1) {
      setSwipe(Math.abs(dx) > Math.abs(dy) ? { x: dx, y: 0 } : { x: 0, y: Math.max(0, dy) });
    }
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size > 0) return;
    gesture.current = null;
    setAnimate(true);
    if (swipe.x <= -SWIPE_DISTANCE) onSwipe('next');
    else if (swipe.x >= SWIPE_DISTANCE) onSwipe('previous');
    else if (swipe.y >= SWIPE_DISTANCE * 1.5) onSwipeDown();
    setSwipe({ x: 0, y: 0 });
  };

  const onDoubleClick = (event: React.MouseEvent) => {
    setAnimate(true);
    if (transformRef.current.scale > 1) setTransform({ scale: 1, x: 0, y: 0 });
    else zoomAt(2.5, event.clientX, event.clientY);
  };

  const zoomed = transform.scale > 1;
  return (
    <div
      ref={stageRef}
      className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden select-none"
      style={{ cursor: zoomed ? 'grab' : 'zoom-in' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <div
        ref={contentRef}
        className="shrink-0 will-change-transform"
        style={{
          width: fitted.width,
          height: fitted.height,
          transform: `translate(${transform.x + swipe.x}px, ${transform.y + swipe.y}px) scale(${transform.scale})`,
          opacity: swipe.y ? Math.max(0.4, 1 - swipe.y / 400) : 1,
          transition: animate ? 'transform var(--duration-base) var(--ease-standard)' : 'none',
        }}
      >
        {children}
      </div>
    </div>
  );
}
