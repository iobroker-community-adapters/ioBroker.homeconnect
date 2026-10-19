import { describe, expect, it } from "vitest";
import { ByteRing, sizeOf } from "./byte-ring";

describe("ByteRing", () => {
  it("counts a repeat instead of stacking it and moves it to the newest place (R1)", () => {
    let t = 0;
    const ring = new ByteRing<string>(10_000, 1_000, () => t);
    ring.add("a", "first answer");
    t = 1_000;
    ring.add("b", "other answer");
    t = 2_000;
    ring.add("a", "first answer again");
    const entries = ring.snapshot();
    expect(entries.map(e => e.content)).toEqual(["other answer", "first answer again"]);
    expect(entries[1]).toMatchObject({
      count: 2,
      first: new Date(0).toISOString(),
      last: new Date(2_000).toISOString(),
    });
    expect(entries[0].count).toBe(1);
  });

  it("drops whole entries from the oldest end until it fits its byte limit (R2, R3)", () => {
    const one = sizeOf({
      first: new Date(0).toISOString(),
      last: new Date(0).toISOString(),
      count: 1,
      content: "x".repeat(50),
    });
    const ring = new ByteRing<string>(one * 2, 1_000, () => 0);
    ring.add("a", "x".repeat(50));
    ring.add("b", "x".repeat(50));
    ring.add("c", "x".repeat(50));
    expect(ring.snapshot().map(e => e.content?.length)).toEqual([50, 50]);
    expect(ring.snapshot()).toHaveLength(2);
  });

  it("keeps an entry over the entry limit with its size only (R3)", () => {
    const ring = new ByteRing<string>(10_000, 20, () => 0);
    ring.add("big", "y".repeat(100));
    const [entry] = ring.snapshot();
    expect(entry.content).toBeUndefined();
    expect(entry.omittedBytes).toBe(sizeOf("y".repeat(100)));
  });

  it("keeps the newest entry even when it alone is over the ring limit", () => {
    const ring = new ByteRing<string>(10, 1_000, () => 0);
    ring.add("a", "short");
    ring.add("b", "z".repeat(200));
    expect(ring.snapshot().map(e => e.content)).toEqual(["z".repeat(200)]);
  });

  it("hands out a copy — the report never changes the ring", () => {
    const ring = new ByteRing<string>(10_000, 1_000);
    ring.add("a", "kept");
    ring.snapshot()[0].count = 99;
    expect(ring.snapshot()[0].count).toBe(1);
  });

  it("measures undefined as zero bytes", () => {
    expect(sizeOf(undefined)).toBe(0);
  });
});
