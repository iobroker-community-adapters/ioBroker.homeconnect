// The request budget: every request holds a place in each window of each counterpart of src/lib/api-limits.json it
// fits, counted exactly as the fleet suites judge it (test/fleet-suites.js `fits`, `limitKey`, `heldAt`) — a call counts
// in every counterpart whose match fits it: a token refresh in the whole host's windows and in the token endpoint's
// own, a program start in the host's, the REST API's and the program starts'. A place holds while its request is on
// its way, and once answered until a window's length after its answer, because the server counts a request at the
// latest when it answers it (tooling round 170, homeconnect 2026-11-05: in a tester's report the limiter freed the place
// of the list call when its SEND stamp — at or after 20:20:30.940 UTC — was a minute old; the next call drew 429 "50
// calls in 1 minute", the list call's answer had come at 20:20:31.008). A request that ended without an answer
// (timeout, transport error) frees its place a window's length after its send. A window of the calls open at once
// (`concurrent`) counts a place from its send until the request ended — for the event stream until the stream closed.
// A window of the calls answered with an error (`errors`) counts a place while it is on its way (it may become one)
// and, answered with a status of 400 and up, a window's length after its answer. A window of an unbroken series of them
// (`errors: "successive"`, Home Connect's "10 successive requests … which result in an error") forgets every error
// answered before an answer without one in the same lane — answer order; a request without an answer neither counts nor
// ends the series.
//
// The places outlive a restart. Home Connect counts per account, not per process: a restart right after the start — a
// changed setting, the host's own restart — began with a fresh budget, and the new process's first reads stacked on
// the minute the old one had just spent. The file lives in the instance's data folder, which the host keeps across a
// restart, and the adapter reads and writes it through the fleet master `data-file.ts` (main.ts); it holds for each
// window of each counterpart and each lane the times its places count from (`windows`), never a request's path or body.
// The forms earlier versions wrote — `heldFrom` (2.0.0-alpha.1 and later) and `sentAt` (2.0.0-alpha.0), one list for
// every request — are read as places of a REST read.
import {
  countsErrors,
  countsSeries,
  fits,
  limitKey,
  type Counterpart,
  type DeclaredLimit,
  type LimitedCall,
} from "./api-limits";
import { isRecord } from "./pure-helpers";

/** A window of one counterpart with its strictest limit — the fleet suites judge a window by its strictest entry. */
export interface CountedWindow {
  /** The counterpart's name. */
  name: string;
  /** The window's key: its seconds, "<seconds> errors", "<seconds> successive errors", or "concurrent" (`limitKey`). */
  key: string;
  /** The calls it allows. */
  max: number;
  /** Its length in seconds; undefined for the calls open at once. */
  seconds?: number;
}

/** One request's place in the budget, handed out by {@link RequestBudget.take}. */
export interface RequestPlace {
  /** When the request went out (epoch ms): the hand-out reserves it, {@link RequestBudget.sent} raises it. */
  sentAt: number;
  /** When Home Connect answered (the headers arrived), once it did. */
  answeredAt?: number;
  /** Whether the answer carried a status of 400 and up. */
  failed: boolean;
  /** Where its answer stands in the order of answers (0 for a place a previous process left, which came first). */
  answerOrder?: number;
  /** Whether the request is still on its way — it holds its place in every window until its answer or its end. */
  open: boolean;
  /** Whether the request ended (body read, aborted, failed) — until then it is open in a window of calls at once. */
  closed: boolean;
  /** For each window the place counts in (`windowId`), its lane: the account, a host, or a device. */
  lanes: ReadonlyMap<string, string>;
}

/** How long the next request of a kind waits, and the window that holds it. */
export interface BudgetWait {
  /** ms to wait (0 = now), or undefined when only the end of an open request can free a place. */
  ms: number | undefined;
  /** The window the wait comes from, while one holds. */
  window?: CountedWindow;
}

/** The places a process leaves to the next: per counterpart, window and lane the times they count from. */
export type HeldPlaces = Record<string, Record<string, Record<string, number[]>>>;

/** What the budget file held: the places per window, and a list of an earlier version for every request. */
export interface KeptPlaces {
  /** Per counterpart, window and lane the times its places count from. */
  windows: HeldPlaces;
  /** The times of an earlier version's single list (`heldFrom`, `sentAt`), every request's. */
  earlier: number[];
}

