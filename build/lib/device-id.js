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
var device_id_exports = {};
__export(device_id_exports, {
  ID_SCHEME: () => ID_SCHEME,
  deviceIdFor: () => deviceIdFor,
  legacyRootOf: () => legacyRootOf,
  modelPart: () => modelPart,
  pieceNumber: () => pieceNumber
});
module.exports = __toCommonJS(device_id_exports);
var import_pure_helpers = require("./pure-helpers");
const ID_SCHEME = 3;
const RESERVED_DEVICE_IDS = /* @__PURE__ */ new Set(["auth", "info"]);
const PIECE_TAIL = 4;
function modelPart(source) {
  const enumberModel = typeof source.enumber === "string" ? source.enumber.split("/")[0] : void 0;
  for (const candidate of [source.vib, enumberModel, source.type]) {
    if (typeof candidate === "string") {
      const slug = (0, import_pure_helpers.slugOf)(candidate.trim());
      if (slug.length > 0) {
        return slug;
      }
    }
  }
  return "device";
}
function pieceNumber(haId) {
  var _a;
  const clean = (text) => text.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  const last = clean((_a = haId.split("-").at(-1)) != null ? _a : "");
  const piece = last.length > 0 ? last : clean(haId);
  return piece.length > 0 ? piece : void 0;
}
function counted(base, taken) {
  let id = base;
  for (let n = 2; taken.has(id) || RESERVED_DEVICE_IDS.has(id); n++) {
    id = `${base}-${n}`;
  }
  return id;
}
function deviceIdFor(source, taken) {
  const model = modelPart(source);
  const piece = pieceNumber(source.haId);
  if (!piece) {
    return counted(model, taken);
  }
  const short = `${model}-${piece.slice(-PIECE_TAIL)}`;
  if (!taken.has(short)) {
    return short;
  }
  return counted(`${model}-${piece}`, taken);
}
function legacyRootOf(haId) {
  return haId.replace(/\.?-001*$/, "");
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ID_SCHEME,
  deviceIdFor,
  legacyRootOf,
  modelPart,
  pieceNumber
});
//# sourceMappingURL=device-id.js.map
