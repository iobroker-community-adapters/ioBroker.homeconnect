/**
 * One-shot migration of instance settings keys (`system.adapter.<ns>.native`) — a key that
 * was renamed or whose value type changed is carried over on the first start after the
 * update, so an existing installation keeps what its user configured; a key an earlier
 * version declared and this one no longer reads is dropped (nulled), so it does not stay in
 * every existing installation for good (js-controller never deletes a native key).
 *
 * Why this exists (fleet standard "listen-port declaration", 2026-09-15): the admin's
 * port-conflict check only sees instances carrying `native.port` AND `native.bind`, so a
 * listen address stored under any other key (`host`, `bindAddress`, `networkInterface`) is
 * invisible to it. Renaming the key in the manifest is not enough — on an update
 * js-controller ADDS every missing native key with its manifest default and never deletes
 * the old one, so after the update both keys exist: the new one with the default, the old
 * one with the user's value. A read fallback `new || old` therefore always picks the default.
 * The old value must be moved explicitly, and the old key nulled (a merge cannot delete).
 *
 * Contract for every rename onto `bind`: supply a `coerce` that turns an empty legacy value into
 * "0.0.0.0" — the admin's port-conflict check skips an instance whose `bind` is falsy
 * (`if (!instance.native?.bind) return;` in ConfigPort), so a migrated `""` would leave the
 * adapter exactly as invisible as before. The helper itself moves values verbatim.
 *
 * Two rules the write obeys, both learned in hassemu's legacy migration:
 * - Merge, never write the whole object — `extendForeignObjectAsync` with only the touched
 *   keys; `null` survives the merge (`undefined` would be skipped) and makes the old key
 *   falsy, which is all a later read needs.
 * - A write to the own instance object restarts the instance — so the caller aborts its
 *   start when this reports a write, instead of binding a port in a process about to go down.
 *
 * Fleet master: `Entwicklung/.consistency-master/src/lib/native-key-migration.ts`. Every adapter
 * that migrates native keys carries this file and its test byte for byte — the release run
 * (consistency level 1) reports any difference. Change the master, then copy; never the copy.
 * The file imports nothing adapter-specific: the caller hands in its own error-text helper.
 *
 * `common` keys too (since 2026-09-25): js-controller MERGES the manifest's `common` into the instance object on every
 * update and never removes a key (v7.2.2 `setupUpload.ts` `extendCommon`, only `visWidgets`/`localLinks` are deleted
 * and `compact` overwritten) — a key an earlier manifest declared stays in every existing instance for good, e.g.
 * `nondeletable` (the instance can no longer be deleted) or `singletonHost`. `{ commonDrop: "<key>" }` nulls it in the
 * same single write as the native changes, so the update still costs one restart. The keys js-controller keeps for the
 * user or maintains itself are never touched, whatever the table says (`KEPT_COMMON_KEYS`).
 *
 * Order within one call: every rename is applied before any drop, in one write — a takeover of a dropped key belongs
 * in the same table as `{ from, to }`; a takeover in the adapter's own code must run before this call.
 */

/** Rename: the old value wins over the freshly added default; the old key is nulled. */
export interface NativeKeyRename {
  /** The key the value used to live under. */
  from: string;
  /** The key the value moves to. */
  to: string;
  /** Optional value conversion on the way (e.g. an empty legacy string → "0.0.0.0"). */
  coerce?: (old: unknown) => unknown;
}

/** In-place coercion (same key), e.g. the manifest default `"8080"` → `8080`. */
export interface NativeKeyCoercion {
  /** The key whose value type changed. */
  key: string;
  /** Returns the value in its new form; an unchanged result writes nothing. */
  coerce: (value: unknown) => unknown;
}

/** Drop: a key an earlier version declared and this one no longer reads — nulled when it still holds a value. */
export interface NativeKeyDrop {
  /** The obsolete key. */
  drop: string;
}

/** Common drop: a key an earlier manifest declared in `common` and this one no longer does — nulled when it still holds a value. */
export interface CommonKeyDrop {
  /** The obsolete `common` key, spelled exactly as the old manifest had it. */
  commonDrop: string;
}

