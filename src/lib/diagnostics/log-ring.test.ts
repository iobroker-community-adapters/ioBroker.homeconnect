import { describe, expect, it, vi } from "vitest";
import { LogRing, type HookableLog } from "./log-ring";

describe("LogRing", () => {
  it("hears every level and still logs as before", () => {
    const original = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log: HookableLog = { ...original };
    const ring = new LogRing(10, () => 0);
    ring.hook(log);
    log.debug("dev-2b3c: swept");
    log.warn("dev-2b3c: refused");
    expect(original.debug).toHaveBeenCalledWith("dev-2b3c: swept");
    expect(original.warn).toHaveBeenCalledWith("dev-2b3c: refused");
    expect(ring.about(["dev-2b3c"], []).map(line => line.level)).toEqual(["debug", "warn"]);
  });

  it("keeps only the newest lines", () => {
    const ring = new LogRing(3);
    for (let i = 0; i < 5; i++) {
      ring.add("info", `line ${i}`);
    }
    expect(ring.about([], []).map(line => line.msg)).toEqual(["line 2", "line 3", "line 4"]);
  });

  it("gives a device its own lines and the adapter-wide ones, not another device's", () => {
    const ring = new LogRing();
    ring.add("info", "dev-2b3c: ready");
    ring.add("info", "dev-f504: ready");
    ring.add("info", "network search finished");
    ring.add("debug", "10.0.0.5 answered");
    expect(ring.about(["dev-2b3c", "10.0.0.5"], ["dev-f504", "10.0.0.6"]).map(line => line.msg)).toEqual([
      "dev-2b3c: ready",
      "network search finished",
      "10.0.0.5 answered",
    ]);
  });

  // Review 2026-10-05, B4: a substring match handed a device the lines of every device whose id or address
  // starts like its own.
  it("matches ids and addresses as whole tokens, not as prefixes of a longer one", () => {
    const ring = new LogRing();
    ring.add("info", "lamp-2: ready");
    ring.add("debug", "10.0.0.50: description fetch failed");
    ring.add("info", "lamp: ready");
    ring.add("debug", "state demo.0.lamp.power written");
    ring.add("debug", "connected to 10.0.0.5.");
    expect(ring.about(["lamp", "10.0.0.5"], ["lamp-2", "10.0.0.50"]).map(line => line.msg)).toEqual([
      "lamp: ready",
      "state demo.0.lamp.power written",
      "connected to 10.0.0.5.",
    ]);
    // And the other way round: the longer id gets its own lines, never the shorter one's.
    expect(ring.about(["lamp-2", "10.0.0.50"], ["lamp", "10.0.0.5"]).map(line => line.msg)).toEqual([
      "lamp-2: ready",
      "10.0.0.50: description fetch failed",
    ]);
  });
});
