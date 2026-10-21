// The one place the Home Connect limits are defined: src/lib/api-limits.json (the inventory run counts every call
// against it). The path resolves to the same file from src/lib and from build/lib — esbuild copies no JSON, so the
// built module requires it at run time, where the inventory run's pacing hook widens it (test/inventory-pacing-hook.cjs).
import declared from "../../src/lib/api-limits.json";

/**
 * The calls Home Connect allows within `seconds`, as src/lib/api-limits.json declares them: the strictest entry of
 * that window — the documented average stands next to the burst in the same window.
 *
 * @param seconds the window of the limit
 * @returns the number of calls allowed in that window
 */
export function declaredLimit(seconds: number): number {
  const allowed = declared.counterparts.flatMap(counterpart =>
    counterpart.limits.filter(limit => limit.seconds === seconds).map(limit => limit.max),
  );
  if (allowed.length === 0) {
    throw new Error(`src/lib/api-limits.json declares no limit for ${seconds} s`);
  }
  return Math.min(...allowed);
}

/**
 * The least spacing between two calls: the shortest declared window divided by its strictest limit — 10 calls per
 * second are 100 ms. Exact, without a reserve: the transport stamps a call after it went out, never before.
 *
 * @returns milliseconds between two calls
 */
export function minimumGapMs(): number {
  const shortest = Math.min(...declared.counterparts.flatMap(counterpart => counterpart.limits.map(l => l.seconds)));
  return Math.ceil((shortest * 1000) / declaredLimit(shortest));
}
