// The one place the Home Connect limits are defined: src/lib/api-limits.json (the inventory run counts every call
// against it). The path resolves to the same file from src/lib and from build/lib — esbuild copies no JSON.
import declared from "../../src/lib/api-limits.json";

/**
 * The calls Home Connect allows within `seconds`, as src/lib/api-limits.json declares them.
 *
 * @param seconds the window of the limit
 * @returns the number of calls allowed in that window
 */
export function declaredLimit(seconds: number): number {
  for (const counterpart of declared.counterparts) {
    for (const limit of counterpart.limits) {
      if (limit.seconds === seconds) {
        return limit.max;
      }
    }
  }
  throw new Error(`src/lib/api-limits.json declares no limit for ${seconds} s`);
}
