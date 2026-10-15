// The send times of the last minute outlive a restart. Home Connect counts 50 requests per minute per account
// (src/lib/api-limits.json), not per process: a restart right after the start — a changed setting, the host's own
// restart — began with a fresh budget, and the new process's first reads stacked on the minute the old one had
// just spent. The file lives in the instance's data folder, which the host keeps across a restart.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./pure-helpers";

/** The window the per-minute budget counts. */
export const BUDGET_WINDOW_MS = 60_000;

/**
 * The send times the previous process left that still count against the current minute.
 *
 * @param file the budget file in the instance's data folder
 * @param now the current time (epoch ms)
 * @returns the send times within the last minute, oldest first; none when the file is missing or unreadable
 */
export function readSentTimes(file: string, now: number): number[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const list = isRecord(data) && Array.isArray(data.sentAt) ? data.sentAt : [];
  return list
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t <= now && now - t < BUDGET_WINDOW_MS)
    .sort((a, b) => a - b);
}

/**
 * Keep the send times of the last minute for the next process — synchronous, so it fits the stop.
 *
 * @param file the budget file in the instance's data folder
 * @param sentAt the send times this process holds
 * @param now the current time (epoch ms)
 */
export function writeSentTimes(file: string, sentAt: readonly number[], now: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ sentAt: sentAt.filter(t => now - t < BUDGET_WINDOW_MS) }));
}
