// Fleet master (.consistency-master/src/lib/log-once.test.ts) — never edit the copy in an adapter.
import { describe, expect, it } from "vitest";
import { LogOnce, type LogOnceLogger } from "./log-once";

function logger(): LogOnceLogger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    debug: m => lines.push(`debug ${m}`),
    info: m => lines.push(`info ${m}`),
    warn: m => lines.push(`warn ${m}`),
    error: m => lines.push(`error ${m}`),
  };
}

describe("LogOnce", () => {
  it("says a problem once, a repeat goes to debug, another text is a new problem", () => {
    const log = logger();
    const once = new LogOnce(log);
    expect(once.report("dev1", "timeout")).toBe(true);
    expect(once.report("dev1", "timeout")).toBe(false);
    expect(once.report("dev1", "refused")).toBe(true);
    expect(once.report("dev2", "refused")).toBe(true);
    expect(log.lines).toEqual(["warn timeout", "debug timeout", "warn refused", "warn refused"]);
  });

  it("decides by kind when given, at the level given", () => {
    const log = logger();
    const once = new LogOnce(log);
    once.report("cloud", "HTTP 503 at 10:01", { kind: "SERVER", level: "error" });
    once.report("cloud", "HTTP 502 at 10:02", { kind: "SERVER", level: "error" });
    once.report("cloud", "login rejected", { kind: "AUTH", level: "info" });
    expect(log.lines).toEqual(["error HTTP 503 at 10:01", "debug HTTP 502 at 10:02", "info login rejected"]);
  });

  it("is loud again once the window has passed", () => {
    const log = logger();
    let now = 1000;
    const once = new LogOnce(log, { windowMs: 60_000, now: () => now });
    once.report("p", "down");
    now += 59_999;
    once.report("p", "down");
    now += 1;
    once.report("p", "down");
    expect(log.lines).toEqual(["warn down", "debug down", "warn down"]);
  });

  it("remembers at most maxKeys, the oldest goes first", () => {
    const log = logger();
    const once = new LogOnce(log, { maxKeys: 2 });
    once.report("a", "x");
    once.report("b", "x");
    once.report("a", "y");
    once.report("c", "x");
    once.report("b", "x");
    once.report("a", "y");
    expect(log.lines).toEqual(["warn x", "warn x", "warn y", "warn x", "warn x", "warn y"]);
  });

  it("reads the real clock when given none", () => {
    const log = logger();
    const once = new LogOnce(log, { windowMs: 3_600_000 });
    once.report("p", "down");
    once.report("p", "down");
    expect(log.lines).toEqual(["warn down", "debug down"]);
  });

  it("says a recovery once after a loud line, debug otherwise, and starts the key anew", () => {
    const log = logger();
    const once = new LogOnce(log);
    expect(once.recovered("dev1", "dev1 answers again")).toBe(false);
    once.report("dev1", "timeout");
    expect(once.recovered("dev1", "dev1 answers again")).toBe(true);
    expect(once.recovered("dev1", "dev1 answers again")).toBe(false);
    once.report("dev1", "timeout");
    expect(log.lines).toEqual([
      "debug dev1 answers again",
      "warn timeout",
      "info dev1 answers again",
      "debug dev1 answers again",
      "warn timeout",
    ]);
  });

  it("forgets a key without a line", () => {
    const log = logger();
    const once = new LogOnce(log);
    once.report("dev1", "timeout");
    once.forget("dev1");
    once.report("dev1", "timeout");
    expect(log.lines).toEqual(["warn timeout", "warn timeout"]);
  });
});
