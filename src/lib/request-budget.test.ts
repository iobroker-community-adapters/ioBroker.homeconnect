import { describe, expect, it } from "vitest";
import { counterparts, type Counterpart, type DeclaredLimit, type LimitedCall } from "./api-limits";
import { heldPlacesOf, RequestBudget, type HeldPlaces, type RequestPlace } from "./request-budget";

const HOST = "api.home-connect.com";
const MINUTE = 60_000;
const DAY = 86_400_000;

/**
 * One limit of a counterpart, counted for the whole account unless `more` says otherwise.
 *
 * @param max the calls it allows
 * @param seconds its window, undefined for the calls open at once
 * @param more further fields (`concurrent`, `errors`, `per`)
 * @returns the limit
 */
const limit = (max: number, seconds: number | undefined, more: Partial<DeclaredLimit> = {}): DeclaredLimit => ({
  max,
  ...(seconds === undefined ? {} : { seconds }),
  per: "account",
  source: "test",
  ...more,
});
/**
 * The whole host with the second of the declaration — the gap comes from it, as from api-limits.json.
 *
 * @param more further limits of the host
 * @returns the counterpart
 */
const hostWide = (...more: DeclaredLimit[]): Counterpart => ({
  name: "host",
  match: { host: HOST },
  limits: [limit(10, 1), ...more],
});
const tableOf =
  (...table: Counterpart[]): (() => readonly Counterpart[]) =>
  () =>
    table;

const read = (path = "/api/homeappliances"): LimitedCall => ({ host: HOST, method: "GET", path });
const start = (ha = "ha1"): LimitedCall => ({
  host: HOST,
  method: "PUT",
  path: `/api/homeappliances/${ha}/programs/active`,
});
const refresh: LimitedCall = {
  host: HOST,
  method: "POST",
  path: "/security/oauth/token",
  body: "grant_type=refresh_token&refresh_token=SECRET-TOKEN",
};

/**
 * A request that goes out at `t` and is answered at once.
 *
 * @param budget the budget
 * @param t when it goes out
 * @param call the request
 * @param status the answer's status
 * @returns its place
 */
const answered = (budget: RequestBudget, t: number, call: LimitedCall, status = 200): RequestPlace => {
  const place = budget.take(t, call);
  budget.sent(place, t);
  budget.settle(place, t, status);
  return place;
};

