import { describe, expect, it } from "vitest";
import { declaredLimit, minimumGapMs } from "./api-limits";

describe("declared Home Connect limits", () => {
  it("reads the per-minute budget the transport keeps from the declaration", () => {
    // api-docs → Rate Limiting: 50 requests per client and user account per minute.
    expect(declaredLimit(60)).toBe(50);
    expect(declaredLimit(86400)).toBe(1000);
  });

  it("takes the strictest limit of a window — the average of 10 per second, not the burst of 20 declared first", () => {
    expect(declaredLimit(1)).toBe(10);
  });

  it("derives the least gap from the strictest limit of the shortest window", () => {
    // 10 requests per second → 100 ms, without a reserve (the transport stamps after the call went out).
    expect(minimumGapMs()).toBe(100);
  });

  it("names a window the declaration does not carry instead of inventing a number", () => {
    expect(() => declaredLimit(3600)).toThrow("declares no limit for 3600 s");
  });
});
