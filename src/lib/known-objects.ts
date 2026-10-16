// Fleet master — the release run requires this file byte for byte in every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
//
// The adapter's own objects as the database holds them, so a write that would change nothing is not made.
// js-controller has no `extendObjectChanged`: `extendObject` always writes, stamps `ts` anew and sends an
// `objectChange` to every subscriber (7.2.2) — on every start of a real installation, also when nothing changed.
// Read the own tree once, compare every write against it, write only on a difference, hold what the write left.

/**
 * A plain object — what the merge descends into (`is.hash` in node.extend), as opposed to an array, null or a value.
 *
 * @param value anything
 * @returns whether it is a plain object
 */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * What `extendObject(patch)` leaves of `stored`, as the objects database merges (`extend(true, oldObj, obj)` with
 * node.extend, js-controller 7.2.2): plain objects key by key, arrays index by index into a stored array — a shorter
 * array keeps the stored tail —, a value or `null` takes the place, `undefined` changes nothing. `stored` is not
 * changed.
 *
 * @param stored the object before the write
 * @param patch what was written
 * @returns the object after the write
 */
export function mergedWith(stored: unknown, patch: unknown): unknown {
  if (Array.isArray(patch)) {
    const base: unknown[] = Array.isArray(stored) ? [...(stored as unknown[])] : [];
    patch.forEach((value, i) => {
      if (value !== undefined) {
        base[i] = mergedWith(base[i], value);
      }
    });
    return base;
  }
  if (!isPlain(patch)) {
    return patch;
  }
  const base: Record<string, unknown> = isPlain(stored) ? { ...stored } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      base[key] = mergedWith(base[key], value);
    }
  }
  return base;
}

/**
 * Structural equality: plain objects key by key in any order, arrays element by element, values by `Object.is`.
 *
 * @param a one value
 * @param b the other
 * @returns whether they are the same structure
 */
export function sameStructure(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => sameStructure(value, b[i]))
    );
  }
  if (isPlain(a) && isPlain(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(key => Object.prototype.hasOwnProperty.call(b, key) && sameStructure(a[key], b[key]))
    );
  }
  return false;
}

/**
 * True when `extendObject(patch)` would change nothing of `stored` — merging the patch leaves the same structure.
 *
 * @param patch what the adapter would write
 * @param stored the object as it is in the database (undefined when unknown)
 * @returns whether the write can be left out
 */
export function coveredBy(patch: unknown, stored: unknown): boolean {
  return sameStructure(mergedWith(stored, patch), stored);
}

/** Stamped by the adapter layer on every write (`from`, `user`, `ts`) — never the adapter's own content. */
const STAMPED = ["from", "user", "ts"] as const;

/** Common settings the objects database keeps from the old object when the new one leaves them out. */
const PRESERVED_COMMON = ["custom", "smartName", "material", "habpanel", "mobile"] as const;

/**
 * What `setForeignObject(id, obj)` leaves in the database, as js-controller 7.2.2 writes it: the adapter layer stamps
 * `from`/`user`/`ts` (taken over from `stored` here, they change on every write and are not the adapter's content),
 * the objects database (`objectsInRedisClient.ts` `_setObject`) sets `_id`, keeps the old `acl` when the new object
 * has none, keeps each preserved common setting the new object leaves out (`custom` only for a state, and merged
 * attribute by attribute when both carry it) and deletes one set to `null`. A new object without `common` keeps a
 * preserved setting only when the old `custom` gives it a `common` first.
 *
 * @param id the full id
 * @param stored the object before the write (undefined when unknown)
 * @param obj the whole object written
 * @returns the object after the write
 */
export function storedAfterSet(id: string, stored: unknown, obj: unknown): unknown {
  if (!isPlain(obj)) {
    return obj;
  }
  const result: Record<string, unknown> = structuredClone(obj);
  const old = isPlain(stored) ? stored : undefined;
  for (const key of STAMPED) {
    if (old && key in old) {
      result[key] = old[key];
    } else {
      delete result[key];
    }
  }
  result._id = id;
  if (old && old.acl !== undefined && result.acl === undefined) {
    result.acl = structuredClone(old.acl);
  }
  const oldCommon = old && isPlain(old.common) ? old.common : undefined;
  if (oldCommon) {
    const common: Record<string, unknown> = isPlain(result.common) ? result.common : {};
    let touched = isPlain(result.common);
    for (const key of PRESERVED_COMMON) {
      const before = oldCommon[key];
      if (key === "custom") {
        const custom = isPlain(common.custom) ? common.custom : undefined;
        if (!custom && isPlain(before) && result.type === "state") {
          common.custom = structuredClone(before);
          touched = true;
        } else if (custom && isPlain(before)) {
          for (const attr of Object.keys(before)) {
            if (custom[attr] === undefined) {
              custom[attr] = structuredClone(before[attr]);
            }
          }
        }
        if (isPlain(common.custom)) {
          for (const attr of Object.keys(common.custom)) {
            if (common.custom[attr] === null) {
              delete common.custom[attr];
            }
          }
          if (Object.keys(common.custom).length === 0) {
            delete common.custom;
          }
        }
      } else if (common[key] === null) {
        delete common[key];
      } else if (before !== undefined && common[key] === undefined) {
        // 7.2.2 puts it into a local `objCommon = objCommon || {}`: without a `common` of its own the object keeps
        // the setting only when the custom step above attached one
        common[key] = structuredClone(before);
      }
    }
    if (touched) {
      result.common = common;
    }
  }
  return result;
}

