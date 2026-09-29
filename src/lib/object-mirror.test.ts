import { describe, it, expect } from "vitest";
import { ObjectMirror, coveredBy, mergedWith } from "./object-mirror";

const NS = "homeconnect.0";

describe("coveredBy", () => {
  it("is true when every field of the patch already sits in the stored object", () => {
    const stored = {
      type: "state",
      common: { name: { en: "A", de: "A" }, role: "text", read: true },
      native: { k: 1 },
    };
    expect(coveredBy({ common: { name: { de: "A", en: "A" }, read: true } }, stored)).toBe(true);
  });

  it("is false for a changed, added or nulled field", () => {
    const stored = { common: { name: "A", states: { a: "A" } } };
    expect(coveredBy({ common: { name: "B" } }, stored)).toBe(false);
    expect(coveredBy({ common: { unit: "l" } }, stored)).toBe(false);
    expect(coveredBy({ common: { states: null } }, stored)).toBe(false);
  });

  it("compares arrays and values as a whole", () => {
    expect(coveredBy({ native: { list: ["a", "b"] } }, { native: { list: ["a", "b"] } })).toBe(true);
    expect(coveredBy({ native: { list: ["a"] } }, { native: { list: ["a", "b"] } })).toBe(false);
    expect(coveredBy({ common: { max: 0 } }, { common: {} })).toBe(false);
  });

  it("is false when nothing is stored", () => {
    expect(coveredBy({ common: {} }, undefined)).toBe(false);
  });
});

describe("mergedWith", () => {
  it("merges objects key by key, arrays index by index, and lets values and null take the place", () => {
    const stored = { common: { name: "A", states: { a: "A" }, custom: { x: 1 } }, native: { list: ["a", "b"] } };
    const after = mergedWith(stored, { common: { name: "B", states: null }, native: { list: ["c"] } });
    // node.extend(true, …) writes a shorter array over the stored one index by index: the tail stays.
    expect(after).toEqual({ common: { name: "B", states: null, custom: { x: 1 } }, native: { list: ["c", "b"] } });
    // The stored object itself is left as it was.
    expect(stored.common.name).toBe("A");
  });

  it("takes an array whole where nothing or null was stored", () => {
    expect(mergedWith({ native: { list: null } }, { native: { list: ["c"] } })).toEqual({ native: { list: ["c"] } });
    expect(mergedWith({}, { native: { list: ["c"] } })).toEqual({ native: { list: ["c"] } });
  });

  it("ignores undefined in a patch, as extendObject does", () => {
    expect(mergedWith({ common: { name: "A" } }, { common: { name: undefined } })).toEqual({ common: { name: "A" } });
  });
});

describe("ObjectMirror", () => {
  /**
   * A mirror over one stored object.
   *
   * @returns the mirror
   */
  function mirror(): ObjectMirror {
    const m = new ObjectMirror(NS);
    m.load([
      { id: `${NS}.wm-1`, value: { type: "device", common: { name: "Wm" }, native: { haId: "HA-1" } } },
      { id: `${NS}.wm-1.status`, value: { type: "channel", common: { name: "Status" } } },
      { id: `${NS}.wm-1.status.door`, value: { type: "state", common: { name: "Door" } } },
      { id: `${NS}.info`, value: undefined },
    ]);
    return m;
  }

  it("covers a write that changes nothing, by relative or full id", () => {
    const m = mirror();
    expect(m.covers("wm-1.status", { type: "channel", common: { name: "Status" } })).toBe(true);
    expect(m.covers(`${NS}.wm-1.status`, { common: { name: "Status" } })).toBe(true);
    expect(m.covers("wm-1.status", { common: { name: "State" } })).toBe(false);
  });

  it("never covers an object it does not hold", () => {
    const m = mirror();
    expect(m.covers("info", { common: {} })).toBe(false);
    expect(m.covers("wm-1.settings", { common: {} })).toBe(false);
  });

  it("holds what a write left behind, merged", () => {
    const m = mirror();
    m.wrote("wm-1", { native: { programUids: { 31670: "p" } } });
    expect(m.covers("wm-1", { native: { haId: "HA-1", programUids: { 31670: "p" } } })).toBe(true);
    m.wrote("wm-1.new", { type: "state", common: { name: "New" } });
    expect(m.covers("wm-1.new", { common: { name: "New" } })).toBe(true);
  });

  it("holds a whole object written with setForeignObject, nothing merged", () => {
    const m = mirror();
    m.replaced(`${NS}.wm-1`, { type: "device", common: { name: "Other" }, native: {} });
    expect(m.covers("wm-1", { native: { haId: "HA-1" } })).toBe(false);
    expect(m.covers("wm-1", { common: { name: "Other" } })).toBe(true);
  });

  it("forgets a deleted object, and a deleted tree with everything below it", () => {
    const m = mirror();
    m.forget("wm-1.status");
    expect(m.covers("wm-1.status", { common: { name: "Status" } })).toBe(false);
    expect(m.covers("wm-1.status.door", { common: { name: "Door" } })).toBe(true);
    m.forgetTree("wm-1");
    expect(m.covers("wm-1", { common: { name: "Wm" } })).toBe(false);
    expect(m.covers("wm-1.status.door", { common: { name: "Door" } })).toBe(false);
  });

  it("forgets a tree without touching a sibling that shares the prefix", () => {
    const m = new ObjectMirror(NS);
    m.load([
      { id: `${NS}.wm-1`, value: { common: { name: "A" } } },
      { id: `${NS}.wm-10`, value: { common: { name: "B" } } },
    ]);
    m.forgetTree("wm-1");
    expect(m.covers("wm-10", { common: { name: "B" } })).toBe(true);
  });
});
