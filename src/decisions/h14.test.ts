// Core decision H-14 (accepted 2026-10-15): when a Home Connect quota blocks, the log says which limit and for how long,
// in one line, without overdoing it. krobi 2026-09-30 17:25/17:26: "The log must communicate that clearly to the user"
// · "But don't overdo it".
import { describe, expect, it } from "vitest";
import { rateLimitText } from "../lib/http";

describe("H-14 a quota block is one clear log line", () => {
  it("names the limit and the wait", () => {
    // Home Connect's own wording of the description (api-docs, Rate Limiting).
    const said = (limit: string, seconds: number): string =>
      `The rate limit "${limit}" was reached. Requests are blocked during the remaining period of ${seconds} seconds.`;
    expect(rateLimitText(said("50 calls in 1 minute", 54))).toBe(
      "Home Connect blocks requests for 54 s (limit: 50 calls in 1 minute)",
    );
    expect(rateLimitText(said("1000 calls in 1 day", 18_295))).toBe(
      "Home Connect blocks requests for 5 h 5 min (limit: 1000 calls in 1 day)",
    );
  });

  it("keeps to what it knows when Home Connect names no limit", () => {
    const text = rateLimitText(undefined, 60_000);
    expect(text).toContain("60 s");
    expect(text.split("\n")).toHaveLength(1);
  });
});
