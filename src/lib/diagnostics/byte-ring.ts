// Fleet master (.consistency-master/src/lib/diagnostics/byte-ring.ts) — never edit the copy in an adapter.
//
// Diagnostics report standard (krobi 2026-10-06, page "Diagnosebericht — Flottenstandard", C2): what an adapter records
// for its report lives in memory only (DB-01) and in rings that cannot crowd each other out:
// - R1: what recurs is counted, not stacked — an entry with the same fold key raises a counter and moves to the newest
//   place, first and last time kept (one source repeating itself pushed everything else out of a shared ring);
// - R2: every source gets its own ring with its own byte limit;
// - R3: an entry is kept whole or dropped whole; one over the entry limit keeps only its size.

/** One recorded entry. */
export interface RingEntry<T> {
  /** When it was seen first (ISO time). */
  first: string;
  /** When it was seen last (ISO time). */
  last: string;
  /** How often it was seen. */
  count: number;
  /** What was seen; absent when it was over the entry limit (R3). */
  content?: T;
  /** An entry over the entry limit: its size only (R3). */
  omittedBytes?: number;
}

/**
 * The size an entry takes in the report: its JSON text in UTF-8 bytes.
 *
 * @param value the entry
 * @returns the size in bytes
 */
export function sizeOf(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

/** One source's ring: entries by their fold key, oldest first; a repeat moves to the newest place. */
export class ByteRing<T> {
  private readonly entries = new Map<string, { entry: RingEntry<T>; bytes: number }>();
  private bytes = 0;

  /**
   * @param limit the ring's byte limit (R2)
   * @param entryLimit the largest entry kept with its content (R3)
   * @param now the clock (injectable for tests)
   */
  public constructor(
    private readonly limit: number,
    private readonly entryLimit: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one entry under its fold key (R1), then drop whole entries from the oldest end until the ring fits (R3).
   *
   * @param key what makes two entries the same
   * @param content what was seen
   */
  public add(key: string, content: T): void {
    const at = new Date(this.now()).toISOString();
    const known = this.entries.get(key);
    if (known) {
      this.entries.delete(key);
      this.bytes -= known.bytes;
    }
    const size = sizeOf(content);
    const entry: RingEntry<T> = {
      first: known?.entry.first ?? at,
      last: at,
      count: (known?.entry.count ?? 0) + 1,
      ...(size > this.entryLimit ? { omittedBytes: size } : { content }),
    };
    const bytes = sizeOf(entry);
    this.entries.set(key, { entry, bytes });
    this.bytes += bytes;
    for (const [oldest, kept] of this.entries) {
      if (this.bytes <= this.limit || oldest === key) {
        break;
      }
      this.entries.delete(oldest);
      this.bytes -= kept.bytes;
    }
  }

  /**
   * What the ring holds, oldest first — a copy, so the report never changes the ring.
   *
   * @returns the entries
   */
  public snapshot(): Array<RingEntry<T>> {
    return [...this.entries.values()].map(({ entry }) => ({ ...entry }));
  }
}