export type NativeKeyMigration = NativeKeyRename | NativeKeyCoercion | NativeKeyDrop | CommonKeyDrop;

/**
 * `common` keys a drop never touches: js-controller keeps them for the user on every update (`preserveAttributes` in
 * v7.2.2 `setupUpload.ts` — the instance title, schedules, mode, log level, enabled flag, custom settings, tier) or
 * maintains them itself (`visWidgets`, `localLinks`, `compact`); `supportedMessages` is repaired by the package check
 * `messagebox-repair`.
 */
export const KEPT_COMMON_KEYS: readonly string[] = [
  "title",
  "schedule",
  "restartSchedule",
  "mode",
  "loglevel",
  "enabled",
  "custom",
  "tier",
  "visWidgets",
  "localLinks",
  "compact",
  "supportedMessages",
];

/** The adapter surface the migration needs — object I/O, logging, the in-memory config. */
export interface NativeKeyMigrationAdapter {
  /** Instance namespace, e.g. `adapter.0`. */
  namespace: string;
  /** Adapter log — one info line per migration, warnings for a failed read or write. */
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  /** `adapter.config` — patched in memory only when the write fails. */
  config: object;
  /** Reads the instance object. */
  getForeignObjectAsync(id: string): Promise<unknown>;
  /** Merges the touched native and common keys into the instance object. */
  extendForeignObjectAsync(
    id: string,
    obj: { native?: Record<string, unknown>; common?: Record<string, unknown> },
  ): Promise<unknown>;
}

const isRename = (m: NativeKeyMigration): m is NativeKeyRename => "from" in m;

const isDrop = (m: NativeKeyMigration): m is NativeKeyDrop => "drop" in m;

const isCommonDrop = (m: NativeKeyMigration): m is CommonKeyDrop => "commonDrop" in m;

const isPresent = (v: unknown): boolean => v !== undefined && v !== null;

/**
 * A value that says something — when several old keys compete for one new key, a source
 * holding nothing but the manifest default ("" or "listen everywhere") must not beat a
 * source holding the concrete address the user once entered.
 *
 * @param v the candidate value
 */
const isMeaningful = (v: unknown): boolean => {
  if (!isPresent(v)) {
    return false;
  }
  if (typeof v === "string") {
    const s = v.trim();
    return s !== "" && s !== "0.0.0.0";
  }
  return true;
};

/**
 * A coercion result the migration can store — `undefined` and `NaN` would either be
 * skipped by the merge or come back as `null`, and a value that never settles would
 * restart the instance on every start.
 *
 * @param v the coerced value
 */
const isStorable = (v: unknown): boolean => v !== undefined && !(typeof v === "number" && Number.isNaN(v));

/**
 * Computes the native patch for the given migrations — pure, so the decision is testable
 * without an adapter.
 *
 * Renames targeting the same key are evaluated together, in order: the first source whose
 * value is meaningful wins; when none is, the first present one (its coercion may still turn
 * an empty legacy value into a sensible one). Every present source is nulled. A coercion
 * writes only when the coerced value differs from the stored one. A drop nulls its key when it
 * still holds a value — an absent or already nulled key writes nothing.
 *
 * @param native the instance's current native settings
 * @param migrations the renames and coercions to apply
 * @returns the keys to merge into native — empty when nothing needs to change
 */
