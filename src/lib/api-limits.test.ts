import { describe, expect, it } from "vitest";
import { declaredLimit } from "./api-limits";

describe("declared Home Connect limits", () => {
  it("reads the per-minute budget the transport keeps from the declaration", () => {
    // api-docs → Rate Limiting: 50 requests per client and user account per minute.
    expect(declaredLimit(60)).toBe(50);
    expect(declaredLimit(86400)).toBe(1000);
  });

  it("names a window the declaration does not carry instead of inventing a number", () => {
    expect(() => declaredLimit(3600)).toThrow("declares no limit for 3600 s");
  });
});
