// Failure-log dedup policy — warn-once-per-category-then-debug, keyed on the
// endpoint kind (`restLogKey`) with a category taken from the HTTP status, not
// from error-message string matching. homeconnect's HTTP layer already returns typed results, so the
// category comes straight off the status code; a recovery re-arms the warn.
// (Pattern mirrors govee's log-channel-fail, without govee's classifyError
// string-matching, which its https.request boundary needs but this one does not.)

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

/**
 * Per-endpoint-kind failure-log deduplicator. The first failure of a category
 * for a given kind logs at warn; identical repeats drop to debug; a recovery
 * clears the kind so the next failure warns again. Keeps the log honest without
 * spamming when the same failure recurs on every reconnect / re-sync — or on
 * every appliance of the same pass. The key is normalized HERE, so every
 * caller (failure, recovery, rate-pause drop) collapses the same way.
 */
export class LogDedup {
  private readonly last = new Map<string, FailureCategory>();

  /**
   * Record a failure and get the level to log it at.
   *
   * @param source a stable per-call-site key (e.g. "GET /status")
   * @param category the failure category ({@link categorize})
   * @returns "warn" for a new category at this source's kind, "debug" for a repeat
   */
  note(source: string, category: FailureCategory): "warn" | "debug" {
    const key = restLogKey(source);
    const level = this.last.get(key) === category ? "debug" : "warn";
    this.last.set(key, category);
    return level;
  }

  /**
   * Clear a source's kind after a success. The next failure for it warns again.
   *
   * @param source the source key
   * @returns true if the kind had been in a failing state (worth a recovery log)
   */
  recovered(source: string): boolean {
    return this.last.delete(restLogKey(source));
  }
}