describe("the request budget counts each request in every counterpart it fits", () => {
  it("holds a sixth program start within a minute while a read of the same moment goes on — each counts its own", () => {
    const budget = new RequestBudget(counterparts);
    for (let n = 0; n < 5; n++) {
      answered(budget, n * 100, start(`ha${n}`));
    }
    expect(budget.waitMs(500, start("ha5"))).toEqual({
      ms: 59_500,
      window: { name: "Home Connect program starts", key: "60", max: 5, seconds: 60 },
    });
    expect(budget.waitMs(500, read()).ms).toBe(0);
    expect(budget.waitMs(500, { ...start(), method: "DELETE" }).ms).toBe(0);
    // the first start's place frees a minute after its answer — the fleet judge counts t − answered < window
    expect(budget.waitMs(MINUTE, start("ha5")).ms).toBe(0);
  });

  it("holds an eleventh token refresh within a minute, never another request on the host", () => {
    const budget = new RequestBudget(counterparts);
    for (let n = 0; n < 10; n++) {
      answered(budget, n * 100, refresh);
    }
    expect(budget.waitMs(1_000, refresh).window?.name).toBe("Home Connect token refresh");
    expect(budget.waitMs(1_000, refresh).ms).toBe(MINUTE - 1_000);
    expect(budget.waitMs(1_000, read()).ms).toBe(0);
  });

  it("takes the strictest entry of a window — the average 10 per second, not the burst of 20", () => {
    const budget = new RequestBudget(counterparts);
    expect(budget.strictestWindow(read(), 1)).toEqual({ name: "Home Connect API", key: "1", max: 10, seconds: 1 });
    expect(budget.strictestWindow(read(), 60)).toEqual({ name: "Home Connect API", key: "60", max: 50, seconds: 60 });
    expect(budget.strictestWindow(refresh, 60)).toEqual({
      name: "Home Connect token refresh",
      key: "60",
      max: 10,
      seconds: 60,
    });
    expect(budget.strictestWindow(read(), 86400)?.name).toBe("Home Connect REST API");
    expect(budget.strictestWindow(read(), 3600)).toBeUndefined();
  });

  it("spaces requests by the shortest window's gap, counted from the previous answer, else from its send", () => {
    const budget = new RequestBudget(tableOf(hostWide()));
    const first = budget.take(0, read());
    budget.sent(first, 10);
    // on its way: the gap counts from its send
    expect(budget.waitMs(50, read()).ms).toBe(60);
    budget.settle(first, 80, 200);
    expect(budget.waitMs(100, read()).ms).toBe(80);
    expect(budget.waitMs(180, read()).ms).toBe(0);
    // no answer (a timeout): from its send
    const second = budget.take(200, read());
    budget.sent(second, 200);
    budget.settle(second, undefined, 0);
    expect(budget.waitMs(250, read()).ms).toBe(50);
  });

  it("adds no gap for a counterpart without the shortest window — its minute alone holds it", () => {
    const starts: Counterpart = { name: "starts", match: { host: HOST, method: "PUT" }, limits: [limit(5, 60)] };
    const budget = new RequestBudget(tableOf(hostWide(), starts));
    answered(budget, 0, start());
    // 100 ms of the host's second, not the 12 s a minute of five would give
    expect(budget.waitMs(100, start()).ms).toBe(0);
  });

  it("lets the longest wait win and an open request's end win over any time", () => {
    const channels: Counterpart = {
      name: "channels",
      match: { host: HOST, pathPattern: "^/api/homeappliances/events$" },
      limits: [limit(1, undefined, { concurrent: true })],
    };
    const budget = new RequestBudget(tableOf(hostWide(limit(2, 60)), channels));
    const stream = budget.take(0, read("/api/homeappliances/events"));
    budget.sent(stream, 0);
    budget.answer(stream, 5, 200);
    answered(budget, 100, read());
    // the host's minute holds both: it frees with the earlier one, 60 s after the stream's answer
    expect(budget.waitMs(200, read()).ms).toBe(MINUTE + 5 - 200);
    // a second stream also waits on the open channel, which no time frees
    expect(budget.waitMs(200, read("/api/homeappliances/events"))).toEqual({
      ms: undefined,
      window: { name: "channels", key: "concurrent", max: 1, seconds: undefined },
    });
  });
});

