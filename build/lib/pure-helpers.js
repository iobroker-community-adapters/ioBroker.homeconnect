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
var pure_helpers_exports = {};
__export(pure_helpers_exports, {
  cleanLabel: () => cleanLabel,
  coerceForType: () => coerceForType,
  errMessage: () => errMessage,
  humanizeId: () => humanizeId,
  isRecord: () => isRecord,
  numberOrUndef: () => numberOrUndef,
  slugOf: () => slugOf,
  stringArrayOrUndef: () => stringArrayOrUndef
});
module.exports = __toCommonJS(pure_helpers_exports);
function slugOf(name) {
  return name.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function errMessage(err) {
  var _a;
  try {
    if (err instanceof Error) {
      const code = "code" in err ? err.code : void 0;
      const message = err.message;
      const name = err.name;
      const text = String(message || (typeof code === "string" ? code : name));
      const cause = err.cause;
      let reason = "";
      if (cause instanceof Error) {
        const causeCode = "code" in cause ? cause.code : void 0;
        const causeMessage = cause.message;
        reason = (typeof causeMessage === "string" ? causeMessage : "") || (typeof causeCode === "string" ? causeCode : "");
      } else if (cause !== void 0 && cause !== null) {
        reason = errMessage(cause);
      }
      return reason && !text.includes(reason) ? `${text} (${reason})` : text;
    }
    if (typeof err === "string") {
      return err;
    }
    if (typeof err === "function") {
      return Object.prototype.toString.call(err);
    }
    if (err === null || err === void 0 || typeof err !== "object") {
      return String(err);
    }
    return (_a = JSON.stringify(err)) != null ? _a : Object.prototype.toString.call(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function numberOrUndef(v) {
  return typeof v === "number" ? v : void 0;
}
function stringArrayOrUndef(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : void 0;
}
const MAX_LABEL_LENGTH = 200;
function cleanLabel(raw, fallback = "") {
  if (typeof raw !== "string") {
    return fallback;
  }
  const cleaned = raw.replace(new RegExp("\\p{Cc}+", "gu"), " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) {
    return fallback;
  }
  return cleaned.length > MAX_LABEL_LENGTH ? `${cleaned.slice(0, MAX_LABEL_LENGTH - 1)}\u2026` : cleaned;
}
function humanizeId(id) {
  const brand = /^([a-z][A-Z][a-z]+)/.exec(id);
  const head = brand ? brand[1] : "";
  const words = (head ? id.slice(head.length) : id).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2").replace(/(\d)([A-Za-z])/g, "$1 $2").split(/[\s_]+/).filter((w) => w.length > 0);
  if (words.length === 0) {
    return head.length > 0 ? head : id;
  }
  const text = words.map((w) => w.toLowerCase()).join(" ");
  return head.length > 0 ? `${head} ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}
function coerceForType(value, type) {
  if (value === null || value === void 0) {
    return void 0;
  }
  switch (type) {
    case "boolean": {
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value === "number") {
        return value !== 0;
      }
      if (typeof value === "string") {
        const s = value.trim().toLowerCase();
        if (["true", "1", "on", "yes"].includes(s)) {
          return true;
        }
        if (["false", "0", "off", "no"].includes(s)) {
          return false;
        }
      }
      return void 0;
    }
    case "number": {
      if (typeof value === "number") {
        return Number.isFinite(value) ? value : void 0;
      }
      if (typeof value === "boolean") {
        return value ? 1 : 0;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        const n = Number(value);
        return Number.isFinite(n) ? n : void 0;
      }
      return void 0;
    }
    case "string":
      return typeof value === "string" ? value : String(value);
    default:
      return value;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  cleanLabel,
  coerceForType,
  errMessage,
  humanizeId,
  isRecord,
  numberOrUndef,
  slugOf,
  stringArrayOrUndef
});
//# sourceMappingURL=pure-helpers.js.map
