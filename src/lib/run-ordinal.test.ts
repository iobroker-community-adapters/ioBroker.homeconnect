import { describe, it, expect } from "vitest";
import { runSegment } from "./run-ordinal";

describe("run ids of the program history (decision 48)", () => {
  it("names the runs counted back from the newest in words, for any length", () => {
    expect(runSegment(1)).toBe("latest");
    expect(runSegment(2)).toBe("previous");
    expect(runSegment(3)).toBe("thirdLatest");
    expect(runSegment(4)).toBe("fourthLatest");
    expect(runSegment(11)).toBe("eleventhLatest");
    expect(runSegment(12)).toBe("twelfthLatest");
    expect(runSegment(19)).toBe("nineteenthLatest");
    expect(runSegment(20)).toBe("twentiethLatest");
    expect(runSegment(21)).toBe("twentyFirstLatest");
    expect(runSegment(42)).toBe("fortySecondLatest");
    expect(runSegment(99)).toBe("ninetyNinthLatest");
  });

  it("stays unique beyond the words", () => {
    expect(runSegment(100)).toBe("run100Latest");
    const ids = Array.from({ length: 120 }, (_, i) => runSegment(i + 1));
    expect(new Set(ids).size).toBe(120);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });
});
