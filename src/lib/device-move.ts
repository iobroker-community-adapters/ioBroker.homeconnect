// Moving an appliance's object tree to a new device id — the one-time step of an id-rule change.
// Ported from ioBroker.yamaha `src/lib/lifecycle/device-move.ts` (3.0.0), without its table rows,
// discovery store and label record, which homeconnect does not have.

import { ID_SCHEME } from "./device-id";

/*
 * ioBroker has no rename: an object that should live under another id is written there and the old
 * one deleted. What the user attached to the tree has to be carried by hand, or it is lost with the
 * old objects. Carried here:
 *
 * - every object (device, channels, states) with its whole `common` — the recording settings in
 *   `common.custom` included — and its `native`;
 * - every value, with its `ack`, `ts`, `lc` and `q`, so nothing reads as changed;
 * - aliases whose target lies in the tree (`alias.*`, `common.alias.id`, plain or read/write);
 * - the continuity of recorded history: an enabled recording without an alias id of its own gets
 *   the OLD id as `aliasId` — influxdb, history and sql then store and query the series under the
 *   id it has always had.
 *
 * The rooms and functions (enum members) are NOT carried here: deleting the old tree removes its ids
 * from every enum, written back from the adapter's enum cache, and would take an id written before it
 * away again. The caller deletes through the fleet helper `moveAllWithEnums` (`enum-carry.ts`, via the
 * port's `deleteTreeCarryingEnums`), which reads the memberships once, deletes once, and writes the
 * new ids last; {@link enumMembersUnder} names
 * the ids it has to carry. Until that delete the old device object carries `native.movingTo` as a
 * journal, and an interrupted move is completed on the next start.
 */

