// Small pure helpers, isolated so they can be unit-tested without an adapter.

/**
 * Turn a source string (a model code, or a name) into an id-safe path segment —
 * or nothing, when not a single letter or digit is left.
 * "SX87TX02CE/60" → "sx87tx02ce-60", "Kühl-Gefrier-Kombination" → "kuehl-gefrier-kombination".
 * German umlauts are transliterated, all other accented letters lose their
 * diacritics (Unicode decomposition); anything else non-alphanumeric becomes a hyphen.
 *
 * @param name the source text (may be empty)
 * @returns a lower-case id-safe slug, possibly empty
 */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One readable line for anything a `catch` receives — never `[object Object]`, never without the reason.
 * The fleet master form (Entwicklung/CLAUDE_PATTERNS.md § Async-Handler, workshop eba9680), unchanged
 * but for its name; the admin panel imports it from here.
 *
 * @param err the caught value
 * @returns the text
 */
export function errMessage(err: unknown): string {
  // It runs inside a `catch` and must not throw there: any property of a caught value can be a
  // getter that throws, or hold something other than a string.
  try {
    if (err instanceof Error) {
      // An empty message carries its reason in `code`: `http.get`/`net.connect` to `localhost`
      // reject with an AggregateError (message "", code ECONNREFUSED).
      const code = "code" in err ? err.code : undefined;
      const message: unknown = err.message;
      const name: unknown = err.name;
      const text = String(message || (typeof code === "string" ? code : name));
      // `fetch` rejects with TypeError("fetch failed", { cause }) — ENOTFOUND, ECONNREFUSED,
      // "other side closed" live only in the cause. One level, never the chain (`e.cause = e` is legal).
      const cause = err.cause;
      let reason = "";
      if (cause instanceof Error) {
        const causeCode = "code" in cause ? cause.code : undefined;
        const causeMessage: unknown = cause.message;
        reason =
          (typeof causeMessage === "string" ? causeMessage : "") || (typeof causeCode === "string" ? causeCode : "");
      } else if (cause !== undefined && cause !== null) {
        reason = errMessage(cause);
      }
      // A wrapper that copies its cause's message would say it twice.
      return reason && !text.includes(reason) ? `${text} (${reason})` : text;
    }
    if (typeof err === "string") {
      return err;
    }
    if (typeof err === "function") {
      // A thrown function or class: `String()` would print its whole source text.
      return Object.prototype.toString.call(err);
    }
    if (err === null || err === undefined || typeof err !== "object") {
      return String(err); // number, boolean, bigint, symbol (`${symbol}` would throw)
    }
    // A thrown object ({ code: "ECONNRESET" }, an HTTP client's error object): JSON.stringify
    // yields `undefined` for what it cannot render and throws on a circular structure.
    return JSON.stringify(err) ?? Object.prototype.toString.call(err);
  } catch {
    // A getter that threw, a circular structure for JSON.stringify: the type tag.
    return Object.prototype.toString.call(err);
  }
}

// ─── API-boundary type-guards (shared; external data is `unknown`) ────────────

/**
 * Type guard for a plain (non-array) object.
 *
 * @param v the value to test
 * @returns whether v is a record
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A number, or undefined for anything else.
 *
 * @param v the value to test
 * @returns the number, or undefined
 */
export function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/**
 * The string elements of an array, or undefined for a non-array.
 *
 * @param v the value to test
 * @returns the string array, or undefined
 */
export function stringArrayOrUndef(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

// ─── cloud text → object names / log lines ───────────────────────────────────

/** Longest label the adapter puts into an object name or a log line. */
const MAX_LABEL_LENGTH = 200;

/**
 * Make a cloud-provided display string safe for an object name or a log line:
 * control characters (line breaks, tabs, …) become spaces, runs of whitespace
 * collapse, the result is trimmed and capped. Cloud text is trusted CONTENT,
 * not trusted FORMAT — a line break inside an appliance name would split a log
 * line and put a two-line label into the object tree.
 *
 * @param raw the value off the wire (anything; only a string is used)
 * @param fallback what to return when nothing usable remains
 * @returns the cleaned label, or the fallback
 */
export function cleanLabel(raw: unknown, fallback = ""): string {
  if (typeof raw !== "string") {
    return fallback;
  }
  const cleaned = raw
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) {
    return fallback;
  }
  return cleaned.length > MAX_LABEL_LENGTH ? `${cleaned.slice(0, MAX_LABEL_LENGTH - 1)}…` : cleaned;
}

/**
 * A readable English label from a camelCase state id, for a datapoint whose
 * localized name the cloud has not delivered (yet): "operationState" →
 * "Operation state", "doorFreezerOpen" → "Door freezer open",
 * "favorite001ExternalTrigger" → "Favorite 001 external trigger".
 *
 * @param id the camelCase state id
 * @returns the sentence-case label, or the id itself when it has no letters
 */
export function humanizeId(id: string): string {
  // A single lowercase letter directly in front of a capitalised word is a brand
  // spelling, not a word of its own: "iDos1Active" reads "iDos 1 active", never
  // "I dos 1 active". Only that shape is protected — "doorOpen" is untouched.
  const brand = /^([a-z][A-Z][a-z]+)/.exec(id);
  const head = brand ? brand[1] : "";
  const words = (head ? id.slice(head.length) : id)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(w => w.length > 0);
  if (words.length === 0) {
    return head.length > 0 ? head : id;
  }
  const text = words.map(w => w.toLowerCase()).join(" ");
  return head.length > 0 ? `${head} ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

// ─── user writes → the state's declared type ─────────────────────────────────

/**
 * Bring a written value into the state's declared type before it is sent to
 * the appliance and confirmed back: a script writing `"true"` or `1` into a
 * boolean switch, or `"40"` into a number, must reach the cloud as `true` /
 * `40` — and the ack must carry that value, not the raw text.
 *
 * @param value the value the user wrote
 * @param type the state's `common.type`
 * @returns the typed value, or undefined when it cannot be read as that type
 */
export function coerceForType(
  value: ioBroker.StateValue,
  type: ioBroker.CommonType | undefined,
): ioBroker.StateValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  switch (type) {
    case "boolean": {
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        return value !== 0;
      }
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (["true", "1", "on", "yes"].includes(s)) {
          return true;
        }
        if (["false", "0", "off", "no"].includes(s)) {
          return false;
        }
      }
      return undefined;
    }
    case "number": {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : undefined;
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : undefined;
      }
      return undefined;
    }
    case "string":
      return typeof value === "string" ? value : String(value);
    default:
      return value;
  }
}
