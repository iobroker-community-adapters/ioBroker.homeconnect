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

/**
 * Deletes the old object through `remove` and carries its enum memberships to `newId` — read first,
 * delete second, write last.
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
  let holders: string[] = [];
  try {
    holders = enumsHolding(await adapter.getForeignObjectsAsync("enum.*", "enum"), oldId);
  } catch (err) {
    adapter.log.warn(`Room and function assignments of ${oldId} could not be read: ${describeError(err)}`);
  }
  await remove();
  const carried: string[] = [];
  for (const enumId of holders) {
    try {
      const fresh = (await adapter.getForeignObjectAsync(enumId)) as (EnumObject & Record<string, unknown>) | null;
      if (!fresh) {
        continue;
      }
      const members = membersOf(fresh).filter(m => m !== oldId);
      if (!members.includes(newId)) {
        members.push(newId);
      }
      await adapter.setForeignObject(enumId, { ...fresh, common: { ...fresh.common, members } });
      carried.push(enumId);
    } catch (err) {
      adapter.log.warn(`Assignment ${enumId} could not be carried to ${newId}: ${describeError(err)}`);
    }
  }
  return carried;
}
