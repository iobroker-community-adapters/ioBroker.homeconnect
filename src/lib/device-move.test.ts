import { describe, it, expect } from "vitest";
import {
  copyDeviceTree,
  enumMembersUnder,
  keepHistoryUnder,
  movedAliasTarget,
  movedId,
  retargetAliases,
  rewriteMovedObject,
  type DeviceMoveDeps,
} from "./device-move";

const NS = "homeconnect.0";
const OLD = `${NS}.sx87tx02ce-60`;
const NEW = `${NS}.sx87tx02ce-5775`;

/** The in-memory database of one test, and the move's calls over it. */
interface Database {
  /** What the database holds, and the order of the object writes. */
  db: { objects: Map<string, ioBroker.Object>; states: Map<string, ioBroker.State>; written: string[] };
  /** The calls a move makes. */
  deps: DeviceMoveDeps;
}

/**
 * An in-memory objects/states database with the calls a move uses.
 *
 * @param objects the objects it holds, by full id
 * @param states the states it holds, by full id
 * @returns the database and the move's calls over it
 */
function database(objects: Record<string, unknown>, states: Record<string, unknown> = {}): Database {
  const db = {
    objects: new Map(Object.entries(structuredClone(objects))) as Map<string, ioBroker.Object>,
    states: new Map(Object.entries(structuredClone(states))) as Map<string, ioBroker.State>,
    written: [] as string[],
  };
  const byPrefix = <T>(map: Map<string, T>, prefix: string): Record<string, T> =>
    structuredClone(Object.fromEntries([...map].filter(([id]) => id.startsWith(prefix))));
  const deps: DeviceMoveDeps = {
    namespace: NS,
    objects: () => Promise.resolve(byPrefix(db.objects, `${NS}.`)),
    states: pattern => Promise.resolve(byPrefix(db.states, pattern.replace(/\*$/, ""))),
    setObject: (id, obj) => {
      db.objects.set(id, structuredClone(obj) as ioBroker.Object);
      db.written.push(id);
      return Promise.resolve();
    },
    extendObject: (id, patch) => {
      const prev = db.objects.get(id) ?? ({} as ioBroker.Object);
      db.objects.set(id, {
        ...prev,
        native: { ...(prev.native ?? {}), ...((patch.native as Record<string, unknown>) ?? {}) },
      } as ioBroker.Object);
      db.written.push(id);
      return Promise.resolve();
    },
    setState: (id, state) => {
      db.states.set(id, state as ioBroker.State);
      return Promise.resolve();
    },
    aliases: () => Promise.resolve(byPrefix(db.objects, "alias.")),
  };
  return { db, deps };
}

/** The tree 1.23.x left for the dishwasher: named after its E-number, with a recording, a room and two aliases. */
function eNumberTree(): Record<string, unknown> {
  return {
    [OLD]: {
      type: "device",
      common: { name: "Geschirrspüler", statusStates: { onlineId: `${OLD}.info.reachable` } },
      native: { haId: "015090396331005775", vib: "SX87TX02CE", enumber: "SX87TX02CE/60", movingTo: "sx87tx02ce-5775" },
    },
    [`${OLD}.info`]: { type: "channel", common: { name: "Information" }, native: {} },
    [`${OLD}.info.reachable`]: { type: "state", common: { name: "Connected", type: "boolean" }, native: {} },
    [`${OLD}.status.operationState`]: {
      type: "state",
      common: {
        name: "Operating state",
        type: "string",
        custom: { "influxdb.0": { enabled: true, aliasId: "" }, "history.0": { enabled: false } },
      },
      native: { bshKey: "BSH.Common.Status.OperationState" },
    },
    [`${NS}.sx87tx02ce-600`]: { type: "device", common: { name: "Other" }, native: {} },
    [`${NS}.info.connection`]: { type: "state", common: { name: "Adapter" }, native: {} },
    "enum.rooms.kitchen": {
      type: "enum",
      common: { name: "Kitchen", members: [OLD, `${OLD}.status.operationState`, "hm-rpc.0.X.1.STATE"] },
      native: {},
    },
    "alias.0.kitchen.dishwasher": {
      type: "state",
      common: { name: "State", alias: { id: `${OLD}.status.operationState` } },
      native: {},
    },
    "alias.0.kitchen.power": {
      type: "state",
      common: { name: "Pwr", alias: { id: { read: `${OLD}.settings.powerState`, write: "javascript.0.x" } } },
      native: {},
    },
    "alias.0.other": { type: "state", common: { name: "O", alias: { id: `${NS}.sx87tx02ce-600.x` } }, native: {} },
  };
}

