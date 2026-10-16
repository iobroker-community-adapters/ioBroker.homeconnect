// What the fleet master LogOnce (log-once.ts) needs to say a REST failure once: the key is the endpoint kind
// (`restLogKey`), the kind of failure is a category taken from the HTTP status, not from error-message string
// matching — homeconnect's HTTP layer already returns typed results.

/** Coarse failure class used as the dedup key together with the call source. */
export type FailureCategory = "net" | "auth" | "rate" | "http-4xx" | "http-5xx" | "other";

/**
 * Classify an HTTP outcome into a failure category. Status 0 is a transport
 * error (see http.ts), 401/403 auth, 429 rate-limit, else by status band.
 *
 * @param status the HTTP status (0 on a transport error)
 * @returns the failure category
 */
export function categorize(status: number): FailureCategory {
  if (status === 0) {
    return "net";
  }
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429) {
    return "rate";
  }
  if (status >= 500) {
    return "http-5xx";
  }
  if (status >= 400) {
    return "http-4xx";
  }
  return "other";
}

/**
 * Collapse a request source ("GET /api/homeappliances/<haId>/settings/<key>")
 * to its endpoint KIND: the appliance id and a trailing setting / command /
 * option / program key become `*`. One cloud outage hits every appliance and
 * every single-setting read of the start-up in the same way — deduped per full
 * path it produced one warning per path (measured: 25 for one 503) and as many
 * "succeeded again" lines when it cleared. The log line keeps the full path;
 * only the dedup key is coarse.
 *
 * @param source the call source ("<METHOD> <path>")
 * @returns the dedup key
 */
export function restLogKey(source: string): string {
  return source
    .replace(/\/homeappliances\/[^/]+/, "/homeappliances/*")
    .replace(/\/(settings|commands|options|available)\/[^/]+/g, "/$1/*");
}
