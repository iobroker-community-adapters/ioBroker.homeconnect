import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHeldTimes, RequestBudget, writeHeldTimes, type PacedWindow } from "./request-budget";

/** The minute window of the Home Connect declaration, in ms. */
const MINUTE = 60_000;
/** The second and the minute with the declared limits (src/lib/api-limits.json: 10 per second, 50 per minute). */
const WINDOWS: PacedWindow[] = [
  { seconds: 1, max: 10 },
  { seconds: 60, max: 50 },
];

describe("the request budget across a restart", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const file = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hc-budget-"));
    dirs.push(dir);
    return join(dir, "homeconnect.0", "request-times.json");
  };

  it("hands the next process the times the places of the last minute count from, the folder created on the way", () => {
    const f = file();
    writeHeldTimes(f, [1_000, 50_000, 70_000, 100_000], 100_500, MINUTE);
    // Only the last minute is kept.
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ heldFrom: [50_000, 70_000, 100_000] });
    // 1_000 left the window before the stop; the rest still counts at the next start.
    expect(readHeldTimes(f, 101_000, MINUTE)).toEqual([50_000, 70_000, 100_000]);
    // A minute after its time a place no longer counts.
    expect(readHeldTimes(f, 130_000, MINUTE)).toEqual([100_000]);
  });

  it("reads the send times 2.0.0-alpha.0 left — a tester upgrades with that file in the data folder", () => {
    const f = file();
    writeHeldTimes(f, [], 0, MINUTE);
    writeFileSync(f, JSON.stringify({ sentAt: [40_000, 90_000] }));
    expect(readHeldTimes(f, 95_000, MINUTE)).toEqual([40_000, 90_000]);
    // the new key wins where both stand
    writeFileSync(f, JSON.stringify({ sentAt: [40_000], heldFrom: [95_000] }));
    expect(readHeldTimes(f, 100_000, MINUTE)).toEqual([95_000]);
  });

  it("starts with a full budget when there is no file or one it cannot read", () => {
    const f = file();
    expect(readHeldTimes(f, 1_000, MINUTE)).toEqual([]);
    writeHeldTimes(f, [], 0, MINUTE);
    writeFileSync(f, "{not json");
    expect(readHeldTimes(f, 1_000, MINUTE)).toEqual([]);
    writeFileSync(f, JSON.stringify({ heldFrom: 5 }));
    expect(readHeldTimes(f, 1_000, MINUTE)).toEqual([]);
    writeFileSync(f, JSON.stringify({ heldFrom: ["5", null, 900, 2_000] }));
    // Only numbers, never one from the future (a clock set back would block the whole minute).
    expect(readHeldTimes(f, 1_000, MINUTE)).toEqual([900]);
  });

  it("round-trips the budget: answered places count from their answer, open ones from the hand-over", () => {
    const f = file();
    const first = new RequestBudget();
    const answered = first.take(0);
    first.sent(answered, 5);
    first.settle(answered, 2_000);
    const lost = first.take(3_000);
    first.sent(lost, 3_000);
    first.settle(lost, undefined);
    first.sent(first.take(4_000), 4_000);
    const stop = 10_000;
    writeHeldTimes(f, first.heldFrom(stop, 60), stop, MINUTE);
    expect(JSON.parse(readFileSync(f, "utf8"))).toEqual({ heldFrom: [2_000, 3_000, stop] });
    const next = new RequestBudget();
    next.restore(readHeldTimes(f, 12_000, MINUTE));
    expect(next.held(12_000, 60)).toBe(3);
    // the answered one frees a minute after its answer, the lost one a minute after its send, the open one a minute
    // after the hand-over
    expect(next.held(62_000 - 1, 60)).toBe(3);
    expect(next.held(62_000, 60)).toBe(2);
    expect(next.held(63_000, 60)).toBe(1);
    expect(next.held(stop + MINUTE, 60)).toBe(0);
  });
});

describe("the places of the request budget (tooling round 170)", () => {
  /**
   * Fill a budget with requests sent `gap` ms apart, each answered `answerMs` after its send.
   *
   * @param count how many requests
   * @param gap ms between two sends
   * @param answerMs ms from send to answer
   * @returns the budget
   */
  const filled = (count: number, gap: number, answerMs: number): RequestBudget => {
    const budget = new RequestBudget();
    for (let n = 0; n < count; n++) {
      const place = budget.take(n * gap);
      budget.sent(place, n * gap);
      budget.settle(place, n * gap + answerMs);
    }
    return budget;
  };

  it("holds the 51st request until a minute after the first one's answer", () => {
    const budget = filled(50, 100, 68);
    expect(budget.waitMs(MINUTE, WINDOWS, 100)).toBe(68);
    expect(budget.waitMs(MINUTE + 68, WINDOWS, 100)).toBe(0);
  });

  it("holds the 11th request of a second until a second after the first one's answer", () => {
    const budget = filled(10, 100, 20);
    // 100 ms after the 10th send: the gap is over, the second is not
    expect(budget.waitMs(1_000, WINDOWS, 100)).toBe(20);
  });

  it("keeps the places of the longest window although a call passes only the shorter ones", () => {
    const DAY = 86_400;
    const budget = new RequestBudget(DAY);
    const place = budget.take(0);
    budget.sent(place, 0);
    budget.settle(place, 10);
    // a sign-in request waits only for the second and the minute — the day's place must not be forgotten by it
    expect(budget.waitMs(2 * MINUTE, WINDOWS, 100)).toBe(0);
    expect(budget.held(2 * MINUTE, DAY)).toBe(1);
    expect(budget.waitMs(2 * MINUTE, [...WINDOWS, { seconds: DAY, max: 1 }], 100)).toBe(DAY * 1000 + 10 - 2 * MINUTE);
  });

  it("counts the gap from the previous answer, else from its send", () => {
    const budget = new RequestBudget();
    const first = budget.take(0);
    budget.sent(first, 0);
    // still on its way: from its send
    expect(budget.waitMs(40, WINDOWS, 100)).toBe(60);
    budget.settle(first, 50);
    expect(budget.waitMs(60, WINDOWS, 100)).toBe(90);
    const second = budget.take(150);
    budget.sent(second, 150);
    budget.settle(second, undefined);
    expect(budget.waitMs(200, WINDOWS, 100)).toBe(50);
  });

  it("lets an open request hold its place, and waits for an end when only open ones fill a window", () => {
    const budget = new RequestBudget();
    const open = Array.from({ length: 10 }, (_, n) => {
      const place = budget.take(n * 100);
      budget.sent(place, n * 100);
      return place;
    });
    expect(budget.waitMs(5_000, WINDOWS, 100)).toBeUndefined();
    // one ends without an answer: a second after its send is long past
    budget.settle(open[3], undefined);
    expect(budget.waitMs(5_000, WINDOWS, 100)).toBe(0);
    budget.take(5_000);
    // the next one answered now frees a second from now
    budget.settle(open[4], 5_100);
    expect(budget.waitMs(5_100, WINDOWS, 100)).toBe(1_000);
  });

  it("forgets a place given back before its request went out", () => {
    const budget = new RequestBudget();
    const place = budget.take(0);
    budget.drop(place);
    expect(budget.held(0, 60)).toBe(0);
    expect(budget.waitMs(0, WINDOWS, 100)).toBe(0);
    // a request that went out stays
    const kept = budget.take(10);
    budget.sent(kept, 10);
    budget.settle(kept, 30);
    budget.drop(kept);
    expect(budget.held(40, 60)).toBe(1);
  });
});