/** The adapter methods the store needs — an `ioBroker.Adapter` carries all of them. */
export interface KnownObjectsAdapter {
  /** e.g. "demo.0" */
  namespace: string;
  /** Merges into an object of the own namespace (relative or full id). */
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<unknown>;
  /** Replaces an object completely. */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
  /** Deletes an object (with `recursive` its children too). */
  delObjectAsync(id: string, options?: { recursive?: boolean }): Promise<unknown>;
  /** Reads the objects between two ids. */
  getObjectListAsync(params: {
    startkey: string;
    endkey: string;
  }): Promise<{ rows: Array<{ id: string; value: unknown }> }>;
}

/**
 * The adapter's own object tree, read once at start: every object write goes through here and reaches the database
 * only when it changes something; afterwards the store holds what the write left behind. Operations that overlap — the
 * same id, an id below a recursive remove, anything during the load — run one after the other, so each compares against
 * what the one before it left; operations on different ids run side by side.
 */
export class KnownObjects {
  private readonly adapter: KnownObjectsAdapter;
  private readonly objects = new Map<string, unknown>();
  /** The last running operation per id — a later one on the same id starts after it. */
  private readonly running = new Map<string, Promise<void>>();
  /** The running operations that cover a whole subtree (a recursive remove, the load of the own tree). */
  private readonly subtrees = new Map<string, Promise<void>>();

  /** @param adapter the adapter */
  public constructor(adapter: KnownObjectsAdapter) {
    this.adapter = adapter;
  }

  /**
   * The full id of an own object.
   *
   * @param id relative or full id
   * @returns the id with the namespace in front
   */
  private full(id: string): string {
    const ns = `${this.adapter.namespace}.`;
    return id.startsWith(ns) ? id : `${ns}${id}`;
  }

  /**
   * Runs one operation after every running one it overlaps: the same id, an id below a running subtree operation, or —
   * for a subtree operation — any running id below it. Each compares against and merges onto what the one before it
   * left; two that overlapped both read the object as it stood before them, and the later one wrote its picture over
   * the earlier patch in the store, so a write back to the old value was judged "already there" and left out. A failed
   * operation does not block the ones after it.
   *
   * @param key the full id
   * @param subtree whether the operation covers everything below the id
   * @param operation the read-compare-write
   * @returns what the operation returns
   */
  private serialized<T>(key: string, subtree: boolean, operation: () => Promise<T>): Promise<T> {
    const below = `${key}.`;
    const before: Array<Promise<void>> = [];
    const same = this.running.get(key);
    if (same) {
      before.push(same);
    }
    if (subtree) {
      for (const [other, done] of this.running) {
        if (other.startsWith(below)) {
          before.push(done);
        }
      }
    }
    for (const [root, done] of this.subtrees) {
      if (key.startsWith(`${root}.`)) {
        before.push(done);
      }
    }
    const result = Promise.all(before).then(operation);
    const done = result.then(
      () => undefined,
      () => undefined,
    );
    this.running.set(key, done);
    if (subtree) {
      this.subtrees.set(key, done);
    }
    void done.then(() => {
      if (this.running.get(key) === done) {
        this.running.delete(key);
      }
      if (this.subtrees.get(key) === done) {
        this.subtrees.delete(key);
      }
    });
    return result;
  }

  /** Reads the whole own tree with one call. Before it, only what this instance wrote itself is known. */
  public async load(): Promise<void> {
    const ns = `${this.adapter.namespace}.`;
    return await this.serialized(this.adapter.namespace, true, async () => {
      const list = await this.adapter.getObjectListAsync({ startkey: ns, endkey: `${ns}香` });
      this.objects.clear();
      for (const row of list.rows) {
        if (row.value) {
          this.objects.set(row.id, row.value);
        }
      }
    });
  }

  /**
   * The object as last read or written.
   *
   * @param id relative or full id
   * @returns the object, undefined when unknown
   */
  public get(id: string): unknown {
    return this.objects.get(this.full(id));
  }

  /**
   * `extendObject`, left out when the stored object already carries the patch.
   *
   * @param id relative or full id
   * @param patch the fields to merge
   * @returns whether the database was written
   */
  public async extend(id: string, patch: ioBroker.PartialObject): Promise<boolean> {
    const key = this.full(id);
    return await this.serialized(key, false, async () => {
      const stored = this.objects.get(key);
      if (coveredBy(patch, stored)) {
        return false;
      }
      await this.adapter.extendObject(id, patch);
      this.objects.set(key, mergedWith(stored, patch));
      return true;
    });
  }

  /**
   * `setForeignObject` of a whole object, left out when the database would hold the same afterwards.
   *
   * @param id full id
   * @param obj the whole object
   * @returns whether the database was written
   */
  public async replace(id: string, obj: ioBroker.SettableObject): Promise<boolean> {
    return await this.serialized(this.full(id), false, async () => {
      const stored = this.objects.get(id);
      const after = storedAfterSet(id, stored, obj);
      if (sameStructure(after, stored)) {
        return false;
      }
      await this.adapter.setForeignObject(id, obj);
      this.objects.set(id, after);
      return true;
    });
  }

  /**
   * `delObject` — the object (with `recursive` its children too) is forgotten, so an id used again is written anew.
   *
   * @param id relative or full id
   * @param options delete the children too
   * @param options.recursive whether the children go as well
   */
  public async remove(id: string, options: { recursive: boolean } = { recursive: false }): Promise<void> {
    const key = this.full(id);
    await this.serialized(key, options.recursive, async () => {
      await this.adapter.delObjectAsync(id, options);
      for (const known of [...this.objects.keys()]) {
        if (known === key || (options.recursive && known.startsWith(`${key}.`))) {
          this.objects.delete(known);
        }
      }
    });
  }
}
