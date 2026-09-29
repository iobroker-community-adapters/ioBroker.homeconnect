/**
 * Moves an object to a new id and carries the user's room and function assignments (the enum
 * memberships) along — in the only order that cannot lose them.
 *
 * Deleting an object with `delForeignObject(Async)` runs `removeIdFromAllEnums(objects, id, this.enums)`
 * (js-controller 7.2.2 `adapter.ts` `_delForeignObject`), and that writes every affected enum object
 * back WHOLE from the adapter's enum cache (common-db `tools.ts` `removeIdFromAllEnums`). The cache
 * follows the `enum.*` subscription, asynchronously. A carry that adds the new id BEFORE the delete
 * can therefore be overwritten by the delete a moment later, with a cached enum that does not know the
 * new id yet — the user's assignment is gone. Measured at the source, reported by the hassemu audit
 * (2026-09-25); both fleet carriers wrote before the delete.
 *
 * The order here: (1) read the enums that hold the old id, fresh from the object store, (2) let the
 * caller delete the old object, (3) only then write the new id into exactly those enums, each read
 * fresh and written back as a copy with `setForeignObject` (a merge would keep a stale array tail) —
 * the Promise form without a callback; its `…Async` twin is `@deprecated` in `@iobroker/types` 7.2.2.
 *
 * Many ids at once — a device tree, a list of renamed datapoints: `moveAllWithEnums` reads the enums ONCE, lets the
 * caller delete once, and writes every affected enum ONCE with all its new ids. A loop around `moveWithEnums` reads
 * every `enum.*` object per moved id and writes an enum once per id it holds (measured 2026-09-29: four adapters built
 * that loop by hand, three of them nesting the deletes into closures so that every read ran before the single delete).
 *
 * A recursive delete removes the ROOT first: `delObject(root, { recursive: true })` lists the root, then every id below
 * it, and deletes them in that order, each followed by `removeIdFromAllEnums` (js-controller 7.2.2 `adapter.ts`
 * `_delForeignObject` → `_deleteObjects`). Whatever the caller keeps on the root to finish an interrupted move later
 * (a journal in `native`) is gone before the first child — a crash in between leaves the children without it. Keep
 * such a journal elsewhere, or delete the children first and the root last.
 *
 * Fleet master: `Entwicklung/.consistency-master/src/lib/enum-carry.ts`. Every adapter that moves
 * objects between ids carries this file and its test byte for byte — the release run (consistency
 * level 1) reports any difference. Change the master, then copy; never the copy. The file imports
 * nothing adapter-specific: the caller hands in its own error-text helper.
 */

/** The object-store surface the carry needs. */
export interface EnumCarryAdapter {
  /** Reads all objects matching the pattern, here `enum.*` of type `enum`. */
  getForeignObjectsAsync(pattern: string, type: "enum"): Promise<Record<string, unknown> | null | undefined>;
  /** Reads one object. */
  getForeignObjectAsync(id: string): Promise<unknown>;
  /** Writes one object whole — the copy form. */
  setForeignObject(id: string, obj: Record<string, unknown>): Promise<unknown>;
  /** Adapter log — a warning when a read or a write fails. */
  log: { warn: (msg: string) => void };
}

interface EnumObject {
  common?: { members?: unknown };
}

const membersOf = (obj: unknown): string[] => {
  const members = (obj as EnumObject | null | undefined)?.common?.members;
  return Array.isArray(members) ? members.filter((m): m is string => typeof m === "string") : [];
};

/**
 * The enum ids whose members contain `id` — pure, so the selection is testable without an adapter.
 *
 * @param enums the enum objects by id, as `getForeignObjectsAsync("enum.*", "enum")` returns them
 * @param id the object id to look for
 * @returns the enum ids that list `id`, sorted
 */
export function enumsHolding(enums: Record<string, unknown> | null | undefined, id: string): string[] {
  return Object.entries(enums ?? {})
    .filter(([, obj]) => membersOf(obj).includes(id))
    .map(([enumId]) => enumId)
    .sort();
}

/** One enum a carry wrote: its id and the new ids it lists now. */
export interface CarriedEnum {
  /** The enum object id, e.g. `enum.rooms.living`. */
  enumId: string;
  /** The new ids the carry put into this enum, in the order they were added. */
  newIds: string[];
}

/**
 * The carry plan — pure, so the selection is testable without an adapter: for every enum, which of its members move
 * and to which new ids.
 *
 * @param enums the enum objects by id, as `getForeignObjectsAsync("enum.*", "enum")` returns them
 * @param successors the new full ids of a member that moves, an empty list for one that stays
 * @returns enum id → (old id → new ids), only enums holding at least one moved member, sorted by enum id
 */
