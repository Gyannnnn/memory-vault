/** Runs `worker` over `items` with bounded concurrency, stopping new work once `signal` aborts. */
export async function runPool<T>(
  items: Iterable<T>,
  concurrency: number,
  worker: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const iterator = items[Symbol.iterator]();
  const errors: unknown[] = [];

  async function lane(): Promise<void> {
    for (;;) {
      if (signal?.aborted) return;
      const next = iterator.next();
      if (next.done) return;
      try {
        await worker(next.value);
      } catch (error) {
        errors.push(error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, lane));
  if (errors.length > 0) throw new AggregateError(errors, `${errors.length} task(s) failed`);
}

export function interruptSignal(onFirst: () => void): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const handler = () => {
    if (controller.signal.aborted) process.exit(130);
    controller.abort();
    onFirst();
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    },
  };
}
