// Command dispatch — the pure mapping from an ioBroker state write to the Home
// Connect REST call that carries it out. No adapter instance, no I/O: a context
// object in, a request (or null) out. Kept separate so the write routing is
// unit-testable like oauth / http / value-transformer / sse-parser.

import { shortEnum, shortEnumIn } from "./value-transformer";

/** The context of a single writable-state change, gathered by the adapter from the state + its object. */
export interface WriteContext {
  /** The appliance's haId. */
  haId: string;
  /** The state's channel (settings / commands / programs). */
  channel: string;
  /** The within-channel state id (e.g. "powerState", "selectedProgram", "start"). */
  id: string;
  /** The BSH key stored in the state's native (settings / commands / selectedProgram). */
  bshKey?: string;
  /** The full BSH candidate values stored in native, for resolving a short enum write back. */
  bshValues?: string[];
  /**
   * The candidates are ONE value set spread over several value families (an
   * option shared by two appliance families under one id): a short value that
   * matches more than one of them means the same thing — take the first.
   */
  collapseEnum?: boolean;
  /** The written value. */
  value: ioBroker.StateValue;
  /** The full BSH key of the currently selected program — the payload of the "start" button. */
  selectedProgramKey?: string;
  /** The resolved option values to send with a program start (empty/absent = start with defaults). */
  selectedOptions?: Array<{ key: string; value: ioBroker.StateValue }>;
}

/** A resolved Home Connect write. `body` is the inner `data` object; the HTTP layer wraps it as `{ data }`. */
export interface WriteRequest {
  /** The HTTP method. */
  method: "PUT" | "DELETE";
  /** The endpoint path. */
  path: string;
  /** The request body (omitted for DELETE). */
  body?: {
    key: string;
    value?: ioBroker.StateValue;
    options?: Array<{ key: string; value: ioBroker.StateValue }>;
  };
}

/**
 * Resolve a writable-state change into the Home Connect request that performs it,
 * or null when the write should be ignored: an unknown enum value, a button set to
 * false, a start with no program selected, or an unrecognized state.
 *
 * @param ctx the change context
 * @returns the request to send, or null to ignore the write
 */
export function resolveWrite(ctx: WriteContext): WriteRequest | null {
  // Path segments come from stored cloud data (haId, BSH keys) — encoding them is
  // a free hardening against a malformed native ever bending the request path.
  const base = `/api/homeappliances/${encodeURIComponent(ctx.haId)}`;
  const key = ctx.bshKey === undefined ? undefined : encodeURIComponent(ctx.bshKey);

  if (ctx.channel === "settings" && ctx.bshKey) {
    const value = resolveValue(ctx.value, ctx.bshValues, ctx.collapseEnum);
    if (value === undefined) {
      return null;
    }
    return { method: "PUT", path: `${base}/settings/${key}`, body: { key: ctx.bshKey, value } };
  }

  if (ctx.channel === "commands" && ctx.bshKey) {
    // Commands are momentary: only a true write fires one, a false is a no-op.
    return ctx.value === true
      ? { method: "PUT", path: `${base}/commands/${key}`, body: { key: ctx.bshKey, value: true } }
      : null;
  }

  // A program option → set it on the selected program (the one you configure before
  // a start). Writing to the active program is state-gated by the appliance and 409s
  // in most states, so a single predictable target is correct for v1.
  if (ctx.channel === "options" && ctx.bshKey) {
    const value = resolveValue(ctx.value, ctx.bshValues, ctx.collapseEnum);
    if (value === undefined) {
      return null;
    }
    return { method: "PUT", path: `${base}/programs/selected/options/${key}`, body: { key: ctx.bshKey, value } };
  }

  if (ctx.channel === "programs") {
    if (ctx.id === "selectedProgram" && ctx.bshKey) {
      const key = resolveEnum(ctx.value, ctx.bshValues);
      return key ? { method: "PUT", path: `${base}/programs/selected`, body: { key } } : null;
    }
    if (ctx.id === "start" && ctx.value === true) {
      if (!ctx.selectedProgramKey) {
        return null;
      }
      const body: NonNullable<WriteRequest["body"]> = { key: ctx.selectedProgramKey };
      if (ctx.selectedOptions && ctx.selectedOptions.length > 0) {
        body.options = ctx.selectedOptions;
      }
      return { method: "PUT", path: `${base}/programs/active`, body };
    }
    if (ctx.id === "stop" && ctx.value === true) {
      return { method: "DELETE", path: `${base}/programs/active` };
    }
  }

  return null;
}

/**
 * Resolve a written value to what the API expects: for an enum (candidates present),
 * map the short value back to its full BSH value; otherwise pass the value through
 * (booleans and numbers go as-is).
 *
 * @param value the written value
 * @param bshValues the full candidate values, if this is an enum
 * @param collapse whether several matching candidates mean the same thing
 * @returns the API value, or undefined to ignore the write (unknown enum value)
 */
function resolveValue(
  value: ioBroker.StateValue,
  bshValues?: string[],
  collapse = false,
): ioBroker.StateValue | undefined {
  if (bshValues && bshValues.length > 0) {
    return resolveEnum(value, bshValues, collapse);
  }
  return value;
}

/**
 * Map a short enum value back to its full BSH value (e.g. "on" → "…PowerState.On").
 * Case does not matter, and the full BSH value is accepted too: a script that
 * writes "On" or "BSH.Common.EnumType.PowerState.On" means the same thing, and
 * refusing it (on debug, invisible) looked like the adapter had done nothing.
 *
 * Resolution order: the full value; the list-unique short value
 * ({@link shortEnumIn} — what the dropdown offers); the bare last segment, but
 * only when it names exactly one candidate. Two programs ending in the same
 * segment are different programs — the bare segment then names neither, and
 * {@link ambiguousCandidates} tells the user which full keys to use.
 *
 * @param value the short value written to the state
 * @param bshValues the full candidate values
 * @param collapse whether several candidates matching the bare segment mean the same thing (take the first)
 * @returns the matching full value, or undefined if none matches
 */
export function resolveEnum(value: ioBroker.StateValue, bshValues?: string[], collapse = false): string | undefined {
  if (typeof value !== "string" || !bshValues || bshValues.length === 0) {
    return undefined;
  }
  const wanted = value.toLowerCase();
  const full = bshValues.find(v => v.toLowerCase() === wanted);
  if (full) {
    return full;
  }
  const listed = bshValues.find(v => shortEnumIn(v, bshValues) === wanted);
  if (listed) {
    return listed;
  }
  // The two-segment form a program has in a list that also holds programs the
  // appliance only ran (the dropdown makes its short values unique across that
  // whole list, the write candidates are the cloud's offer alone).
  const twoSegments = bshValues.filter(v => v.split(".").slice(-2).join(".").toLowerCase() === wanted);
  if (twoSegments.length === 1) {
    return twoSegments[0];
  }
  const bySegment = bshValues.filter(v => shortEnum(v) === wanted);
  return bySegment.length === 1 || (collapse && bySegment.length > 1) ? bySegment[0] : undefined;
}

/**
 * The candidates a bare short value would match more than once — for telling the
 * user which full keys to write instead. Empty when the value is unambiguous.
 *
 * @param value the written value
 * @param bshValues the full candidate values
 * @returns the full values sharing that last segment (none, or two and more)
 */
export function ambiguousCandidates(value: ioBroker.StateValue, bshValues?: string[]): string[] {
  if (typeof value !== "string" || !bshValues) {
    return [];
  }
  const wanted = value.toLowerCase();
  const hits = bshValues.filter(v => shortEnum(v) === wanted);
  return hits.length > 1 ? hits : [];
}