describe("movedId", () => {
  it("moves the device and everything below it — nothing that only starts with its name", () => {
    expect(movedId(OLD, OLD, NEW)).toBe(NEW);
    expect(movedId(`${OLD}.info.reachable`, OLD, NEW)).toBe(`${NEW}.info.reachable`);
    expect(movedId(`${NS}.sx87tx02ce-600.x`, OLD, NEW)).toBeUndefined();
  });
});

describe("movedAliasTarget", () => {
  const move = (id: string): string | undefined => movedId(id, OLD, NEW);
  it("follows a plain target and each half of a read/write pair", () => {
    expect(movedAliasTarget(`${OLD}.status.operationState`, move)).toBe(`${NEW}.status.operationState`);
    expect(movedAliasTarget({ read: `${OLD}.settings.powerState`, write: "js.0.x" }, move)).toEqual({
      read: `${NEW}.settings.powerState`,
      write: "js.0.x",
    });
    expect(movedAliasTarget({ read: "js.0.y", write: `${OLD}.settings.powerState` }, move)).toEqual({
      read: "js.0.y",
      write: `${NEW}.settings.powerState`,
    });
    expect(movedAliasTarget(`${NS}.sx87tx02ce-600.x`, move)).toBeUndefined();
    expect(movedAliasTarget(undefined, move)).toBeUndefined();
    expect(movedAliasTarget({ read: 5 }, move)).toBeUndefined();
  });
});

describe("keepHistoryUnder", () => {
  it("points every enabled recording without an alias id of its own at the old id", () => {
    const custom = {
      "influxdb.0": { enabled: true },
      "sql.0": { enabled: true, aliasId: "" },
      "history.0": { enabled: false },
      "history.1": { enabled: true, aliasId: "my.series" },
    };
    expect(keepHistoryUnder(custom, "old.id")).toBe(2);
    expect(custom).toEqual({
      "influxdb.0": { enabled: true, aliasId: "old.id" },
      "sql.0": { enabled: true, aliasId: "old.id" },
      "history.0": { enabled: false },
      "history.1": { enabled: true, aliasId: "my.series" },
    });
  });

  it("does nothing without a recording configuration", () => {
    expect(keepHistoryUnder(undefined, "x")).toBe(0);
    expect(keepHistoryUnder("text", "x")).toBe(0);
  });
});

describe("rewriteMovedObject", () => {
  it("points the reachability link at the new id and drops the journal", () => {
    const tree = eNumberTree();
    const { object } = rewriteMovedObject(OLD, tree[OLD] as ioBroker.Object, OLD, NEW);
    const common = object.common as { name: string; statusStates: { onlineId: string } };
    expect(common.statusStates.onlineId).toBe(`${NEW}.info.reachable`);
    expect(common.name).toBe("Geschirrspüler");
    expect((object.native as Record<string, unknown>).movingTo).toBeUndefined();
    expect(object.native).toMatchObject({ haId: "015090396331005775", enumber: "SX87TX02CE/60" });
  });

  it("an enabled recording keeps its series under the old id, a disabled one is left alone", () => {
    const tree = eNumberTree();
    const id = `${OLD}.status.operationState`;
    const { object, history } = rewriteMovedObject(id, tree[id] as ioBroker.Object, OLD, NEW);
    expect(history).toBe(1);
    expect((object.common as { custom: unknown }).custom).toEqual({
      "influxdb.0": { enabled: true, aliasId: id },
      "history.0": { enabled: false },
    });
    // The read object is not changed — the old tree stays as it was until the delete.
    expect((tree[id] as ioBroker.Object).common.custom).toEqual({
      "influxdb.0": { enabled: true, aliasId: "" },
      "history.0": { enabled: false },
    });
  });

  it("a channel carries no recording to point anywhere", () => {
    const { history } = rewriteMovedObject(
      `${OLD}.info`,
      { type: "channel", common: { custom: { "influxdb.0": { enabled: true } } }, native: {} } as never,
      OLD,
      NEW,
    );
    expect(history).toBe(0);
  });
});

