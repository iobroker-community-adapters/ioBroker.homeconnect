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
var command_dispatch_exports = {};
__export(command_dispatch_exports, {
  ambiguousCandidates: () => ambiguousCandidates,
  resolveEnum: () => resolveEnum,
  resolveValue: () => resolveValue,
  resolveWrite: () => resolveWrite
});
module.exports = __toCommonJS(command_dispatch_exports);
var import_value_transformer = require("./value-transformer");
var import_switch_values = require("./switch-values");
var import_value_units = require("./value-units");
function resolveWrite(ctx) {
  const base = `/api/homeappliances/${encodeURIComponent(ctx.haId)}`;
  const key = ctx.bshKey === void 0 ? void 0 : encodeURIComponent(ctx.bshKey);
  if (ctx.channel === "settings" && ctx.bshKey) {
    const value = resolveValue(ctx.value, ctx.bshValues, ctx.collapseEnum, ctx.bshKey);
    if (value === void 0) {
      return null;
    }
    return { method: "PUT", path: `${base}/settings/${key}`, body: { key: ctx.bshKey, value } };
  }
  if (ctx.channel === "commands" && ctx.bshKey) {
    return ctx.value === true ? { method: "PUT", path: `${base}/commands/${key}`, body: { key: ctx.bshKey, value: true } } : null;
  }
  if (ctx.channel === "options" && ctx.bshKey) {
    const value = resolveValue(ctx.value, ctx.bshValues, ctx.collapseEnum, ctx.bshKey);
    if (value === void 0) {
      return null;
    }
    return { method: "PUT", path: `${base}/programs/selected/options/${key}`, body: { key: ctx.bshKey, value } };
  }
  if (ctx.channel === "programs") {
    if (ctx.id === "selectedProgram" && ctx.bshKey) {
      const key2 = resolveEnum(ctx.value, ctx.bshValues);
      return key2 ? { method: "PUT", path: `${base}/programs/selected`, body: { key: key2 } } : null;
    }
    if (ctx.id === "start" && ctx.value === true) {
      if (!ctx.selectedProgramKey) {
        return null;
      }
      const body = { key: ctx.selectedProgramKey };
      if (ctx.selectedOptions && ctx.selectedOptions.length > 0) {
        body.options = ctx.selectedOptions;
      }
      return { method: "PUT", path: `${base}/programs/active`, body };
    }
    if (ctx.id === "stop" && ctx.value === true) {
      return { method: "DELETE", path: `${base}/programs/active` };
    }
  }
  return null;
}
function resolveValue(value, bshValues, collapse = false, key) {
  if (typeof value === "boolean" && bshValues && bshValues.length > 0) {
    return (0, import_switch_values.switchValue)(value, bshValues);
  }
  if (bshValues && bshValues.length > 0) {
    return resolveEnum(value, bshValues, collapse);
  }
  const p = typeof value === "number" ? (0, import_value_units.shownPresentation)(key) : void 0;
  return p && typeof value === "number" ? (0, import_value_units.fromShown)(value, p) : value;
}
function resolveEnum(value, bshValues, collapse = false) {
  if (typeof value !== "string" || !bshValues || bshValues.length === 0) {
    return void 0;
  }
  const wanted = value.toLowerCase();
  const full = bshValues.find((v) => v.toLowerCase() === wanted);
  if (full) {
    return full;
  }
  const listed = bshValues.find((v) => (0, import_value_transformer.shortEnumIn)(v, bshValues) === wanted);
  if (listed) {
    return listed;
  }
  const twoSegments = bshValues.filter((v) => v.split(".").slice(-2).join(".").toLowerCase() === wanted);
  if (twoSegments.length === 1) {
    return twoSegments[0];
  }
  const bySegment = bshValues.filter((v) => (0, import_value_transformer.shortEnum)(v) === wanted);
  return bySegment.length === 1 || collapse && bySegment.length > 1 ? bySegment[0] : void 0;
}
function ambiguousCandidates(value, bshValues) {
  if (typeof value !== "string" || !bshValues) {
    return [];
  }
  const wanted = value.toLowerCase();
  const hits = bshValues.filter((v) => (0, import_value_transformer.shortEnum)(v) === wanted);
  return hits.length > 1 ? hits : [];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ambiguousCandidates,
  resolveEnum,
  resolveValue,
  resolveWrite
});
//# sourceMappingURL=command-dispatch.js.map
