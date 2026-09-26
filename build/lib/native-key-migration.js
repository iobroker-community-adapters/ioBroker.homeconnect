"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var native_key_migration_exports = {};
__export(native_key_migration_exports, {
  KEPT_COMMON_KEYS: () => KEPT_COMMON_KEYS,
  buildCommonKeyPatch: () => buildCommonKeyPatch,
  buildNativeKeyPatch: () => buildNativeKeyPatch,
  migrateNativeKeys: () => migrateNativeKeys
});
module.exports = __toCommonJS(native_key_migration_exports);
const KEPT_COMMON_KEYS = [
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
  "supportedMessages"
];
const isRename = (m) => "from" in m;
const isDrop = (m) => "drop" in m;
const isCommonDrop = (m) => "commonDrop" in m;
const isPresent = (v) => v !== void 0 && v !== null;
const isMeaningful = (v) => {
  if (!isPresent(v)) {
    return false;
  }
  if (typeof v === "string") {
    const s = v.trim();
    return s !== "" && s !== "0.0.0.0";
  }
  return true;
};
const isStorable = (v) => v !== void 0 && !(typeof v === "number" && Number.isNaN(v));
function buildNativeKeyPatch(native, migrations) {
  var _a, _b;
  const patch = {};
  const renamesByTarget = /* @__PURE__ */ new Map();
  for (const m of migrations) {
    if (isRename(m)) {
      const group = (_a = renamesByTarget.get(m.to)) != null ? _a : [];
      group.push(m);
      renamesByTarget.set(m.to, group);
    }
  }
  for (const [to, group] of renamesByTarget) {
    const present = group.filter((r) => isPresent(native[r.from]));
    if (present.length === 0) {
      continue;
    }
    const winner = (_b = present.find((r) => isMeaningful(native[r.from]))) != null ? _b : present[0];
    const value = winner.coerce ? winner.coerce(native[winner.from]) : native[winner.from];
    if (!isStorable(value)) {
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
function buildCommonKeyPatch(common, migrations) {
  const patch = {};
  for (const m of migrations) {
    if (isCommonDrop(m) && !KEPT_COMMON_KEYS.includes(m.commonDrop) && isPresent(common[m.commonDrop])) {
      patch[m.commonDrop] = null;
    }
  }
  return patch;
}
async function migrateNativeKeys(adapter, migrations, describeError) {
  const id = `system.adapter.${adapter.namespace}`;
  let native;
  let common;
  try {
    const obj = await adapter.getForeignObjectAsync(id);
    native = obj == null ? void 0 : obj.native;
    common = obj == null ? void 0 : obj.common;
  } catch (err) {
    adapter.log.warn(`Settings migration skipped \u2014 could not read ${id}: ${describeError(err)}`);
    return false;
  }
  const patch = native ? buildNativeKeyPatch(native, migrations) : {};
  const commonPatch = common ? buildCommonKeyPatch(common, migrations) : {};
  const touched = Object.keys(patch);
  const commonTouched = Object.keys(commonPatch);
  if (touched.length === 0 && commonTouched.length === 0) {
    return false;
  }
  const summary = touched.filter((k) => patch[k] !== null).map((k) => `${k} = ${JSON.stringify(patch[k])}`).join(", ");
  const removed = [...touched.filter((k) => patch[k] === null), ...commonTouched.map((k) => `common.${k}`)].join(", ");
  const write = {};
  if (touched.length > 0) {
    write.native = patch;
  }
  if (commonTouched.length > 0) {
    write.common = commonPatch;
  }
  try {
    await adapter.extendForeignObjectAsync(id, write);
    adapter.log.info(
      summary ? `Settings migrated to the standard keys (${summary}) \u2014 this instance restarts once` : `Obsolete settings removed (${removed}) \u2014 this instance restarts once`
    );
    return true;
  } catch (err) {
    adapter.log.warn(
      `Settings migration could not be stored (${describeError(err)}) \u2014 ${summary ? `using ${summary}` : `ignoring ${removed}`} for this run`
    );
    const config = adapter.config;
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  KEPT_COMMON_KEYS,
  buildCommonKeyPatch,
  buildNativeKeyPatch,
  migrateNativeKeys
});
//# sourceMappingURL=native-key-migration.js.map
