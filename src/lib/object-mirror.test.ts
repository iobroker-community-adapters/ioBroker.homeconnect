import { describe, it, expect } from "vitest";
import { ObjectMirror, StateMirror, coveredBy, mergedWith } from "./object-mirror";

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

describe("ObjectMirror.readOnly", () => {
  it("is true only for a known state with write false", () => {
    const m = new ObjectMirror(NS);
    m.load([
      { id: `${NS}.info.connection`, value: { type: "state", common: { write: false } } },
      { id: `${NS}.wm-1.settings.power`, value: { type: "state", common: { write: true } } },
      { id: `${NS}.info`, value: { type: "channel", common: { write: false } } },
    ]);
    expect(m.readOnly("info.connection")).toBe(true);
    expect(m.readOnly("wm-1.settings.power")).toBe(false);
    expect(m.readOnly("info")).toBe(false);
    expect(m.readOnly("wm-1.unknown")).toBe(false);
  });
});

describe("StateMirror", () => {
  it("differs for an unknown state, and for another value, ack or quality", () => {
    const m = new StateMirror();
    m.load({ [`${NS}.a`]: { val: false, ack: true, q: 0 } as ioBroker.State, [`${NS}.b`]: null });
    expect(m.differs(`${NS}.a`, { val: false, ack: true })).toBe(false);
    expect(m.differs(`${NS}.a`, { val: 0, ack: true })).toBe(true);
    expect(m.differs(`${NS}.a`, { val: false, ack: false })).toBe(true);
    expect(m.differs(`${NS}.a`, { val: false, ack: true, q: 0x02 })).toBe(true);
    expect(m.differs(`${NS}.b`, { val: null, ack: true })).toBe(true);
  });

  it("holds what was written", () => {
    const m = new StateMirror();
    m.remember(`${NS}.a`, { val: "x", ack: true });
    expect(m.differs(`${NS}.a`, { val: "x", ack: true })).toBe(false);
  });

  it("forgets a deleted state, and with recursive everything below it but not a sibling", () => {
    const m = new StateMirror();
    for (const id of ["wm-1.a", "wm-1.b.c", "wm-10.a"]) {
      m.remember(`${NS}.${id}`, { val: 1, ack: true });
    }
    m.forget(`${NS}.wm-1.a`, false);
    expect(m.differs(`${NS}.wm-1.a`, { val: 1, ack: true })).toBe(true);
    expect(m.differs(`${NS}.wm-1.b.c`, { val: 1, ack: true })).toBe(false);
    m.forget(`${NS}.wm-1`, true);
    expect(m.differs(`${NS}.wm-1.b.c`, { val: 1, ack: true })).toBe(true);
    expect(m.differs(`${NS}.wm-10.a`, { val: 1, ack: true })).toBe(false);
  });
});