/** What a move reads and writes — the adapter's own object and state calls, injectable for tests. */
export interface DeviceMoveDeps {
  /** The adapter namespace (`homeconnect.0`). */
  namespace: string;
  /** Every object under the instance, keyed by full id. */
  objects(): Promise<Record<string, ioBroker.Object | null | undefined>>;
  /** Every state below a full-id pattern (`homeconnect.0.sx87tx02ce-60.*`). */
  states(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** Write an object whole (full id). */
  setObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
  /** Merge into an object (full id). */
  extendObject(id: string, patch: ioBroker.PartialObject): Promise<unknown>;
  /** Write a state (full id). */
  setState(id: string, state: ioBroker.SettableState): Promise<unknown>;
  /** Every alias state object (`alias.*`). */
  aliases(): Promise<Record<string, ioBroker.Object | null | undefined>>;
}

/** What one move carried over. */
export interface MoveReport {
  /** State objects written under the new id. */
  datapoints: number;
  /** Room/function entries that now list the moved objects (filled in by the caller's delete). */
  enums: number;
  /** Alias objects whose target was rewritten. */
  aliases: number;
  /** Recordings that keep their series under the old id (`aliasId`). */
  history: number;
}

/**
 * The id an object has after the move, or undefined when it is not part of the moved tree.
 *
 * @param id a full object id
 * @param fromFull the old device id, namespace included
 * @param toFull the new device id, namespace included
 * @returns the moved id
 */
export function movedId(id: string, fromFull: string, toFull: string): string | undefined {
  if (id === fromFull) {
    return toFull;
  }
  return id.startsWith(`${fromFull}.`) ? `${toFull}${id.slice(fromFull.length)}` : undefined;
}

/**
 * Give an enabled recording without an alias id of its own the id it recorded under so far — the
 * series then continues. Recordings that are switched off or already carry an alias id stay as they are.
 *
 * @param custom the object's `common.custom` (changed in place)
 * @param oldId the full id the recording ran under
 * @returns how many recordings were pointed at the old id
 */
export function keepHistoryUnder(custom: unknown, oldId: string): number {
  if (!custom || typeof custom !== "object") {
    return 0;
  }
  let pointed = 0;
  for (const settings of Object.values(custom as Record<string, unknown>)) {
    if (settings && typeof settings === "object") {
      const entry = settings as { enabled?: unknown; aliasId?: unknown };
      if (entry.enabled && (typeof entry.aliasId !== "string" || entry.aliasId === "")) {
        entry.aliasId = oldId;
        pointed++;
      }
    }
  }
  return pointed;
}

/**
 * A copy of one object as it is written under the new id: every field it carries, with the few that
 * name the old id rewritten — the device object's reachability link (`common.statusStates.onlineId`),
 * the move journal (which belongs to the old object only) and the recording's series (see
 * {@link keepHistoryUnder}).
 *
 * @param id the object's old full id
 * @param obj the object as read
 * @param fromFull the old device id, namespace included
 * @param toFull the new device id, namespace included
 * @returns the object to write, and how many recordings were pointed at the old id
 */
export function rewriteMovedObject(
  id: string,
  obj: ioBroker.Object,
  fromFull: string,
  toFull: string,
): { object: ioBroker.SettableObject; history: number } {
  const copy = JSON.parse(JSON.stringify({ type: obj.type, common: obj.common, native: obj.native ?? {} })) as {
    type: ioBroker.Object["type"];
    common: Record<string, unknown>;
    native: Record<string, unknown>;
  };
  if (id === fromFull) {
    delete copy.native.movingTo;
    const status = copy.common.statusStates as { onlineId?: unknown } | undefined;
    if (status && typeof status.onlineId === "string") {
      status.onlineId = movedId(status.onlineId, fromFull, toFull) ?? status.onlineId;
    }
  }
  const history = obj.type === "state" ? keepHistoryUnder(copy.common.custom, id) : 0;
  return { object: copy as unknown as ioBroker.SettableObject, history };
}

/**
 * An alias target with the moved ids followed — a plain id, or the read/write pair.
 *
 * @param target `common.alias.id` as stored
 * @param move old full id → new full id, for every id that moves (an id without entry stays)
 * @returns the new target, or undefined when it points at nothing that moves
 */
export function movedAliasTarget(target: unknown, move: (id: string) => string | undefined): unknown {
  if (typeof target === "string") {
    return move(target);
  }
  if (target && typeof target === "object") {
    const pair = target as { read?: unknown; write?: unknown };
    const read = typeof pair.read === "string" ? move(pair.read) : undefined;
    const write = typeof pair.write === "string" ? move(pair.write) : undefined;
    if (read === undefined && write === undefined) {
      return undefined;
    }
    return { ...pair, ...(read !== undefined ? { read } : {}), ...(write !== undefined ? { write } : {}) };
  }
  return undefined;
}

/**
 * Point every alias whose target moves at the new id.
 *
 * @param aliases the alias objects, as `getForeignObjectsAsync("alias.*", "state")` returns them
 * @param move old full id → new full id (undefined = does not move)
 * @param write writes one alias object whole
 * @returns how many aliases were rewritten
 */
export async function retargetAliases(
  aliases: Record<string, ioBroker.Object | null | undefined>,
  move: (id: string) => string | undefined,
  write: (id: string, obj: ioBroker.SettableObject) => Promise<unknown>,
): Promise<number> {
  let rewritten = 0;
  for (const [id, obj] of Object.entries(aliases)) {
    const alias = (obj?.common as { alias?: { id?: unknown } } | undefined)?.alias;
    if (!obj || !alias) {
      continue;
    }
    const moved = movedAliasTarget(alias.id, move);
    if (moved === undefined) {
      continue;
    }
    await write(id, { ...obj, common: { ...obj.common, alias: { ...alias, id: moved } } } as ioBroker.SettableObject);
    rewritten++;
  }
  return rewritten;
}

/**
 * The ids below a root that some room or function lists — what the delete of the old tree has to carry.
 *
 * @param enums the enum objects, as `getForeignObjectsAsync("enum.*", "enum")` returns them
 * @param rootFull the root that goes away, namespace included
 * @returns the old full ids, sorted
 */
export function enumMembersUnder(enums: Record<string, unknown> | null | undefined, rootFull: string): string[] {
  const ids = new Set<string>();
  for (const obj of Object.values(enums ?? {})) {
    const members = (obj as { common?: { members?: unknown } } | null)?.common?.members;
    if (Array.isArray(members)) {
      for (const member of members) {
        if (typeof member === "string" && (member === rootFull || member.startsWith(`${rootFull}.`))) {
          ids.add(member);
        }
      }
    }
  }
  return [...ids].sort();
}

/**
 * Copy an appliance's tree to its new id and point everything that referred to it there — objects,
 * values, alias targets (the enum members follow at the delete, see the module note). The old tree
 * stays. Repeatable: every write replaces, so an interrupted copy is simply done again; the new device
 * object is marked final (`native.idScheme`) only after everything below it is written, so a device
 * object with the mark is a complete copy.
 *
 * `fillOnly` is for a LEFTOVER — a second tree of the same appliance that an interrupted move left
 * behind next to the tree that is being kept: only what the kept tree does not have yet arrives,
 * values only where the kept datapoint has none, and the mark is not touched. What already arrived
 * keeps its value; the leftover holds the older one.
 *
 * @param deps the object and state calls
 * @param from the old device id
 * @param to the new device id
 * @param fillOnly add only what the target is missing (a leftover of an interrupted move)
 * @returns what was carried over
 */
export async function copyDeviceTree(
  deps: DeviceMoveDeps,
  from: string,
  to: string,
  fillOnly = false,
): Promise<MoveReport> {
  const fromFull = `${deps.namespace}.${from}`;
  const toFull = `${deps.namespace}.${to}`;
  const report: MoveReport = { datapoints: 0, enums: 0, aliases: 0, history: 0 };
  const all = await deps.objects();
  const complete = !fillOnly && (all[toFull]?.native as { idScheme?: unknown } | undefined)?.idScheme === ID_SCHEME;
  if (!complete) {
    const present = fillOnly ? await deps.states(`${toFull}.*`) : {};
    // Shallow first, the device object after its children; the mark itself is written last, below.
    const tree = Object.entries(all)
      .filter(
        (entry): entry is [string, ioBroker.Object] => !!entry[1] && movedId(entry[0], fromFull, toFull) !== undefined,
      )
      .sort(([a], [b]) => a.length - b.length);
    let deviceObject: ioBroker.SettableObject | undefined;
    for (const [id, obj] of tree) {
      const next = movedId(id, fromFull, toFull)!;
      if (fillOnly && all[next]) {
        continue;
      }
      const { object, history } = rewriteMovedObject(id, obj, fromFull, toFull);
      report.history += history;
      if (id === fromFull) {
        deviceObject = object;
        continue;
      }
      await deps.setObject(next, object);
      if (obj.type === "state") {
        report.datapoints++;
      }
    }
    if (deviceObject) {
      await deps.setObject(toFull, deviceObject);
    }
    const states = await deps.states(`${fromFull}.*`);
    for (const [id, state] of Object.entries(states)) {
      const next = movedId(id, fromFull, toFull);
      if (!next || !state || state.val === undefined) {
        continue;
      }
      const had = present[next];
      if (fillOnly && had && had.val !== null && had.val !== undefined) {
        continue;
      }
      await deps.setState(next, {
        val: state.val,
        ack: state.ack,
        ...(typeof state.ts === "number" ? { ts: state.ts } : {}),
        ...(typeof state.lc === "number" ? { lc: state.lc } : {}),
        ...(typeof state.q === "number" ? { q: state.q } : {}),
      });
    }
  }
  report.aliases = await retargetAliases(
    await deps.aliases(),
    id => movedId(id, fromFull, toFull),
    (id, obj) => deps.setObject(id, obj),
  );
  // The mark goes on last — only a whole copy may skip the copy on a repeated run.
  if (!complete && !fillOnly) {
    await deps.extendObject(toFull, { native: { idScheme: ID_SCHEME } });
  }
  return report;
}
