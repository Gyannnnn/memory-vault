import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

/** False during server rendering and hydration, true afterwards: for browser-only UI. */
export const useMounted = () =>
  useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
