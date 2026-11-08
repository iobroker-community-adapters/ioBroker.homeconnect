// The one place the Home Connect limits are defined: src/lib/api-limits.json (the inventory run counts every call
// against it). The path resolves to the same file from src/lib and from build/lib — esbuild copies no JSON, so the
// built module requires it at run time, where the inventory run's hooks change it as it loads: the pacing hook widens
// it (test/inventory-pacing-hook.cjs), the press hook of the fleet suites lowers a window (test/press-hook.js).
import declared from "../../src/lib/api-limits.json";

/** One limit of a counterpart: at most `max` calls within `seconds`, or open at once (`concurrent`). */
export interface DeclaredLimit {
  /** The calls allowed. */
  max: number;
  /** The window in seconds — absent for a limit on the calls open at once. */
  seconds?: number;
  /** Counts the calls open at the same time, from their send until they ended. */
  concurrent?: boolean;
  /** Counts only the calls answered with an error (status 400 and up). */
  errors?: boolean;
  /** The lane a call counts in: the whole account, its host, or its device (the named group `device`). */
  per: string;
  /** Where the number comes from. */
  source: string;
}

/** One counterpart of the declaration: the calls `match` fits, and the limits they count against. */
export interface Counterpart {
  /** The counterpart's name. */
  name: string;
  /** Every field must fit: `host`, `method`, `pathPattern` (the path without the query), `bodyPattern`. */
  match: Readonly<Partial<Record<string, string | number>>>;
  /** The limits of the counterpart. */
  limits: readonly DeclaredLimit[];
}

/** One call as the limits see it — what the network hook of the inventory run notes of an HTTP request. */
export interface LimitedCall {
  /** The host it goes to. */
  host: string;
  /** The HTTP method. */
  method: string;
  /** The path, with or without the query (the query never counts). */
  path: string;
  /** The body as it goes out, when it has one. */
  body?: string;
}

/**
 * Every counterpart of the declaration, as the adapter process loaded it.
 *
 * @returns the counterparts
 */
export function counterparts(): readonly Counterpart[] {
  const table: { counterparts: readonly Counterpart[] } = declared;
  return table.counterparts;
}

/**
 * Whether a call belongs to a counterpart — every field of `match` must fit, exactly as the fleet suites judge it
 * (test/fleet-suites.js `fits`): `hostPattern`, `pathPattern` and `bodyPattern` are regular expressions (the path
 * without its query, the first 1024 characters of the body), every other field must be equal.
 *
 * @param call the call
 * @param match the counterpart's match
 * @returns whether it fits
 */
export function fits(call: LimitedCall, match: Counterpart["match"]): boolean {
  return Object.entries(match).every(([key, value]) => {
    if (value === undefined) {
      return true;
    }
    if (key === "hostPattern") {
      return new RegExp(String(value)).test(call.host);
    }
    if (key === "pathPattern") {
      return new RegExp(String(value)).test(call.path.split("?")[0]);
    }
    if (key === "bodyPattern") {
      return call.body !== undefined && new RegExp(String(value)).test(call.body.slice(0, 1024));
    }
    return (call as unknown as Record<string, unknown>)[key] === value;
  });
}

/**
 * The window a limit counts in, as the fleet suites name it (test/fleet-suites.js `limitKey`): its `seconds`,
 * "<seconds> errors" for the calls answered with an error, or "concurrent" for the calls open at once.
 *
 * @param limit the limit
 * @returns the window's key
 */
export function limitKey(limit: DeclaredLimit): string {
  if (limit.concurrent === true) {
    return "concurrent";
  }
  return limit.errors === true ? `${limit.seconds} errors` : String(limit.seconds);
}

/**
 * The calls a call of this kind may make within `seconds`: the strictest entry of that window over every counterpart
 * the call fits — the documented average stands next to the burst in the same window.
 *
 * @param call the call
 * @param seconds the window of the limit
 * @returns the number of calls allowed in that window
 */
export function limitFor(call: LimitedCall, seconds: number): number {
  const allowed = counterparts()
    .filter(c => fits(call, c.match))
    .flatMap(c => c.limits.filter(l => l.seconds === seconds && l.concurrent !== true && l.errors !== true))
    .map(l => l.max);
  if (allowed.length === 0) {
    throw new Error(`src/lib/api-limits.json declares no limit for ${call.method} ${call.path} in ${seconds} s`);
  }
  return Math.min(...allowed);
}
