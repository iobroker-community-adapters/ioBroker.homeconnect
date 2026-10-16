// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
/**
 * One readable line for anything a `catch` receives — never `[object Object]`, never without the reason.
 *
 * @param err the caught value
 * @returns the text
 */
export function errText(err: unknown): string {
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
        reason = errText(cause);
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
