'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export interface Selection {
  selected: ReadonlySet<string>;
  /** Something is selected: clicking a tile now selects instead of opening it. */
  active: boolean;
  isSelected: (id: string) => boolean;
  /** `range`: also select everything between the last tile picked and this one (shift-click). */
  toggle: (id: string, options?: { range?: boolean }) => void;
  clear: () => void;
}

const SelectionContext = createContext<Selection | null>(null);

/** Null outside a selectable grid: tiles then only open. */
export const useSelection = () => useContext(SelectionContext);

/**
 * Selection for a grid of tiles. `order` is the order they're shown in, for shift-click
 * ranges. Esc clears the selection unless a dialog (such as the viewer) is open.
 */
export function SelectionProvider({ order, children }: { order: string[]; children: ReactNode }) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const anchor = useRef<string | null>(null);

  const toggle = useCallback(
    (id: string, options: { range?: boolean } = {}) => {
      const from = anchor.current ? order.indexOf(anchor.current) : -1;
      const to = order.indexOf(id);
      setSelected((current) => {
        const next = new Set(current);
        if (options.range && from >= 0 && to >= 0) {
          for (let index = Math.min(from, to); index <= Math.max(from, to); index += 1)
            next.add(order[index]!);
        } else if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      anchor.current = id;
    },
    [order],
  );

  const clear = useCallback(() => {
    anchor.current = null;
    setSelected(new Set());
  }, []);

  useEffect(() => {
    if (selected.size === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || document.querySelector('[role=dialog]')) return;
      event.preventDefault();
      clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected.size, clear]);

  const value = useMemo<Selection>(
    () => ({ selected, active: selected.size > 0, isSelected: (id) => selected.has(id), toggle, clear }),
    [selected, toggle, clear],
  );
  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>;
}
