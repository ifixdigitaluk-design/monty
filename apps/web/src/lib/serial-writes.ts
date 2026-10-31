'use client';

import { useCallback, useRef } from 'react';

/**
 * Runs writes for the same record one after another.
 * Without this, two quick edits (e.g. owner then date) would both send the same
 * `expectedVersion` and the second would be rejected as a false conflict.
 */
export function useSerialWrites() {
  const chains = useRef(new Map<string, Promise<unknown>>());
  return useCallback(<T,>(key: string, fn: () => Promise<T>): Promise<T> => {
    const prev = chains.current.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    chains.current.set(key, next);
    void next.finally(() => {
      if (chains.current.get(key) === next) chains.current.delete(key);
    }).catch(() => undefined);
    return next;
  }, []);
}
