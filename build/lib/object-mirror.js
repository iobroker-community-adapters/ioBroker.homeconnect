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
var object_mirror_exports = {};
__export(object_mirror_exports, {
  ObjectMirror: () => ObjectMirror,
  coveredBy: () => coveredBy,
  mergedWith: () => mergedWith
});
module.exports = __toCommonJS(object_mirror_exports);
function coveredBy(patch, stored) {
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    return !!stored && typeof stored === "object" && !Array.isArray(stored) && Object.entries(patch).every(([k, v]) => coveredBy(v, stored[k]));
  }
  return JSON.stringify(patch) === JSON.stringify(stored);
}
function mergedWith(stored, patch) {
  if (Array.isArray(patch)) {
    const base2 = Array.isArray(stored) ? [...stored] : [];
    patch.forEach((value, i) => {
      if (value !== void 0) {
        base2[i] = mergedWith(base2[i], value);
      }
    });
    return base2;
  }
  if (!patch || typeof patch !== "object") {
    return patch;
  }
  const base = stored && typeof stored === "object" && !Array.isArray(stored) ? { ...stored } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value !== void 0) {
      base[key] = mergedWith(base[key], value);
    }
  }
  return base;
}
class ObjectMirror {
  /**
   * @param namespace the instance namespace (`homeconnect.0`); only ids below it are held
   */
  constructor(namespace) {
    this.namespace = namespace;
  }
  namespace;
  objects = /* @__PURE__ */ new Map();
  /**
   * The full id of an own relative id (`info.connection` → `homeconnect.0.info.connection`).
   *
   * @param id a relative or full id
   * @returns the full id
   */
  fullId(id) {
    return id.startsWith(`${this.namespace}.`) ? id : `${this.namespace}.${id}`;
  }
  /**
   * Take the start-up read of the own tree.
   *
   * @param rows the rows of `getObjectList` over the namespace
   */
  load(rows) {
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
  covers(id, patch) {
    const stored = this.objects.get(this.fullId(id));
    return stored !== void 0 && coveredBy(patch, stored);
  }
  /**
   * Hold what an `extendObject` left behind.
   *
   * @param id a relative or full id
   * @param patch what was written
   */
  wrote(id, patch) {
    const full = this.fullId(id);
    this.objects.set(full, mergedWith(this.objects.get(full), patch));
  }
  /**
   * Hold what a `setForeignObject` wrote — the whole object, nothing merged.
   *
   * @param id a relative or full own id
   * @param obj the object written
   */
  replaced(id, obj) {
    this.objects.set(this.fullId(id), obj);
  }
  /**
   * Forget one object — after a non-recursive deletion; what lies below it stays.
   *
   * @param id a relative or full id
   */
  forget(id) {
    this.objects.delete(this.fullId(id));
  }
  /**
   * Forget an object and everything below it — after a deletion, a later write must create it again.
   *
   * @param id a relative or full id
   */
  forgetTree(id) {
    const full = this.fullId(id);
    for (const known of [...this.objects.keys()]) {
      if (known === full || known.startsWith(`${full}.`)) {
        this.objects.delete(known);
      }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ObjectMirror,
  coveredBy,
  mergedWith
});
//# sourceMappingURL=object-mirror.js.map