export function buildNativeKeyPatch(
  native: Record<string, unknown>,
  migrations: NativeKeyMigration[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  const renamesByTarget = new Map<string, NativeKeyRename[]>();
  for (const m of migrations) {
    if (isRename(m)) {
      const group = renamesByTarget.get(m.to) ?? [];
      group.push(m);
      renamesByTarget.set(m.to, group);
    }
  }
  for (const [to, group] of renamesByTarget) {
    const present = group.filter(r => isPresent(native[r.from]));
    if (present.length === 0) {
      continue;
    }
    const winner = present.find(r => isMeaningful(native[r.from])) ?? present[0];
    const value = winner.coerce ? winner.coerce(native[winner.from]) : native[winner.from];
    if (!isStorable(value)) {
      // Nothing to carry over — leave the old keys untouched rather than null a value
      // that never reached its new key.
      continue;
    }
    patch[to] = value;
    for (const r of present) {
      patch[r.from] = null;
    }
  }

  for (const m of migrations) {
    if (isDrop(m) && isPresent(native[m.drop])) {
      patch[m.drop] = null;
    }
  }

  for (const m of migrations) {
    if (isRename(m) || isDrop(m) || isCommonDrop(m) || !isPresent(native[m.key])) {
      continue;
    }
    const coerced = m.coerce(native[m.key]);
    if (isStorable(coerced) && !Object.is(coerced, native[m.key])) {
      patch[m.key] = coerced;
    }
  }
  return patch;
}

/**
 * Computes the common patch — every `commonDrop` whose key still holds a value is nulled; a key in
 * `KEPT_COMMON_KEYS` never is.
 *
 * @param common the instance's current common part
 * @param migrations the table (renames, coercions and native drops are ignored here)
 * @returns the keys to merge into common — empty when nothing needs to change
 */
export function buildCommonKeyPatch(
  common: Record<string, unknown>,
  migrations: NativeKeyMigration[],
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const m of migrations) {
    if (isCommonDrop(m) && !KEPT_COMMON_KEYS.includes(m.commonDrop) && isPresent(common[m.commonDrop])) {
      patch[m.commonDrop] = null;
    }
  }
  return patch;
}

/**
 * Applies the migrations to `system.adapter.<ns>` with ONE merge of the touched keys.
 *
 * @param adapter the adapter (object I/O, log, in-memory config)
 * @param migrations the renames and coercions to apply
 * @param describeError the adapter's error-text helper (one per repository) — renders whatever
 *   the object store threw, so a rejected plain object never reads `[object Object]`
 * @returns true when the instance object was written — the caller must abort its start,
 *   the host restarts the instance with the migrated settings. false when nothing had to
 *   change, or when the write failed: then the in-memory config already carries the
 *   migrated values and the start continues with them (the write is retried next start).
 */
export async function migrateNativeKeys(
  adapter: NativeKeyMigrationAdapter,
  migrations: NativeKeyMigration[],
  describeError: (err: unknown) => string,
): Promise<boolean> {
  const id = `system.adapter.${adapter.namespace}`;
  let native: Record<string, unknown> | undefined;
  let common: Record<string, unknown> | undefined;
  try {
    const obj = (await adapter.getForeignObjectAsync(id)) as
      { native?: Record<string, unknown>; common?: Record<string, unknown> } | null | undefined;
    native = obj?.native;
    common = obj?.common;
  } catch (err) {
    adapter.log.warn(`Settings migration skipped — could not read ${id}: ${describeError(err)}`);
    return false;
  }
  const patch = native ? buildNativeKeyPatch(native, migrations) : {};
  const commonPatch = common ? buildCommonKeyPatch(common, migrations) : {};
  const touched = Object.keys(patch);
  const commonTouched = Object.keys(commonPatch);
  if (touched.length === 0 && commonTouched.length === 0) {
    return false;
  }
  const summary = touched
    .filter(k => patch[k] !== null)
    .map(k => `${k} = ${JSON.stringify(patch[k])}`)
    .join(", ");
  const removed = [...touched.filter(k => patch[k] === null), ...commonTouched.map(k => `common.${k}`)].join(", ");
  const write: { native?: Record<string, unknown>; common?: Record<string, unknown> } = {};
  if (touched.length > 0) {
    write.native = patch;
  }
  if (commonTouched.length > 0) {
    write.common = commonPatch;
  }
  try {
    await adapter.extendForeignObjectAsync(id, write);
    adapter.log.info(
      summary
        ? `Settings migrated to the standard keys (${summary}) — this instance restarts once`
        : `Obsolete settings removed (${removed}) — this instance restarts once`,
    );
    return true;
  } catch (err) {
    adapter.log.warn(
      `Settings migration could not be stored (${describeError(err)}) — ${summary ? `using ${summary}` : `ignoring ${removed}`} for this run`,
    );
    const config = adapter.config as Record<string, unknown>;
    for (const k of touched) {
      if (patch[k] === null) {
        delete config[k];
      } else {
        config[k] = patch[k];
      }
    }
    return false;
  }
}
