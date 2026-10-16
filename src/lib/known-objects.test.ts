// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
import {
  coveredBy,
  KnownObjects,
  type KnownObjectsAdapter,
  mergedWith,
  sameStructure,
  storedAfterSet,
} from "./known-objects";

describe("mergedWith — the merge of extendObject (node.extend, deep)", () => {
  it("merges plain objects key by key and leaves the stored object untouched", () => {
    const stored = { common: { name: "a", role: "state" }, native: { x: 1 } };
    expect(mergedWith(stored, { common: { name: "b" } })).toEqual({
      common: { name: "b", role: "state" },
      native: { x: 1 },
    });
    expect(stored.common.name).toBe("a");
  });

  it("merges arrays index by index — a shorter array keeps the stored tail", () => {
    expect(mergedWith({ list: [1, 2, 3] }, { list: [9] })).toEqual({ list: [9, 2, 3] });
    expect(mergedWith({ list: [1] }, { list: [1, 2] })).toEqual({ list: [1, 2] });
    expect(mergedWith({ list: [{ a: 1, b: 2 }] }, { list: [{ a: 5 }] })).toEqual({ list: [{ a: 5, b: 2 }] });
  });

  it("takes null and values, skips undefined", () => {
    expect(mergedWith({ a: 1, b: 2 }, { a: null, b: undefined })).toEqual({ a: null, b: 2 });
    expect(mergedWith({ a: { x: 1 } }, { a: 5 })).toEqual({ a: 5 });
    expect(mergedWith({ a: 5 }, { a: { x: 1 } })).toEqual({ a: { x: 1 } });
  });

  it("takes a patch array whole where nothing or no array is stored", () => {
    expect(mergedWith(undefined, ["a", "b"])).toEqual(["a", "b"]);
    expect(mergedWith({ x: 1 }, ["a"])).toEqual(["a"]);
  });

  it("skips an undefined array element and merges an object without a prototype like any plain object", () => {
    expect(mergedWith([1, 2], [undefined, 3])).toEqual([1, 3]);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(mergedWith(bare, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

describe("storedAfterSet — what setForeignObject leaves in the database (js-controller 7.2.2)", () => {
  it("returns a value that is not a plain object as it is", () => {
    expect(storedAfterSet("demo.0.x", undefined, null)).toBeNull();
  });

  it("keeps the old recording of a state even when the new object has no common, and what follows it", () => {
    const stored = { type: "state", common: { custom: { "history.0": { enabled: true } }, smartName: "Lamp" } };
    expect(storedAfterSet("demo.0.x", stored, { type: "state" })).toEqual({
      _id: "demo.0.x",
      type: "state",
      common: { custom: { "history.0": { enabled: true } }, smartName: "Lamp" },
    });
  });

  it("merges a recording attribute by attribute: the new object's attribute wins, an attribute it leaves out stays", () => {
    const stored = {
      type: "state",
      common: { custom: { "history.0": { enabled: true }, "influxdb.0": { enabled: true } } },
    };
    expect(
      storedAfterSet("demo.0.x", stored, { type: "state", common: { custom: { "history.0": { enabled: false } } } }),
    ).toEqual({
      _id: "demo.0.x",
      type: "state",
      common: { custom: { "history.0": { enabled: false }, "influxdb.0": { enabled: true } } },
    });
  });

  it("deletes a preserved setting the new object sets to null", () => {
    const stored = { type: "state", common: { name: "a", smartName: "Lamp" } };
    expect(storedAfterSet("demo.0.x", stored, { type: "state", common: { name: "a", smartName: null } })).toEqual({
      _id: "demo.0.x",
      type: "state",
      common: { name: "a" },
    });
  });

  it("on a first write keeps nothing old: no stamps, no acl, no preserved setting", () => {
    expect(storedAfterSet("demo.0.x", undefined, { type: "state", common: { name: "a" }, from: "x", ts: 1 })).toEqual({
      _id: "demo.0.x",
      type: "state",
      common: { name: "a" },
    });
  });

  it("preserves nothing from a stored object whose common is not an object", () => {
    expect(
      storedAfterSet("demo.0.x", { type: "state", common: "broken" }, { type: "state", common: { name: "a" } }),
    ).toEqual({
      _id: "demo.0.x",
      type: "state",
      common: { name: "a" },
    });
  });

  it("drops a preserved setting when the new object has no common and no recording gives it one", () => {
    expect(storedAfterSet("demo.0.x", { type: "state", common: { smartName: "Lamp" } }, { type: "state" })).toEqual({
      _id: "demo.0.x",
      type: "state",
    });
  });
});

describe("coveredBy — the write would change nothing", () => {
  const stored = { type: "state", common: { name: { en: "A", de: "A" }, states: ["off", "on"], min: 0 } };

  it("is covered when every field already sits there, in any key order", () => {
    expect(coveredBy({ common: { min: 0, name: { de: "A", en: "A" } } }, stored)).toBe(true);
  });

  it("is covered by a shorter array and by an undefined field — the merge changes nothing", () => {
    expect(coveredBy({ common: { states: ["off"] } }, stored)).toBe(true);
    expect(coveredBy({ common: { min: undefined } }, stored)).toBe(true);
  });

  it("is not covered by a changed value, a new field, null, a longer array, or an unknown object", () => {
    expect(coveredBy({ common: { min: 1 } }, stored)).toBe(false);
    expect(coveredBy({ common: { unit: "%" } }, stored)).toBe(false);
    expect(coveredBy({ common: { min: null } }, stored)).toBe(false);
    expect(coveredBy({ common: { states: ["off", "on", "auto"] } }, stored)).toBe(false);
    expect(coveredBy({ common: { min: 0 } }, undefined)).toBe(false);
  });

  it("compares structures, not their text", () => {
    expect(sameStructure({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(sameStructure([1, 2], { 0: 1, 1: 2 })).toBe(false);
    expect(sameStructure({ a: undefined }, {})).toBe(false);
  });
});

describe("KnownObjects — read once, write only on a difference", () => {
  type Call = [string, string, unknown?];

  function fakeAdapter(rows: Array<{ id: string; value: unknown }>): { adapter: KnownObjectsAdapter; calls: Call[] } {
    const calls: Call[] = [];
    const adapter: KnownObjectsAdapter = {
      namespace: "demo.0",
      extendObject: (id, obj) => {
        calls.push(["extend", id, obj]);
        return Promise.resolve();
      },
      setForeignObject: (id, obj) => {
        calls.push(["set", id, obj]);
        return Promise.resolve();
      },
      delObjectAsync: (id, options) => {
        calls.push(["del", id, options]);
        return Promise.resolve();
      },
      getObjectListAsync: params => {
        calls.push(["list", params.startkey]);
        // the broker answers serialized — a copy, never the rows this fake keeps
        return Promise.resolve({ rows: structuredClone(rows) });
      },
    };
    return { adapter, calls };
  }

  it("reads the own tree with one call and leaves out a write that changes nothing", async () => {
    const { adapter, calls } = fakeAdapter([
      { id: "demo.0.info.connection", value: { common: { name: "Connected" } } },
    ]);
    const known = new KnownObjects(adapter);
    await known.load();
    expect(await known.extend("info.connection", { common: { name: "Connected" } })).toBe(false);
    expect(calls.map(c => `${c[0]} ${c[1]}`)).toEqual(["list demo.0."]);
  });

  it("writes a difference once and holds what the write left", async () => {
    const { adapter, calls } = fakeAdapter([
      { id: "demo.0.info.connection", value: { common: { name: "Old", role: "indicator" } } },
    ]);
    const known = new KnownObjects(adapter);
    await known.load();
    expect(await known.extend("info.connection", { common: { name: "New" } })).toBe(true);
    expect(await known.extend("demo.0.info.connection", { common: { name: "New" } })).toBe(false);
    expect(known.get("info.connection")).toEqual({ common: { name: "New", role: "indicator" } });
    const writes = calls.filter(c => c[0] === "extend");
    expect(writes.map(c => c[1])).toEqual(["info.connection"]);
    expect(writes.map(c => c[2])).toEqual([{ common: { name: "New" } }]);
  });

  it("replaces a whole object only when it differs, and forgets removed objects with their children", async () => {
    const { adapter, calls } = fakeAdapter([
      { id: "demo.0.dev", value: { type: "device", common: { name: "Dev" } } },
      { id: "demo.0.dev.on", value: { type: "state", common: { name: "On" } } },
      { id: "demo.0.other", value: { type: "state", common: { name: "Other" } } },
    ]);
    const known = new KnownObjects(adapter);
    await known.load();
    const dev = { type: "device", common: { name: "Dev" }, native: {} } as unknown as ioBroker.SettableObject;
    expect(await known.replace("demo.0.dev", dev)).toBe(true);
    expect(await known.replace("demo.0.dev", dev)).toBe(false);
    await known.remove("dev", { recursive: true });
    expect(known.get("dev")).toBeUndefined();
    expect(known.get("dev.on")).toBeUndefined();
    expect(known.get("other")).toEqual({ type: "state", common: { name: "Other" } });
    expect(calls.filter(c => c[0] !== "list").map(c => `${c[0]} ${c[1]}`)).toEqual(["set demo.0.dev", "del dev"]);
  });

  it("skips a row without an object, and a delete without recursive keeps the children known", async () => {
    const { adapter } = fakeAdapter([
      { id: "demo.0.gone", value: null },
      { id: "demo.0.dev", value: { type: "device", common: { name: "Dev" } } },
      { id: "demo.0.dev.on", value: { type: "state", common: { name: "On" } } },
    ]);
    const known = new KnownObjects(adapter);
    await known.load();
    expect(known.get("gone")).toBeUndefined();
    await known.remove("dev");
    expect(known.get("dev")).toBeUndefined();
    expect(known.get("dev.on")).toEqual({ type: "state", common: { name: "On" } });
  });

  it("does not rewrite a loaded object on restart — what the database stamps and keeps is not the adapter's", async () => {
    // a row as the database returns it (js-controller 7.2.2): stamps of the adapter layer, _id and acl of the
    // objects database, and a recording the user set (common.custom), which a setForeignObject without it keeps
    const row = {
      _id: "demo.0.dev.on",
      type: "state",
      common: { name: "On", type: "boolean", role: "switch", custom: { "history.0": { enabled: true } } },
      native: {},
      from: "system.adapter.demo.0",
      user: "system.user.admin",
      ts: 1759300000000,
      acl: { owner: "system.user.admin", ownerGroup: "system.group.administrator", object: 1636, state: 1636 },
    };
    const { adapter, calls } = fakeAdapter([{ id: "demo.0.dev.on", value: row }]);
    const known = new KnownObjects(adapter);
    await known.load();
    const same = {
      type: "state",
      common: { name: "On", type: "boolean", role: "switch" },
      native: {},
    } as unknown as ioBroker.SettableObject;
    expect(await known.replace("demo.0.dev.on", same)).toBe(false);
    const renamed = {
      type: "state",
      common: { name: "Power", type: "boolean", role: "switch" },
      native: {},
    } as unknown as ioBroker.SettableObject;
    expect(await known.replace("demo.0.dev.on", renamed)).toBe(true);
    expect(known.get("dev.on")).toEqual({ ...row, common: { ...row.common, name: "Power" } });
    const dropped = {
      type: "state",
      common: { name: "Power", type: "boolean", role: "switch", custom: { "history.0": null } },
      native: {},
    } as unknown as ioBroker.SettableObject;
    expect(await known.replace("demo.0.dev.on", dropped)).toBe(true);
    expect((known.get("dev.on") as { common: Record<string, unknown> }).common.custom).toBeUndefined();
    expect(calls.filter(c => c[0] === "set")).toHaveLength(2);
  });
});

describe("KnownObjects — overlapping operations wait for each other", () => {
  /**
   * A database that applies each operation when it is called and answers after a delay of its own, like a broker whose
   * answers can overtake each other.
   *
   * @param initial the objects in the database
   * @param delays the answer delay per operation in ms
   * @param delays.extend extendObject
   * @param delays.del delObjectAsync
   * @param delays.list getObjectListAsync
   * @param failFirstExtend whether the first extendObject fails without writing
   * @returns the adapter, the database and the count of extendObject calls
   */
  function slowAdapter(
    initial: Record<string, unknown>,
    delays: { extend: number; del: number; list: number },
    failFirstExtend = false,
  ): { adapter: KnownObjectsAdapter; db: Map<string, unknown>; extends: () => number } {
    const db = new Map<string, unknown>(Object.entries(initial));
    let calls = 0;
    const answer = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
    const full = (id: string): string => (id.startsWith("demo.0.") ? id : `demo.0.${id}`);
    const adapter: KnownObjectsAdapter = {
      namespace: "demo.0",
      extendObject: (id, patch) => {
        calls++;
        if (failFirstExtend && calls === 1) {
          return Promise.reject(new Error("db busy"));
        }
        db.set(full(id), mergedWith(db.get(full(id)), patch));
        return answer(delays.extend);
      },
      setForeignObject: (id, obj) => {
        db.set(id, storedAfterSet(id, db.get(id), obj));
        return answer(delays.extend);
      },
      delObjectAsync: (id, options) => {
        const key = full(id);
        for (const known of [...db.keys()]) {
          if (known === key || (options?.recursive && known.startsWith(`${key}.`))) {
            db.delete(known);
          }
        }
        return answer(delays.del);
      },
      getObjectListAsync: () => {
        const rows = structuredClone([...db].map(([id, value]) => ({ id, value })));
        return answer(delays.list).then(() => ({ rows }));
      },
    };
    return { adapter, db, extends: () => calls };
  }

  const even = { extend: 5, del: 5, list: 5 };

  it("keeps both patches of one id in the store, so a write back to the old value is made", async () => {
    const { adapter, db } = slowAdapter(
      { "demo.0.dev.volume": { type: "state", common: { min: 0, max: 97, unit: "dB" } } },
      even,
    );
    const known = new KnownObjects(adapter);
    await known.load();
    await Promise.all([
      known.extend("dev.volume", { common: { unit: "%", min: 0, max: 100 } }),
      known.extend("dev.volume", { common: { step: 0.5 } }),
    ]);
    expect(known.get("dev.volume")).toEqual(db.get("demo.0.dev.volume"));
    expect(await known.extend("dev.volume", { common: { unit: "dB", min: 0, max: 97 } })).toBe(true);
    expect(db.get("demo.0.dev.volume")).toMatchObject({ common: { unit: "dB", max: 97, step: 0.5 } });
  });

  it("compares a queued write against what the one before it left: the same patch twice is written once", async () => {
    const { adapter, extends: calls } = slowAdapter(
      { "demo.0.dev.power": { type: "state", common: { role: "switch" } } },
      even,
    );
    const known = new KnownObjects(adapter);
    await known.load();
    const results = await Promise.all([
      known.extend("dev.power", { common: { role: "switch.power" } }),
      known.replace("demo.0.dev.power", {
        type: "state",
        common: { role: "switch.power" },
      } as unknown as ioBroker.SettableObject),
      known.extend("demo.0.dev.power", { common: { role: "switch.power" } }),
    ]);
    expect(results).toEqual([true, true, false]);
    expect(calls()).toBe(1);
  });

  it("runs the next operation of an id after a failed one", async () => {
    const { adapter, db } = slowAdapter({ "demo.0.dev.mute": { type: "state", common: {} } }, even, true);
    const known = new KnownObjects(adapter);
    await known.load();
    const first = known.extend("dev.mute", { common: { role: "media.mute" } });
    const second = known.extend("dev.mute", { common: { role: "media.mute" } });
    await expect(first).rejects.toThrow("db busy");
    await expect(second).resolves.toBe(true);
    expect(db.get("demo.0.dev.mute")).toMatchObject({ common: { role: "media.mute" } });
  });

  it("lets a recursive remove wait for a write below it that runs already", async () => {
    // the write answers late, the delete early: the store would keep the child the database no longer has
    const { adapter, db } = slowAdapter(
      {
        "demo.0.dev": { type: "device", common: { name: "Dev" } },
        "demo.0.dev.on": { type: "state", common: { name: "On" } },
      },
      { extend: 10, del: 1, list: 1 },
    );
    const known = new KnownObjects(adapter);
    await known.load();
    await Promise.all([
      known.extend("dev.on", { common: { name: "Power" } }),
      known.remove("dev", { recursive: true }),
    ]);
    expect(known.get("dev.on")).toEqual(db.get("demo.0.dev.on"));
    expect(await known.extend("dev.on", { common: { name: "Power" } })).toBe(true);
    expect(db.get("demo.0.dev.on")).toEqual({ common: { name: "Power" } });
  });

  it("lets a write below a running recursive remove wait for it", async () => {
    // the delete answers late, the write early: the store would forget the child the database holds again
    const { adapter, db } = slowAdapter(
      {
        "demo.0.dev": { type: "device", common: { name: "Dev" } },
        "demo.0.dev.on": { type: "state", common: { name: "On" } },
      },
      { extend: 1, del: 10, list: 1 },
    );
    const known = new KnownObjects(adapter);
    await known.load();
    await Promise.all([
      known.remove("dev", { recursive: true }),
      known.extend("dev.on", { common: { name: "Power" } }),
    ]);
    expect(known.get("dev.on")).toEqual(db.get("demo.0.dev.on"));
    expect(known.get("dev")).toBeUndefined();
    expect(await known.extend("dev.on", { common: { name: "Power" } })).toBe(false);
  });

  it("lets a write wait for a running load, and a load wait for a running write", async () => {
    const { adapter, db } = slowAdapter(
      { "demo.0.dev.on": { type: "state", common: { name: "On" } } },
      { extend: 1, del: 1, list: 10 },
    );
    const known = new KnownObjects(adapter);
    await Promise.all([known.load(), known.extend("dev.on", { common: { name: "Power" } })]);
    expect(known.get("dev.on")).toEqual(db.get("demo.0.dev.on"));
    await Promise.all([known.extend("dev.on", { common: { name: "Light" } }), known.load()]);
    expect(known.get("dev.on")).toEqual(db.get("demo.0.dev.on"));
    expect(await known.extend("dev.on", { common: { name: "Power" } })).toBe(true);
  });

  it("lets an operation wait for one that started while an earlier one on the same id was still running", async () => {
    const { adapter, extends: calls } = slowAdapter(
      { "demo.0.dev.on": { type: "state", common: { name: "On" } } },
      { extend: 10, del: 1, list: 1 },
    );
    const known = new KnownObjects(adapter);
    await known.load();
    const first = known.extend("dev.on", { common: { name: "A" } });
    const second = known.extend("dev.on", { common: { name: "B" } });
    await first;
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(await known.extend("dev.on", { common: { name: "B" } })).toBe(false);
    await second;
    expect(calls()).toBe(2);
  });

  it("lets a write below wait for a recursive remove that started behind a write of the same id", async () => {
    const { adapter, db } = slowAdapter(
      {
        "demo.0.dev": { type: "device", common: { name: "Dev" } },
        "demo.0.dev.on": { type: "state", common: { name: "On" } },
      },
      { extend: 5, del: 20, list: 1 },
    );
    const known = new KnownObjects(adapter);
    await known.load();
    const renamed = known.extend("dev", { common: { name: "Device" } });
    const removed = known.remove("dev", { recursive: true });
    await renamed;
    await new Promise(resolve => setTimeout(resolve, 1));
    await Promise.all([removed, known.extend("dev.on", { common: { name: "Power" } })]);
    expect(known.get("dev.on")).toEqual(db.get("demo.0.dev.on"));
  });

  it("forgets every finished operation, so nothing waits on it and nothing piles up", async () => {
    const { adapter } = slowAdapter({}, { extend: 1, del: 1, list: 1 });
    const known = new KnownObjects(adapter);
    await Promise.all([
      known.load(),
      known.extend("dev.a", { common: { name: "A" } }),
      known.remove("dev", { recursive: true }),
      known.extend("dev.a", { common: { name: "B" } }),
    ]);
    await new Promise(resolve => setTimeout(resolve, 1));
    const inner = known as unknown as { running: Map<string, unknown>; subtrees: Map<string, unknown> };
    expect(inner.running.size + inner.subtrees.size).toBe(0);
  });

  it("keeps operations on different ids apart: none waits for another", async () => {
    const { adapter, extends: calls } = slowAdapter({}, { extend: 20, del: 20, list: 1 });
    const known = new KnownObjects(adapter);
    await known.load();
    const writes = Promise.all([
      known.extend("dev.a", { common: { name: "A" } }),
      known.remove("devb", { recursive: true }),
      known.extend("dev.c", { common: { name: "C" } }),
    ]);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(calls()).toBe(2);
    await writes;
  });
});
