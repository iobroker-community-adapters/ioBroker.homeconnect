// Fleet master (.consistency-master/src/lib/log-once.ts) — never edit the copy in an adapter.
//
// The fleet's log rule (feedback memory "Logging-Strategie"): the first failure of a kind is said once — warn or error —,
// a repeat of the same kind goes to debug, and a problem that went away after a loud line gets exactly one info line.
// An outage of the counterpart is a state, not a line (krobi 2026-10-03, cloud included) — that path never reaches
// here. Measured 2026-10-03: the rule stood in seven forms in seven adapters (category latches, time windows, memory caps);
// this is the one form. Forms that ask more than this — a summary line with a counter, a cooldown layered over a category
// latch — stay their adapter's, named in CLAUDE_PATTERNS.md.

/** The adapter logger methods the class writes to. */
export interface LogOnceLogger {
  /** A routine line. */
  debug(message: string): void;
  /** An event the user sees. */
  info(message: string): void;
  /** A problem the user should look at. */
  warn(message: string): void;
  /** A problem that stops something. */
  error(message: string): void;
}

/** How the memory behaves. */
export interface LogOnceOptions {
  /** A repeat of the same kind is loud again after this long; never when not given (a pure latch). */
  windowMs?: number;
  /** At most this many keys are remembered, the oldest goes first; unbounded when not given. */
  maxKeys?: number;
  /** The clock, `Date.now` when not given. */
  now?: () => number;
}

/** One report. */
export interface LogOnceReport {
  /** What decides "the same problem again": the text itself when not given (e.g. an error category). */
  kind?: string;
  /** The loud level, `warn` when not given. */
  level?: "warn" | "error" | "info";
}

/**
 * Says a problem once per key and kind; repeats go to debug.
 */
export class LogOnce {
  private readonly seen = new Map<string, { kind: string; at: number }>();

  /**
   * @param log the adapter logger
   * @param options window, memory cap and clock
   */
  constructor(
    private readonly log: LogOnceLogger,
    private readonly options: LogOnceOptions = {},
  ) {}

  /**
   * Logs `text` loud the first time `key` reports this kind (or again once the window has passed), on debug otherwise.
   *
   * @param key what the problem belongs to — a device, a channel, an endpoint
   * @param text the line
   * @param report kind and level
   * @returns true when the line went out loud
   */
  report(key: string, text: string, report: LogOnceReport = {}): boolean {
    const now = (this.options.now ?? Date.now)();
    const kind = report.kind ?? text;
    const last = this.seen.get(key);
    const window = this.options.windowMs;
    if (last && last.kind === kind && (window === undefined || now - last.at < window)) {
      this.log.debug(text);
      return false;
    }
    this.seen.delete(key);
    if (this.options.maxKeys !== undefined && this.seen.size >= this.options.maxKeys) {
      for (const oldest of this.seen.keys()) {
        this.seen.delete(oldest);
        break;
      }
    }
    this.seen.set(key, { kind, at: now });
    this.log[report.level ?? "warn"](text);
    return true;
  }

  /**
   * The problem of `key` went away: one info line when it was reported loud, debug otherwise; the key starts anew.
   *
   * @param key the key a report used
   * @param text the line
   * @returns true when the info line went out
   */
  recovered(key: string, text: string): boolean {
    const last = this.seen.get(key);
    this.seen.delete(key);
    if (last) {
      this.log.info(text);
      return true;
    }
    this.log.debug(text);
    return false;
  }

  /**
   * Drops `key` without a line — the caller logs what happened instead.
   *
   * @param key the key a report used
   */
  forget(key: string): void {
    this.seen.delete(key);
  }
}