/**
 * The id of a window: counterpart and key.
 *
 * @param name the counterpart's name
 * @param key the window's key
 * @returns the id
 */
function windowId(name: string, key: string): string {
  return `${name}\u0000${key}`;
}

/**
 * The length of a window in ms — 0 for the calls open at once, which count until their end.
 *
 * @param key the window's key
 * @returns ms
 */
function spanOf(key: string): number {
  return key === "concurrent" ? 0 : Number.parseFloat(key) * 1000;
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

/**
 * Each window of a counterpart with its strictest limit.
 *
 * @param counterpart the counterpart
 * @returns key and strictest limit of each window
 */
function windowsOf(counterpart: Counterpart): { key: string; limit: DeclaredLimit }[] {
  const strictest = new Map<string, DeclaredLimit>();
  for (const limit of counterpart.limits) {
    const key = limitKey(limit);
    const known = strictest.get(key);
    if (known === undefined || limit.max < known.max) {
      strictest.set(key, limit);
    }
  }
  return [...strictest].map(([key, limit]) => ({ key, limit }));
}

/**
 * The lane a call counts in for one limit — the whole account, its host, or its device: the named group `device` of the
 * counterpart's pathPattern or bodyPattern (test/fleet-suites.js `laneOf`).
 *
 * @param call the call
 * @param limit the limit
 * @param match the counterpart's match
 * @returns the lane
 */
function laneOf(call: LimitedCall, limit: DeclaredLimit, match: Counterpart["match"]): string {
  if (limit.per === "host") {
    return call.host;
  }
  if (limit.per === "device") {
    const texts: [string, string | undefined][] = [
      ["pathPattern", call.path.split("?")[0]],
      ["bodyPattern", call.body?.slice(0, 1024)],
    ];
    for (const [key, text] of texts) {
      const pattern = match[key];
      const device =
        pattern !== undefined && text !== undefined
          ? new RegExp(String(pattern)).exec(text)?.groups?.device
          : undefined;
      if (device !== undefined) {
        return `device ${device}`;
      }
    }
    return "device unknown";
  }
  return "account";
}

/**
 * Whether a place holds in a window of one lane right now.
 *
 * @param place the place
 * @param id the window's id
 * @param key the window's key
 * @param lane the lane
 * @param now the current time (epoch ms)
 * @param seriesEnd in a window of a series: the answer order of the lane's latest answer without an error, -1 for none
 * @returns whether it holds
 */
function holds(place: RequestPlace, id: string, key: string, lane: string, now: number, seriesEnd: number): boolean {
  if (place.lanes.get(id) !== lane) {
    return false;
  }
  if (key === "concurrent") {
    return !place.closed;
  }
  if (place.open) {
    return true;
  }
  if (countsErrors(key) && !place.failed) {
    return false;
  }
  if (countsSeries(key) && (place.answerOrder ?? 0) <= seriesEnd) {
    return false;
  }
  return countsFrom(place) + spanOf(key) > now;
}

/** The places of the requests that still count, in hand-out order. */
export class RequestBudget {
  private places: RequestPlace[] = [];
  private readonly table: () => readonly Counterpart[];
  /** The answers so far — the order a window of a series counts in. */
  private answers = 0;
  /** Per window of a series and lane (`<window id>\u0001<lane>`), the order of its latest answer without an error. */
  private readonly seriesEnds = new Map<string, number>();

  /**
   * @param table the counterparts, read whenever a place is judged — the declaration as the process loaded it
   */
  public constructor(table: () => readonly Counterpart[]) {
    this.table = table;
  }

  /**
   * Hand out a place now; it holds until the request is over.
   *
   * @param now the current time (epoch ms)
   * @param call the request about to go out
   * @returns its place
   */
  public take(now: number, call: LimitedCall): RequestPlace {
    const place: RequestPlace = { sentAt: now, failed: false, open: true, closed: false, lanes: this.lanesOf(call) };
    this.places.push(place);
    return place;
  }

  /**
   * What a call counts in — two calls of the same sort wait alike ({@link waitMs} depends on nothing else).
   *
   * @param call the call
   * @returns the windows and lanes it counts in, as one text
   */
  public sortOf(call: LimitedCall): string {
    return [...this.lanesOf(call)]
      .map(([id, lane]) => `${id}\u0001${lane}`)
      .sort()
      .join("\u0002");
  }

  /**
   * The strictest window of `seconds` among the counterparts a call fits.
   *
   * @param call the call
   * @param seconds the window's length
   * @returns the window, or undefined when none of its counterparts declares one that long
   */
  public strictestWindow(call: LimitedCall, seconds: number): CountedWindow | undefined {
    return this.strictestWhere(call, key => key === String(seconds));
  }

  /**
   * The strictest window of the calls answered with an error among the counterparts a call fits.
   *
   * @param call the call
   * @returns the window, or undefined when none of its counterparts declares one
   */
  public errorWindow(call: LimitedCall): CountedWindow | undefined {
    return this.strictestWhere(call, countsErrors);
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
   * Home Connect answered the request of a place (the headers arrived): from now it frees a window's length after this
   * answer. A second answer changes nothing, and neither does a status of 0 — the transport stamps its own failure
   * with a time too, but no answer came: such a request frees a window's length after its send and neither counts in
   * nor ends a series of errors.
   *
   * @param place the place
   * @param answeredAt when Home Connect answered (epoch ms)
   * @param status the answer's HTTP status (0 = none came)
   * @returns whether the answer ended a series that held errors — their places are free at once
   */
  public answer(place: RequestPlace, answeredAt: number, status: number): boolean {
    if (!place.open || status <= 0) {
      return false;
    }
    place.open = false;
    place.answeredAt = answeredAt;
    place.failed = status >= 400;
    const order = ++this.answers;
    place.answerOrder = order;
    let freed = false;
    if (!place.failed) {
      // an answer without an error ends the series of every window of a series the request counts in
      for (const [id, lane] of place.lanes) {
        if (!countsSeries(id.slice(id.indexOf("\u0000") + 1))) {
          continue;
        }
        const slot = `${id}\u0001${lane}`;
        const before = this.seriesEnds.get(slot) ?? -1;
        freed ||= this.places.some(p => p.failed && p.lanes.get(id) === lane && (p.answerOrder ?? 0) > before);
        this.seriesEnds.set(slot, order);
      }
    }
    return freed;
  }

  /**
   * The request of a place ended — its body read, aborted or failed. Without an answer it frees a window's length after
   * its send.
   *
   * @param place the place
   */
  public close(place: RequestPlace): void {
    place.open = false;
    place.closed = true;
  }

  /**
   * The request of a place is over in one step (a REST request: the transport read its body): with an answer it frees a
   * window's length after it, without one a window's length after its send. A second settle changes nothing.
   *
   * @param place the place
   * @param answeredAt when Home Connect answered (epoch ms), undefined when no answer came
   * @param status the answer's HTTP status (0 = none)
   * @returns whether the answer ended a series that held errors ({@link answer})
   */
  public settle(place: RequestPlace, answeredAt: number | undefined, status: number): boolean {
    const freed = answeredAt !== undefined && this.answer(place, answeredAt, status);
    this.close(place);
    return freed;
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
   * How long the next request of this kind waits: the gap after the previous request in the shortest window — counted
   * from its answer, else from its send — and in every window of every counterpart it fits until fewer than `max`
   * places hold. The gap is the shortest window divided by its strictest limit (10 per second: 100 ms), for the
   * counterparts that declare that window.
   *
   * @param now the current time (epoch ms)
   * @param call the request that waits
   * @returns the wait and the window it comes from
   */
  public waitMs(now: number, call: LimitedCall): BudgetWait {
    const table = this.table();
    this.forget(now, table);
    let wait: BudgetWait = { ms: 0 };
    const raise = (ms: number | undefined, window: CountedWindow): void => {
      if (wait.ms !== undefined && (ms === undefined || ms > wait.ms)) {
        wait = { ms, window };
      }
    };
    const timed = table.flatMap(c => windowsOf(c).filter(w => w.key !== "concurrent" && !countsErrors(w.key)));
    const shortest = Math.min(...timed.map(w => spanOf(w.key)));
    for (const counterpart of table) {
      if (!fits(call, counterpart.match)) {
        continue;
      }
      for (const { key, limit } of windowsOf(counterpart)) {
        const id = windowId(counterpart.name, key);
        const lane = laneOf(call, limit, counterpart.match);
        const window: CountedWindow = { name: counterpart.name, key, max: limit.max, seconds: limit.seconds };
        if (key !== "concurrent" && !countsErrors(key) && spanOf(key) === shortest) {
          const previous = this.lastIn(id, lane);
          if (previous) {
            raise(Math.max(0, countsFrom(previous) + Math.ceil(shortest / limit.max) - now), window);
          }
        }
        const holding = this.places.filter(p => this.holds(p, id, key, lane, now));
        if (holding.length < limit.max) {
          continue;
        }
        if (key === "concurrent" || (countsSeries(key) && holding.some(p => p.open))) {
          // only an end frees a call open at once; in a series, an answer without an error frees every place at once —
          // the request on its way decides before any time does
          raise(undefined, window);
          continue;
        }
        // the places that free on their own, earliest first; enough of them must free to leave one place
        const frees = holding
          .filter(p => !p.open)
          .map(p => countsFrom(p) + spanOf(key))
          .sort((a, b) => a - b);
        const needed = holding.length - limit.max + 1;
        raise(frees.length < needed ? undefined : frees[needed - 1] - now, window);
      }
    }
    return wait;
  }

  /**
   * The places that hold in a window of the account lane right now.
   *
   * @param now the current time (epoch ms)
   * @param name the counterpart's name
   * @param key the window's key
   * @returns the number of places
   */
  public held(now: number, name: string, key: string): number {
    const id = windowId(name, key);
    return this.places.filter(p => this.holds(p, id, key, "account", now)).length;
  }

  /**
   * For each window of time and each lane the times its places count from — a request still on its way counts from
   * now, the moment of the hand-over: what the next process takes over. The adapter hands over again whenever a
   * request ends after the stop, so a late answer reaches the next process with its own time. A window of errors takes
   * only the answered errors: a request whose answer never reached the adapter is no error the fleet judge counts —
   * it stamps only the answers that came —, and one the stop still saw answered is handed over again with its answer.
   *
   * @param now the current time (epoch ms)
   * @returns the places per counterpart, window and lane, oldest first
   */
  public heldPlaces(now: number): HeldPlaces {
    const kept: HeldPlaces = {};
    for (const counterpart of this.table()) {
      for (const { key } of windowsOf(counterpart)) {
        if (key === "concurrent") {
          continue;
        }
        const id = windowId(counterpart.name, key);
        for (const place of this.places) {
          const lane = place.lanes.get(id);
          if (lane === undefined || !this.holds(place, id, key, lane, now) || (place.open && countsErrors(key))) {
            continue;
          }
          const byKey = (kept[counterpart.name] ??= {});
          (byKey[key] ??= {})[lane] = [...(byKey[key][lane] ?? []), place.open ? now : countsFrom(place)];
        }
      }
    }
    for (const byKey of Object.values(kept)) {
      for (const byLane of Object.values(byKey)) {
        for (const lane of Object.keys(byLane)) {
          byLane[lane].sort((a, b) => a - b);
        }
      }
    }
    return kept;
  }

  /**
   * Take over the places a previous process left — each counts in its window from its time, like an answered request;
   * one in a window of errors as one answered with an error, and in a window of a series as answered before every
   * answer of this process: the series goes on until an answer without an error. The single list of an earlier version counts as places of
   * `earlierCall` (a REST read) in every window of time it fits.
   *
   * @param kept what the file held
   * @param now the current time (epoch ms)
   * @param earlierCall the kind of request the single list of an earlier version stands for
   */
  public restore(kept: KeptPlaces, now: number, earlierCall: LimitedCall): void {
    const restored: RequestPlace[] = [];
    const add = (id: string, key: string, lane: string, t: number): void => {
      if (now - t < spanOf(key)) {
        restored.push({
          sentAt: t,
          answeredAt: t,
          failed: countsErrors(key),
          answerOrder: 0,
          open: false,
          closed: true,
          lanes: new Map([[id, lane]]),
        });
      }
    };
    for (const counterpart of this.table()) {
      for (const { key, limit } of windowsOf(counterpart)) {
        if (key === "concurrent") {
          continue;
        }
        const id = windowId(counterpart.name, key);
        for (const [lane, times] of Object.entries(kept.windows[counterpart.name]?.[key] ?? {})) {
          times.forEach(t => add(id, key, lane, t));
        }
        if (!countsErrors(key) && fits(earlierCall, counterpart.match)) {
          kept.earlier.forEach(t => add(id, key, laneOf(earlierCall, limit, counterpart.match), t));
        }
      }
    }
    restored.sort((a, b) => a.sentAt - b.sentAt);
    this.places = [...restored, ...this.places];
  }

  /**
   * Whether a place holds in a window of one lane right now — in a window of a series only after the lane's latest
   * answer without an error.
   *
   * @param place the place
   * @param id the window's id
   * @param key the window's key
   * @param lane the lane
   * @param now the current time (epoch ms)
   * @returns whether it holds
   */
  private holds(place: RequestPlace, id: string, key: string, lane: string, now: number): boolean {
    return holds(place, id, key, lane, now, this.seriesEnds.get(`${id}\u0001${lane}`) ?? -1);
  }

  /**
   * The strictest window among the counterparts a call fits whose key passes a test.
   *
   * @param call the call
   * @param test which keys count
   * @returns the window, or undefined when none passes
   */
  private strictestWhere(call: LimitedCall, test: (key: string) => boolean): CountedWindow | undefined {
    let strictest: CountedWindow | undefined;
    for (const counterpart of this.table()) {
      if (!fits(call, counterpart.match)) {
        continue;
      }
      for (const { key, limit } of windowsOf(counterpart)) {
        if (test(key) && (strictest === undefined || limit.max < strictest.max)) {
          strictest = { name: counterpart.name, key, max: limit.max, seconds: limit.seconds };
        }
      }
    }
    return strictest;
  }

  /**
   * The window and lane of each window a call counts in.
   *
   * @param call the call
   * @returns window id → lane
   */
  private lanesOf(call: LimitedCall): Map<string, string> {
    const lanes = new Map<string, string>();
    for (const counterpart of this.table()) {
      if (!fits(call, counterpart.match)) {
        continue;
      }
      for (const { key, limit } of windowsOf(counterpart)) {
        lanes.set(windowId(counterpart.name, key), laneOf(call, limit, counterpart.match));
      }
    }
    return lanes;
  }

  /**
   * The newest place of a window's lane — the one the gap counts from.
   *
   * @param id the window's id
   * @param lane the lane
   * @returns the place, if one counts there
   */
  private lastIn(id: string, lane: string): RequestPlace | undefined {
    for (let k = this.places.length - 1; k >= 0; k--) {
      if (this.places[k].lanes.get(id) === lane) {
        return this.places[k];
      }
    }
    return undefined;
  }

  /**
   * Forget the places that count nowhere any more: over, and older than the longest window.
   *
   * @param now the current time (epoch ms)
   * @param table the counterparts
   */
  private forget(now: number, table: readonly Counterpart[]): void {
    const longest = Math.max(0, ...table.flatMap(c => windowsOf(c).map(w => spanOf(w.key))));
    this.places = this.places.filter(p => p.open || !p.closed || countsFrom(p) + longest > now);
  }
}

/**
 * Read a list of times, keeping only finite numbers that are not from the future (a clock set back would block a whole
 * window).
 *
 * @param list what the file held
 * @param now the current time (epoch ms)
 * @returns the times, oldest first
 */
function timesOf(list: unknown, now: number): number[] {
  return Array.isArray(list)
    ? list.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t <= now).sort((a, b) => a - b)
    : [];
}

/**
 * The places the previous process left; the budget keeps of them what still counts in a window.
 *
 * @param data what the budget file held (unchecked; undefined when there was none or it was unreadable)
 * @param now the current time (epoch ms)
 * @returns the places per window, and an earlier version's single list; nothing for a missing or foreign content
 */
export function heldPlacesOf(data: unknown, now: number): KeptPlaces {
  const record = isRecord(data) ? data : {};
  const windows: HeldPlaces = {};
  for (const [name, byKey] of Object.entries(isRecord(record.windows) ? record.windows : {})) {
    for (const [key, byLane] of Object.entries(isRecord(byKey) ? byKey : {})) {
      for (const [lane, list] of Object.entries(isRecord(byLane) ? byLane : {})) {
        const times = timesOf(list, now);
        if (times.length > 0) {
          ((windows[name] ??= {})[key] ??= {})[lane] = times;
        }
      }
    }
  }
  const earlier = timesOf(Array.isArray(record.heldFrom) ? record.heldFrom : record.sentAt, now);
  return { windows, earlier };
}
