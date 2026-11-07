// The request budget: every request holds a place in each window Home Connect counts (src/lib/api-limits.json) — while
// it is on its way, and once answered until a window's length after its answer, because the server counts a request
// at the latest when it answers it (tooling round 170, homeconnect 2026-11-05: in a tester's report the limiter freed
// the place of the list call when its SEND stamp — at or after 20:20:30.940 UTC — was a minute old; the next call drew
// 429 "50 calls in 1 minute", the list call's answer had come at 20:20:31.008). A request that ended without an answer
// (timeout, transport error) frees its place a window's length after its send.
//
// The places of the longest window outlive a restart. Home Connect counts per account, not per process: a restart
// right after the start — a changed setting, the host's own restart — began with a fresh budget, and the new process's
// first reads stacked on the minute the old one had just spent. The file lives in the instance's data folder, which the
// host keeps across a restart; it holds for each place the time it counts from (`heldFrom`), and the form an earlier
// version wrote (`sentAt`, 2.0.0-alpha.0) is read as well.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "./pure-helpers";

/** A window the budget holds: at most `max` requests within `seconds`. */
export interface PacedWindow {
  /** The length of the window in seconds. */
  seconds: number;
  /** The requests allowed within it. */
  max: number;
}

/** One request's place in the budget, handed out by {@link RequestBudget.take}. */
export interface RequestPlace {
  /** When the request went out (epoch ms): the hand-out reserves it, {@link RequestBudget.sent} raises it. */
  sentAt: number;
  /** When Home Connect answered (the headers arrived), once it did. */
  answeredAt?: number;
  /** Whether the request is still on its way — an open request holds its place in every window. */
  open: boolean;
}

/**
 * The time a finished place counts from: its answer, else its send.
 *
 * @param place the place
 * @returns epoch ms
 */
function countsFrom(place: RequestPlace): number {
  return place.answeredAt ?? place.sentAt;
}

/** The places of the requests that still count, in hand-out order. */
export class RequestBudget {
  private places: RequestPlace[] = [];

  /**
   * Hand out a place now; it holds until the request settles.
   *
   * @param now the current time (epoch ms)
   * @returns the place of the request about to go out
   */
  public take(now: number): RequestPlace {
    const place: RequestPlace = { sentAt: now, open: true };
    this.places.push(place);
    return place;
  }

  /**
   * The request of a place just went out — taken right after the transport call, in the same synchronous step.
   *
   * @param place the place
   * @param now the current time (epoch ms)
   */
  public sent(place: RequestPlace, now: number): void {
    if (place.open) {
      place.sentAt = now;
    }
  }

  /**
   * The request of a place is over: with an answer it frees a window's length after it, without one a window's length
   * after its send. A second settle changes nothing.
   *
   * @param place the place
   * @param answeredAt when Home Connect answered (epoch ms), undefined when no answer came
   */
  public settle(place: RequestPlace, answeredAt: number | undefined): void {
    if (!place.open) {
      return;
    }
    place.open = false;
    if (answeredAt !== undefined) {
      place.answeredAt = answeredAt;
    }
  }

  /**
   * Give back a place whose request never went out (the adapter paused or stopped after the hand-out).
   *
   * @param place the place
   */
  public drop(place: RequestPlace): void {
    if (place.open) {
      this.places = this.places.filter(p => p !== place);
    }
  }

  /**
   * How long the next request waits: the gap after the previous request — counted from its answer, else from its send —
   * and in every window until fewer than `max` places hold.
   *
   * @param now the current time (epoch ms)
   * @param windows the windows to hold
   * @param gapMs the least spacing between two requests
   * @returns ms to wait (0 = now), or undefined when only the end of an open request can free a place
   */
  public waitMs(now: number, windows: readonly PacedWindow[], gapMs: number): number | undefined {
    const longest = Math.max(0, ...windows.map(w => w.seconds)) * 1000;
    this.places = this.places.filter(p => p.open || countsFrom(p) + longest > now);
    const last = this.places.at(-1);
    let wait = last ? Math.max(0, countsFrom(last) + gapMs - now) : 0;
    for (const window of windows) {
      const span = window.seconds * 1000;
      const holding = this.places.filter(p => p.open || countsFrom(p) + span > now);
      if (holding.length < window.max) {
        continue;
      }
      // the places that free on their own, earliest first; enough of them must free to leave one place
      const frees = holding
        .filter(p => !p.open)
        .map(p => countsFrom(p) + span)
        .sort((a, b) => a - b);
      const needed = holding.length - window.max + 1;
      if (frees.length < needed) {
        return undefined;
      }
      wait = Math.max(wait, frees[needed - 1] - now);
    }
    return wait;
  }

  /**
   * The places that hold in a window right now.
   *
   * @param now the current time (epoch ms)
   * @param seconds the window
   * @returns the number of places
   */
  public held(now: number, seconds: number): number {
    return this.places.filter(p => p.open || countsFrom(p) + seconds * 1000 > now).length;
  }

  /**
   * For each place that still holds in a window, the time it counts from — a request still on its way counts from now,
   * the moment of the hand-over: what the next process takes over. The adapter hands over again whenever a request
   * ends after the stop, so a late answer reaches the next process with its own time.
   *
   * @param now the current time (epoch ms)
   * @param seconds the window
   * @returns epoch ms, oldest first
   */
  public heldFrom(now: number, seconds: number): number[] {
    return this.places
      .map(p => (p.open ? now : countsFrom(p)))
      .filter(t => now - t < seconds * 1000)
      .sort((a, b) => a - b);
  }

  /**
   * Take over the places a previous process left — each counts from its time, like an answered request.
   *
   * @param heldFrom epoch ms, oldest first
   */
  public restore(heldFrom: readonly number[]): void {
    this.places = [...heldFrom.map(t => ({ sentAt: t, answeredAt: t, open: false })), ...this.places];
  }
}

/**
 * The times the previous process left that still count against the window.
 *
 * @param file the budget file in the instance's data folder
 * @param now the current time (epoch ms)
 * @param windowMs the longest window the budget holds
 * @returns the times within the window, oldest first; none when the file is missing or unreadable
 */
export function readHeldTimes(file: string, now: number, windowMs: number): number[] {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const record = isRecord(data) ? data : {};
  const list = Array.isArray(record.heldFrom) ? record.heldFrom : Array.isArray(record.sentAt) ? record.sentAt : [];
  return list
    .filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t <= now && now - t < windowMs)
    .sort((a, b) => a - b);
}

/**
 * Keep the times that still count for the next process — synchronous, so it fits the stop.
 *
 * @param file the budget file in the instance's data folder
 * @param heldFrom for each place, the time it counts from
 * @param now the current time (epoch ms)
 * @param windowMs the longest window the budget holds
 */
export function writeHeldTimes(file: string, heldFrom: readonly number[], now: number, windowMs: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ heldFrom: heldFrom.filter(t => now - t < windowMs) }));
}
