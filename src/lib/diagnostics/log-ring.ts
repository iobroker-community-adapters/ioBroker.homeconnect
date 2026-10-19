// Fleet master (.consistency-master/src/lib/diagnostics/log-ring.ts) — never edit the copy in an adapter.
//
// Diagnostics report standard (krobi 2026-10-06, page "Diagnosebericht — Flottenstandard", C2): the adapter's last log
// lines at every level, also debug, for the report.

/** One log line as the diagnostics report shows it. */
export interface LogLine {
  /** When it was logged (ISO time). */
  ts: string;
  /** The level it was logged at. */
  level: "silly" | "debug" | "info" | "warn" | "error";
  /** The message. */
  msg: string;
}

/** The log levels the ring records. */
const LEVELS = ["silly", "debug", "info", "warn", "error"] as const;

/** Lines kept — about a busy hour of a device at debug level, a few hundred kilobytes. */
export const LOG_RING_SIZE = 2000;

/** The logger surface the ring hooks into. */
export type HookableLog = Record<(typeof LEVELS)[number], (message: string) => void>;

/**
 * The adapter's last log lines, kept for the diagnostics report — at EVERY level, also the debug lines a
 * log set to `info` never prints: a report is usually wanted after the fact, and asking a user to switch
 * to debug and wait for the fault again is exactly the round trip the report exists to save.
 */
export class LogRing {
  private readonly lines: LogLine[] = [];

  /**
   * @param size how many lines to keep
   * @param now the clock (injectable for tests)
   */
  public constructor(
    private readonly size = LOG_RING_SIZE,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record every line the logger is given, then let it log as before. The logger's own level filter
   * stays untouched — the ring only listens.
   *
   * @param log the adapter logger
   */
  public hook(log: HookableLog): void {
    for (const level of LEVELS) {
      const original = log[level].bind(log);
      log[level] = (message: string): void => {
        this.add(level, message);
        original(message);
      };
    }
  }

  /**
   * Keep one line.
   *
   * @param level the level
   * @param message the message
   */
  public add(level: LogLine["level"], message: unknown): void {
    this.lines.push({ ts: new Date(this.now()).toISOString(), level, msg: String(message) });
    if (this.lines.length > this.size) {
      this.lines.splice(0, this.lines.length - this.size);
    }
  }

  /**
   * The lines about one device: those naming it (its id or address) and those naming no other
   * device (adapter-wide lines — discovery, the push receiver, the start).
   *
   * A name counts only as a whole token: `lamp` is not named by `lamp-2: ready`, nor `10.0.0.5`
   * by `10.0.0.50 answered` — a substring match gave a device the lines of every device whose id or
   * address merely starts like its own (review 2026-10-05, B4).
   *
   * @param mentions the strings that name this device (its id, its address)
   * @param others the strings that name the OTHER devices
   * @returns the lines, oldest first
   */
  public about(mentions: readonly string[], others: readonly string[]): LogLine[] {
    const mine = tokenPattern(mentions);
    const theirs = tokenPattern(others);
    return this.lines.filter(line => mine?.test(line.msg) === true || theirs?.test(line.msg) !== true);
  }
}

/**
 * One pattern that finds any of the given names as a whole token. Ids and addresses are made of
 * letters, digits, `-` and `_` (and the dots of an address, which end a token like any other
 * character: `demo.0.lamp.power` names `lamp`), so a neighbouring letter, digit, `-` or `_`
 * means the text is part of a longer name.
 *
 * @param names the names (empty ones are skipped)
 * @returns the pattern, or undefined when there is no name to look for
 */
function tokenPattern(names: readonly string[]): RegExp | undefined {
  const alternatives = names.filter(name => name.length > 0).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return alternatives.length > 0
    ? new RegExp(`(?<![A-Za-z0-9_-])(?:${alternatives.join("|")})(?![A-Za-z0-9_-])`)
    : undefined;
}