describe("a place holds while its request is on its way, then a window's length after its end", () => {
  const slow: Counterpart = { name: "slow", match: { host: HOST, pathPattern: "^/api/x$" }, limits: [limit(2, 60)] };

  it("holds an open place until its answer, then a minute after the answer, and one without answer from its send", () => {
    const budget = new RequestBudget(tableOf(hostWide(), slow));
    const a = budget.take(0, read("/api/x"));
    budget.sent(a, 0);
    const b = budget.take(100, read("/api/x"));
    budget.sent(b, 100);
    // two on their way: only an end can free a place
    expect(budget.waitMs(5_000, read("/api/x")).ms).toBeUndefined();
    budget.settle(a, 1_000, 200);
    expect(budget.waitMs(5_000, read("/api/x")).ms).toBe(1_000 + MINUTE - 5_000);
    budget.settle(b, undefined, 0);
    // b ended without an answer: it frees a minute after its send — before a's
    expect(budget.waitMs(5_000, read("/api/x")).ms).toBe(100 + MINUTE - 5_000);
    expect(budget.held(5_000, "slow", "60")).toBe(2);
    expect(budget.held(100 + MINUTE, "slow", "60")).toBe(1);
  });

  it("raises the send stamp only while the request is on its way, and keeps the first answer", () => {
    const budget = new RequestBudget(tableOf(hostWide(), slow));
    const place = budget.take(0, read("/api/x"));
    budget.sent(place, 30);
    expect(place.sentAt).toBe(30);
    budget.answer(place, 40, 200);
    budget.sent(place, 90);
    budget.answer(place, 95, 500);
    expect(place).toMatchObject({ sentAt: 30, answeredAt: 40, failed: false, open: false, closed: false });
    budget.settle(place, 99, 500);
    expect(place).toMatchObject({ answeredAt: 40, failed: false, closed: true });
  });

  it("gives back the place of a request that never went out, never one that did", () => {
    const budget = new RequestBudget(tableOf(hostWide(), slow));
    const never = budget.take(0, read("/api/x"));
    budget.drop(never);
    expect(budget.held(0, "slow", "60")).toBe(0);
    const went = answered(budget, 0, read("/api/x"));
    budget.drop(went);
    expect(budget.held(0, "slow", "60")).toBe(1);
  });

  it("counts the calls open at once from their send until they ended — a stream until it closed, not its answer", () => {
    const channels: Counterpart = {
      name: "channels",
      match: { host: HOST, pathPattern: "^/api/homeappliances(?:/[^/]+)?/events$" },
      limits: [limit(2, undefined, { concurrent: true })],
    };
    const budget = new RequestBudget(tableOf(hostWide(), channels));
    const streams = [0, 100].map(t => {
      const place = budget.take(t, read("/api/homeappliances/events"));
      budget.sent(place, t);
      budget.answer(place, t + 5, 200);
      return place;
    });
    expect(budget.held(DAY, "channels", "concurrent")).toBe(2);
    expect(budget.waitMs(DAY, read("/api/homeappliances/ha1/events")).ms).toBeUndefined();
    budget.close(streams[0]);
    expect(budget.held(300, "channels", "concurrent")).toBe(1);
    expect(budget.waitMs(300, read("/api/homeappliances/ha1/events")).ms).toBe(0);
  });

  it("counts in a window of errors only the answers with an error — and a request on its way, which may become one", () => {
    const errors: Counterpart = {
      name: "errors",
      match: { host: HOST },
      limits: [limit(2, 600, { errors: true })],
    };
    const budget = new RequestBudget(tableOf(hostWide(), errors));
    answered(budget, 0, read(), 200);
    answered(budget, 100, read(), 404);
    expect(budget.held(200, "errors", "600 errors")).toBe(1);
    const open = budget.take(200, read());
    budget.sent(open, 200);
    expect(budget.waitMs(300, read())).toEqual({
      ms: 100 + 600_000 - 300,
      window: { name: "errors", key: "600 errors", max: 2, seconds: 600 },
    });
    budget.settle(open, 250, 200);
    expect(budget.waitMs(350, read()).ms).toBe(0);
  });

  it("counts in a window of a series only the error answers after the latest answer without one", () => {
    const series: Counterpart = {
      name: "series",
      match: { host: HOST, pathPattern: "^/api/.*$" },
      limits: [limit(3, 600, { errors: "successive" })],
    };
    const budget = new RequestBudget(tableOf(hostWide(), series));
    answered(budget, 0, read(), 404);
    answered(budget, 100, read(), 409);
    expect(budget.held(200, "series", "600 successive errors")).toBe(2);
    // an answer without an error ends the series at once
    answered(budget, 200, read(), 200);
    expect(budget.held(300, "series", "600 successive errors")).toBe(0);
    for (const t of [300, 400, 500]) {
      answered(budget, t, read(), 500);
    }
    expect(budget.waitMs(600, read())).toEqual({
      ms: 300 + 600_000 - 600,
      window: { name: "series", key: "600 successive errors", max: 3, seconds: 600 },
    });
    // a request outside the counterpart neither counts nor ends the series
    answered(budget, 700, refresh, 200);
    expect(budget.held(800, "series", "600 successive errors")).toBe(3);
    // every error leaves the window a window's length after its own answer
    expect(budget.waitMs(300 + 600_000, read()).ms).toBe(0);
  });

  it("orders a series by the answers — a request on its way counts, one without an answer neither counts nor ends it", () => {
    const series: Counterpart = {
      name: "series",
      match: { host: HOST, pathPattern: "^/api/.*$" },
      limits: [limit(2, 600, { errors: "successive" })],
    };
    const budget = new RequestBudget(tableOf(hostWide(), series));
    const slow = budget.take(0, read());
    budget.sent(slow, 0);
    answered(budget, 100, read(), 404);
    // on its way it may still become an error — and its answer decides before any time does: no hold of ten minutes
    // for a request that may well succeed
    expect(budget.held(200, "series", "600 successive errors")).toBe(2);
    expect(budget.waitMs(200, read())).toEqual({
      ms: undefined,
      window: { name: "series", key: "600 successive errors", max: 2, seconds: 600 },
    });
    // sent first, answered last: its answer without an error ends the error answered before it — and says so, the
    // queue looks again at once
    expect(budget.settle(slow, 300, 200)).toBe(true);
    expect(budget.held(400, "series", "600 successive errors")).toBe(0);
    // a second answer without an error ends no series: nothing frees, nothing to say
    const calm = budget.take(350, read());
    budget.sent(calm, 350);
    expect(budget.settle(calm, 360, 200)).toBe(false);
    answered(budget, 500, read(), 404);
    const lost = budget.take(600, read());
    budget.sent(lost, 600);
    budget.settle(lost, undefined, 0);
    // the transport stamps its own failure with a time too: still no answer
    const failed = budget.take(650, read());
    budget.sent(failed, 650);
    budget.settle(failed, 660, 0);
    expect(failed).toMatchObject({ failed: false, open: false, closed: true });
    expect(failed.answeredAt).toBeUndefined();
    expect(budget.held(700, "series", "600 successive errors")).toBe(1);
    answered(budget, 800, read(), 404);
    expect(budget.waitMs(900, read())).toMatchObject({ ms: 500 + 600_000 - 900, window: { name: "series" } });
  });

  it("names the REST API's series as the window of errors a REST read counts in — never the token endpoint's calls", () => {
    const budget = new RequestBudget(counterparts);
    expect(budget.errorWindow(read("/api/homeappliances/ha1/status"))).toEqual({
      name: "Home Connect REST API",
      key: "600 successive errors",
      max: 10,
      seconds: 600,
    });
    expect(budget.errorWindow(refresh)).toBeUndefined();
    expect(budget.errorWindow(read("/api/homeappliances/events"))?.name).toBe("Home Connect REST API");
  });

  it("holds the eleventh REST request after ten successive error answers until the first leaves the window", () => {
    const budget = new RequestBudget(counterparts);
    for (let n = 0; n < 10; n++) {
      answered(budget, n * 200, read(), 409);
    }
    expect(budget.waitMs(2_000, read())).toEqual({
      ms: 600_000 - 2_000,
      window: { name: "Home Connect REST API", key: "600 successive errors", max: 10, seconds: 600 },
    });
    // the token refresh is no REST request: the series never holds it
    expect(budget.waitMs(2_000, refresh).ms).toBe(0);
  });

  it("keeps a lane per device for a limit per device, and one per host for a limit per host", () => {
    const perDevice: Counterpart = {
      name: "per device",
      match: { host: HOST, method: "PUT", pathPattern: "^/api/homeappliances/(?<device>[^/]+)/programs/active$" },
      limits: [limit(1, 60, { per: "device" })],
    };
    const perHost: Counterpart = { name: "per host", match: { host: HOST }, limits: [limit(3, 60, { per: "host" })] };
    const budget = new RequestBudget(tableOf(hostWide(), perDevice, perHost));
    answered(budget, 0, start("ha1"));
    expect(budget.waitMs(100, start("ha2")).ms).toBe(0);
    expect(budget.waitMs(100, start("ha1"))).toMatchObject({ ms: MINUTE - 100, window: { name: "per device" } });
    expect(budget.sortOf(start("ha1"))).not.toBe(budget.sortOf(start("ha2")));
    answered(budget, 100, start("ha2"));
    answered(budget, 200, read());
    expect(budget.waitMs(300, read())).toMatchObject({ ms: MINUTE - 300, window: { name: "per host" } });
  });

  it("sorts two calls alike exactly when they count in the same windows and lanes", () => {
    const budget = new RequestBudget(counterparts);
    expect(budget.sortOf(read("/api/homeappliances/a/status"))).toBe(budget.sortOf(read("/api/homeappliances")));
    expect(budget.sortOf(read())).not.toBe(budget.sortOf(start()));
    expect(budget.sortOf(start())).not.toBe(budget.sortOf({ ...start(), method: "DELETE" }));
  });
});

