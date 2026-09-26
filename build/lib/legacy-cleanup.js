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
var legacy_cleanup_exports = {};
__export(legacy_cleanup_exports, {
  LEGACY_LEAF: () => LEGACY_LEAF,
  planLegacyCleanup: () => planLegacyCleanup
});
module.exports = __toCommonJS(legacy_cleanup_exports);
const LEGACY_LEAF = /^[A-Z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/;
function planLegacyCleanup(objects) {
  var _a;
  const ourDeviceRoots = /* @__PURE__ */ new Set();
  const rootsInUse = /* @__PURE__ */ new Set();
  for (const [id, obj] of Object.entries(objects)) {
    const root = id.split(".")[0];
    if (!root) {
      continue;
    }
    rootsInUse.add(root);
    if (id === root && obj.type === "device" && typeof ((_a = obj.native) == null ? void 0 : _a.haId) === "string") {
      ourDeviceRoots.add(root);
    }
  }
  const legacy = /* @__PURE__ */ new Set();
  for (const root of rootsInUse) {
    if (root === "auth" || root === "info" || ourDeviceRoots.has(root)) {
      continue;
    }
    if (/[A-Z]/.test(root)) {
      legacy.add(root);
      continue;
    }
    const hasLegacyLeaf = Object.keys(objects).some((id) => {
      var _a2;
      if (!id.startsWith(`${root}.`)) {
        return false;
      }
      const leaf = (_a2 = id.split(".").at(-1)) != null ? _a2 : "";
      return LEGACY_LEAF.test(leaf);
    });
    if (hasLegacyLeaf) {
      legacy.add(root);
    }
  }
  return [...legacy].sort();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  LEGACY_LEAF,
  planLegacyCleanup
});
//# sourceMappingURL=legacy-cleanup.js.map
