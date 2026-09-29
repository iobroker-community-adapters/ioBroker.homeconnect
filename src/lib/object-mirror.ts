// The adapter's own objects as the database holds them, so a write that would change nothing is not made.
//
// js-controller has no `extendObjectChanged`: `extendObject` always writes, stamps `ts` anew and sends an
// `objectChange` to every subscriber (7.2.2) — on every start of a real installation, also when nothing
// changed. The fleet recipe (Entwicklung/CLAUDE_PATTERNS.md § "Objekte nur bei Unterschied schreiben", tooling
// round 61): read the own tree ONCE at start, compare every write against it (`coveredBy`), write only on a
// difference, and afterwards hold what the write left behind.

/**
 * True when every field of `patch` already sits in `stored` — extendObject would change nothing. Objects are
 * compared field by field (extendObject merges them), arrays and values as a whole. The fleet form, unchanged.
 *
 * @param patch what the adapter would write
 * @param stored the object as it is in the database
 * @returns whether the write can be left out
 */
export function coveredBy(patch: unknown, stored: unknown): boolean {
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return (
      !!stored &&
      typeof stored === "object" &&
      !Array.isArray(stored) &&
      Object.entries(patch).every(([k, v]) => coveredBy(v, (stored as Record<string, unknown>)[k]))
    );
  }
  return JSON.stringify(patch) === JSON.stringify(stored);
}

/**
 * What `extendObject(patch)` leaves of `stored`, as the objects database merges (`node.extend(true, …)`,
 * js-controller 7.2.2): plain objects key by key, arrays index by index into a stored array — a shorter array keeps
 * the stored tail —, a value or `null` takes the place, `undefined` changes nothing.
 *
 * @param stored the object before the write (not changed)
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
  if (!patch || typeof patch !== "object") {
    return patch;
  }
  const base: Record<string, unknown> =
    stored && typeof stored === "object" && !Array.isArray(stored) ? { ...(stored as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) {
      base[key] = mergedWith(base[key], value);
    }
  }
  return base;
}

/**
 * The own objects by full id. Everything the adapter writes goes through {@link ObjectMirror.covers} first and
 * {@link ObjectMirror.wrote} (or {@link ObjectMirror.replaced}) after; a deletion goes through
 * {@link ObjectMirror.forgetTree}. An id the mirror does not know is always written — an unread tree costs writes,
 * never a missing one.
 */
export class ObjectMirror {
  private readonly objects = new Map<string, unknown>();

  /**
   * @param namespace the instance namespace (`homeconnect.0`); only ids below it are held
   */
  constructor(private readonly namespace: string) {}

  /**
   * The full id of an own relative id (`info.connection` → `homeconnect.0.info.connection`).
   *
   * @param id a relative or full id
   * @returns the full id
   */
  fullId(id: string): string {
    return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
  }

  /**
   * Take the start-up read of the own tree.
   *
   * @param rows the rows of `getObjectList` over the namespace
   */
  load(rows: ReadonlyArray<{ id: string; value?: unknown }>): void {
    this.objects.clear();
    for (const row of rows) {
      if (row.value) {
        this.objects.set(row.id, row.value);
      }
    }
  }

  /**
   * Whether writing `patch` to `id` would change nothing.
   *
   * @param id a relative or full id
   * @param patch what would be written
   * @returns true when the write can be left out
   */
  covers(id: string, patch: unknown): boolean {
    const stored = this.objects.get(this.fullId(id));
    return stored !== undefined && coveredBy(patch, stored);
  }

  /**
   * Hold what an `extendObject` left behind.
   *
   * @param id a relative or full id
   * @param patch what was written
   */
  wrote(id: string, patch: unknown): void {
    const full = this.fullId(id);
    this.objects.set(full, mergedWith(this.objects.get(full), patch));
  }

  /**
   * Hold what a `setForeignObject` wrote — the whole object, nothing merged.
   *
   * @param id a relative or full own id
   * @param obj the object written
   */
  replaced(id: string, obj: unknown): void {
    this.objects.set(this.fullId(id), obj);
  }

  /**
   * Forget one object — after a non-recursive deletion; what lies below it stays.
   *
   * @param id a relative or full id
   */
  forget(id: string): void {
    this.objects.delete(this.fullId(id));
  }

  /**
   * Forget an object and everything below it — after a deletion, a later write must create it again.
   *
   * @param id a relative or full id
   */
  forgetTree(id: string): void {
    const full = this.fullId(id);
    for (const known of [...this.objects.keys()]) {
      if (known === full || known.startsWith(`${full}.`)) {
        this.objects.delete(known);
      }
    }
  }
}