// The adapter writes `{ windows: heldPlaces(now) }` into the budget file and reads it back through the fleet master
// data-file.ts (main.ts); here the file is its JSON text.
describe("the request budget across a restart", () => {
  /**
   * The budget file's text as the adapter writes it.
   *
   * @param windows the places per counterpart, window and lane
   * @returns the JSON text
   */
  const fileText = (windows: HeldPlaces): string => JSON.stringify({ windows });
  /**
   * What the next process reads back from that text.
   *
   * @param text the file's JSON text
   * @returns the parsed content
   */
  const fileContent = (text: string): unknown => JSON.parse(text);

  it("hands the next process every place per counterpart, window and lane — an open one from the hand-over", () => {
    const budget = new RequestBudget(counterparts);
    answered(budget, 1_000, start());
    const open = budget.take(2_000, read());
    budget.sent(open, 2_000);
    expect(budget.heldPlaces(5_000)).toEqual({
      "Home Connect API": { 1: { account: [5_000] }, 60: { account: [1_000, 5_000] } },
      // a request on its way is no error answer yet: the series takes only the answered errors
      "Home Connect REST API": { 86400: { account: [1_000, 5_000] } },
      "Home Connect program starts": { 60: { account: [1_000] } },
    });
  });

  it("hands over the series of error answers that still runs, and the next process holds the request after it", () => {
    const first = new RequestBudget(counterparts);
    answered(first, 0, read(), 500);
    answered(first, 100, read(), 200);
    for (let n = 0; n < 10; n++) {
      answered(first, 200 + n * 100, read(), 409);
    }
    const f = fileText(first.heldPlaces(2_000));
    // the error before the answer without one is over — only the series after it goes to the file
    expect(first.heldPlaces(2_000)["Home Connect REST API"]["600 successive errors"]).toEqual({
      account: [200, 300, 400, 500, 600, 700, 800, 900, 1_000, 1_100],
    });
    const next = new RequestBudget(counterparts);
    next.restore(heldPlacesOf(fileContent(f), 3_000), 3_000, read());
    expect(next.waitMs(3_000, read())).toMatchObject({
      ms: 200 + 600_000 - 3_000,
      window: { name: "Home Connect REST API", key: "600 successive errors" },
    });
    // the series goes on in the next process until an answer without an error ends it
    answered(next, 600_200, read(), 200);
    expect(next.held(600_300, "Home Connect REST API", "600 successive errors")).toBe(0);
  });

  it("takes the places over so a restart within the minute holds the sixth start", () => {
    const first = new RequestBudget(counterparts);
    for (let n = 0; n < 5; n++) {
      answered(first, n * 100, start(`ha${n}`));
    }
    const f = fileText(first.heldPlaces(1_000));
    const next = new RequestBudget(counterparts);
    next.restore(heldPlacesOf(fileContent(f), 2_000), 2_000, read());
    expect(next.waitMs(2_000, start("ha5"))).toMatchObject({
      ms: MINUTE - 2_000,
      window: { name: "Home Connect program starts" },
    });
    expect(next.held(2_000, "Home Connect REST API", "86400")).toBe(5);
    // a place whose window is over by the restart is not taken over
    const late = new RequestBudget(counterparts);
    late.restore(heldPlacesOf(fileContent(f), MINUTE + 50), MINUTE + 50, read());
    expect(late.held(MINUTE + 50, "Home Connect program starts", "60")).toBe(4);
    expect(late.held(MINUTE + 50, "Home Connect REST API", "86400")).toBe(5);
  });

  it("writes no request's path or body into the file — only times per window and lane", () => {
    const budget = new RequestBudget(counterparts);
    answered(budget, 1_000, refresh);
    answered(budget, 1_100, read("/api/homeappliances/SIEMENS-HB676G5S6-68A40E000000/programs/active"));
    const text = fileText(budget.heldPlaces(2_000));
    expect(text).not.toMatch(/SECRET-TOKEN|grant_type|SIEMENS|programs|security/);
    expect(JSON.parse(text)).toEqual({
      windows: {
        // the second of the refresh at 1 000 is over at 2 000
        "Home Connect API": { 1: { account: [1_100] }, 60: { account: [1_000, 1_100] } },
        "Home Connect REST API": { 86400: { account: [1_100] } },
        "Home Connect token refresh": { 60: { account: [1_000] }, 86400: { account: [1_000] } },
      },
    });
  });

  it("reads the single list of an earlier version as places of a REST read — never of a program start", () => {
    const kept = heldPlacesOf({ heldFrom: [40_000, 90_000] }, 95_000);
    expect(kept).toEqual({ windows: {}, earlier: [40_000, 90_000] });
    const budget = new RequestBudget(counterparts);
    budget.restore(kept, 95_000, read());
    expect(budget.held(95_000, "Home Connect REST API", "86400")).toBe(2);
    expect(budget.held(95_000, "Home Connect API", "60")).toBe(2);
    expect(budget.held(95_000, "Home Connect API", "1")).toBe(0);
    expect(budget.held(95_000, "Home Connect program starts", "60")).toBe(0);
    expect(budget.held(95_000, "Home Connect token refresh", "60")).toBe(0);
    // 2.0.0-alpha.0 wrote `sentAt`; the newer `heldFrom` wins where both stand
    expect(heldPlacesOf({ sentAt: [40_000] }, 95_000).earlier).toEqual([40_000]);
    expect(heldPlacesOf({ sentAt: [40_000], heldFrom: [91_000] }, 95_000).earlier).toEqual([91_000]);
  });

  it("starts with a full budget without a file or with a foreign content, and never takes a time from the future", () => {
    const empty = { windows: {}, earlier: [] };
    // no file, or one that cannot be read: the master's read hands no value
    expect(heldPlacesOf(undefined, 1_000)).toEqual(empty);
    expect(heldPlacesOf({ windows: 5, heldFrom: 5 }, 1_000)).toEqual(empty);
    expect(heldPlacesOf([1, 2], 1_000)).toEqual(empty);
    const content = fileContent(
      JSON.stringify({
        windows: {
          "Home Connect API": { 60: { account: ["5", null, 900, 2_000, 300] }, 1: { account: [2_000] }, x: 3 },
          other: 7,
        },
        heldFrom: [Number.MAX_VALUE, 800],
      }),
    );
    // only numbers, never one from the future (a clock set back would block a whole window), oldest first
    expect(heldPlacesOf(content, 1_000)).toEqual({
      windows: { "Home Connect API": { 60: { account: [300, 900] } } },
      earlier: [800],
    });
  });

  it("forgets a place once it counts in no window any more", () => {
    const budget = new RequestBudget(counterparts);
    answered(budget, 0, read());
    expect(budget.held(DAY - 1, "Home Connect REST API", "86400")).toBe(1);
    budget.waitMs(DAY, read());
    expect(budget.heldPlaces(DAY)).toEqual({});
  });
});