describe("retargetAliases", () => {
  it("rewrites only the aliases that point at something that moves", async () => {
    const written: Record<string, ioBroker.SettableObject> = {};
    const aliases = Object.fromEntries(
      Object.entries(eNumberTree()).filter(([id]) => id.startsWith("alias.")),
    ) as Record<string, ioBroker.Object>;
    const count = await retargetAliases(
      aliases,
      id => movedId(id, OLD, NEW),
      (id, obj) => {
        written[id] = obj;
        return Promise.resolve();
      },
    );
    expect(count).toBe(2);
    expect(Object.keys(written).sort()).toEqual(["alias.0.kitchen.dishwasher", "alias.0.kitchen.power"]);
    expect((written["alias.0.kitchen.dishwasher"].common as { name: string }).name).toBe("State");
  });
});

describe("copyDeviceTree", () => {
  it("carries objects, values and alias targets to the new id — rooms are the delete's business", async () => {
    const { db, deps } = database(eNumberTree(), {
      [`${OLD}.status.operationState`]: { val: "run", ack: true, ts: 1000, lc: 900, q: 0 },
      [`${OLD}.info.reachable`]: { val: true, ack: true, ts: 2000, lc: 2000 },
      [`${NS}.sx87tx02ce-600.x`]: { val: true, ack: true, ts: 1, lc: 1 },
    });
    const report = await copyDeviceTree(deps, "sx87tx02ce-60", "sx87tx02ce-5775");
    expect(report).toEqual({ datapoints: 2, enums: 0, aliases: 2, history: 1 });
    expect(db.objects.get(NEW)?.native).toMatchObject({ idScheme: 3, haId: "015090396331005775" });
    expect(db.objects.get(`${NEW}.info`)?.type).toBe("channel");
    expect(db.states.get(`${NEW}.status.operationState`)).toEqual({ val: "run", ack: true, ts: 1000, lc: 900, q: 0 });
    expect(db.states.get(`${NEW}.info.reachable`)).toEqual({ val: true, ack: true, ts: 2000, lc: 2000 });
    // Untouched here: an id written before the delete would be taken away by it (enum-carry.ts).
    expect(db.objects.get("enum.rooms.kitchen")?.common.members).toEqual([
      OLD,
      `${OLD}.status.operationState`,
      "hm-rpc.0.X.1.STATE",
    ]);
    expect((db.objects.get("alias.0.kitchen.dishwasher")?.common as { alias: unknown }).alias).toEqual({
      id: `${NEW}.status.operationState`,
    });
    expect((db.objects.get("alias.0.kitchen.power")?.common as { alias: unknown }).alias).toEqual({
      id: { read: `${NEW}.settings.powerState`, write: "javascript.0.x" },
    });
    // A device whose id merely starts with the same characters is not touched.
    expect((db.objects.get("alias.0.other")?.common as { alias: unknown }).alias).toEqual({
      id: `${NS}.sx87tx02ce-600.x`,
    });
    expect(db.states.has(`${NEW}0.x`)).toBe(false);
    // The old tree is still there — deleting it is the caller's last step.
    expect(db.objects.has(`${OLD}.status.operationState`)).toBe(true);
  });

  it("writes the device object last, and marks it final only after everything below it", async () => {
    const { db, deps } = database(eNumberTree());
    await copyDeviceTree(deps, "sx87tx02ce-60", "sx87tx02ce-5775");
    const firstDeviceWrite = db.written.indexOf(NEW);
    expect(db.written.slice(0, firstDeviceWrite)).toEqual([
      `${NEW}.info`,
      `${NEW}.info.reachable`,
      `${NEW}.status.operationState`,
    ]);
    expect(db.written.at(-1)).toBe(NEW);
  });

  it("an interrupted move is completed without copying a finished tree twice", async () => {
    const { db, deps } = database(eNumberTree(), { [`${OLD}.status.operationState`]: { val: "run", ack: true } });
    await copyDeviceTree(deps, "sx87tx02ce-60", "sx87tx02ce-5775");
    db.states.set(`${NEW}.status.operationState`, { val: "ready", ack: true } as ioBroker.State);
    db.written.length = 0;
    const again = await copyDeviceTree(deps, "sx87tx02ce-60", "sx87tx02ce-5775");
    expect(again.datapoints).toBe(0);
    // Only the aliases are pointed once more (they are rewritten on every run, idempotently).
    expect(db.written.filter(id => id.startsWith(NS))).toEqual([]);
    expect(db.states.get(`${NEW}.status.operationState`)?.val).toBe("ready");
  });

  it("a copy cut short before the mark is done again", async () => {
    const { db, deps } = database(eNumberTree());
    db.objects.set(`${NEW}.info`, { type: "channel", common: { name: "Information" }, native: {} } as ioBroker.Object);
    const report = await copyDeviceTree(deps, "sx87tx02ce-60", "sx87tx02ce-5775");
    expect(report.datapoints).toBe(2);
    expect(db.objects.get(NEW)?.native).toMatchObject({ idScheme: 3 });
  });

  it("fills a kept tree from a leftover: only what is missing, values only where there are none", async () => {
    const kept = {
      [NEW]: { type: "device", common: { name: "Kept" }, native: { haId: "015090396331005775", idScheme: 3 } },
      [`${NEW}.status.operationState`]: { type: "state", common: { name: "Kept state" }, native: {} },
    };
    const { db, deps } = database(
      { ...eNumberTree(), ...kept },
      {
        [`${OLD}.status.operationState`]: { val: "run", ack: true },
        [`${OLD}.info.reachable`]: { val: true, ack: true },
        [`${NEW}.status.operationState`]: { val: "ready", ack: true },
      },
    );
    const report = await copyDeviceTree(deps, "sx87tx02ce-60", "sx87tx02ce-5775", true);
    // The kept objects and their values stay; the missing ones arrive.
    expect(db.objects.get(NEW)?.common.name).toBe("Kept");
    expect(db.objects.get(`${NEW}.status.operationState`)?.common.name).toBe("Kept state");
    expect(db.states.get(`${NEW}.status.operationState`)?.val).toBe("ready");
    expect(db.objects.get(`${NEW}.info.reachable`)?.type).toBe("state");
    expect(db.states.get(`${NEW}.info.reachable`)?.val).toBe(true);
    expect(report.datapoints).toBe(1);
    expect(report.aliases).toBe(2);
    // The mark is the kept tree's own — a fill does not write it.
    expect(db.written).not.toContain(NEW);
  });
});

describe("enumMembersUnder", () => {
  it("names every id of the moved tree that a room or function lists, and nothing else", () => {
    const enums = eNumberTree();
    expect(enumMembersUnder(enums, OLD)).toEqual([OLD, `${OLD}.status.operationState`]);
    expect(enumMembersUnder({ "enum.x": { common: { members: [`${NS}.sx87tx02ce-600.x`] } } }, OLD)).toEqual([]);
    expect(enumMembersUnder(undefined, OLD)).toEqual([]);
  });
});