export function carryPlan(
  enums: Record<string, unknown> | null | undefined,
  successors: (memberId: string) => readonly string[],
): Map<string, Map<string, readonly string[]>> {
  const plan = new Map<string, Map<string, readonly string[]>>();
  for (const enumId of Object.keys(enums ?? {}).sort()) {
    for (const member of membersOf(enums?.[enumId])) {
      const next = successors(member);
      if (next.length > 0) {
        const moves = plan.get(enumId) ?? new Map<string, readonly string[]>();
        moves.set(member, next);
        plan.set(enumId, moves);
      }
    }
  }
  return plan;
}

/**
 * Read, let the caller delete, write — the one carry both entry points run. `subject` names what moves in the
 * warning when the enums cannot be read.
 *
 * @param adapter the adapter (object I/O, log)
 * @param successors the new full ids of a member that moves
 * @param remove the caller's delete
 * @param describeError the adapter's error-text helper
 * @param subject e.g. ` of a.0.old`, empty for many ids
 */
async function carry(
  adapter: EnumCarryAdapter,
  successors: (memberId: string) => readonly string[],
  remove: () => Promise<unknown>,
  describeError: (err: unknown) => string,
  subject: string,
): Promise<CarriedEnum[]> {
  let plan = new Map<string, Map<string, readonly string[]>>();
  try {
    plan = carryPlan(await adapter.getForeignObjectsAsync("enum.*", "enum"), successors);
  } catch (err) {
    adapter.log.warn(`Room and function assignments${subject} could not be read: ${describeError(err)}`);
  }
  await remove();
  const carried: CarriedEnum[] = [];
  for (const [enumId, moves] of plan) {
    const newIds = [...new Set([...moves.values()].flat())];
    try {
      const fresh = (await adapter.getForeignObjectAsync(enumId)) as (EnumObject & Record<string, unknown>) | null;
      if (!fresh) {
        continue;
      }
      const members = membersOf(fresh).filter(m => !moves.has(m));
      for (const id of newIds) {
        if (!members.includes(id)) {
          members.push(id);
        }
      }
      await adapter.setForeignObject(enumId, { ...fresh, common: { ...fresh.common, members } });
      carried.push({ enumId, newIds });
    } catch (err) {
      adapter.log.warn(`Assignment ${enumId} could not be carried to ${newIds.join(", ")}: ${describeError(err)}`);
    }
  }
  return carried;
}

/**
 * Deletes through `remove` and carries the enum memberships of every moved id to its successors — the enums are read
 * once before the delete, every affected enum is read fresh and written once after it.
 *
 * @param adapter the adapter (object I/O, log)
 * @param successors the new full ids of a member that moves (e.g. every id below an old device root, mapped below the
 *   new root), an empty list for every other member
 * @param remove the caller's delete of everything that goes away (e.g. `() => this.delObjectAsync(root, { recursive: true })`)
 * @param describeError the adapter's error-text helper (one per repository)
 * @returns the enums that were written and the new ids each got — empty when no moved id was in an enum, or when
 *   reading failed
 */
export async function moveAllWithEnums(
  adapter: EnumCarryAdapter,
  successors: (memberId: string) => readonly string[],
  remove: () => Promise<unknown>,
  describeError: (err: unknown) => string,
): Promise<CarriedEnum[]> {
  return carry(adapter, successors, remove, describeError, "");
}

/**
 * Deletes the old object through `remove` and carries its enum memberships to `newId` — read first,
 * delete second, write last. One id; for more than one, `moveAllWithEnums`.
 *
 * @param adapter the adapter (object I/O, log)
 * @param oldId the full id of the object that goes away
 * @param newId the full id that takes its place (it must exist before the carry is useful)
 * @param remove the caller's delete of the old object (e.g. `() => this.delForeignObjectAsync(oldId)`)
 * @param describeError the adapter's error-text helper (one per repository)
 * @returns the enum ids that now list `newId` — empty when the old id was in none, or when reading failed
 */
export async function moveWithEnums(
  adapter: EnumCarryAdapter,
  oldId: string,
  newId: string,
  remove: () => Promise<unknown>,
  describeError: (err: unknown) => string,
): Promise<string[]> {
  const carried = await carry(adapter, id => (id === oldId ? [newId] : []), remove, describeError, ` of ${oldId}`);
  return carried.map(c => c.enumId);
}
