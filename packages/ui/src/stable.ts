import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * A function that keeps one identity for the life of the component and
 * always runs the latest one it was given: for a handler passed to a
 * memoised child, which would otherwise redraw on every new closure.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  const latest = useRef(fn);
  useLayoutEffect(() => {
    latest.current = fn;
  });
  return useCallback((...args: A) => latest.current(...args), []);
}
