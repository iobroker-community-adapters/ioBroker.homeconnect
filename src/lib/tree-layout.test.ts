import { describe, expect, it } from "vitest";

import { layoutChannel } from "./tree-layout";

describe("layoutChannel (tree layout, krobi 2026-10-16)", () => {
  it("moves the running program's values to run and the totals to counters", () => {
    expect(layoutChannel("status", "remainingProgramTime")).toBe("run");
    expect(layoutChannel("status", "programAllCountStarted")).toBe("counters");
    expect(layoutChannel("status", "detergentAllConsumed")).toBe("counters");
    expect(layoutChannel("status", "operationState")).toBe("status");
  });

  it("regroups status values only — every other channel keeps its datapoints, whatever their name", () => {
    expect(layoutChannel("options", "remainingProgramTime")).toBe("options");
    expect(layoutChannel("settings", "programAllCountStarted")).toBe("settings");
  });
});
