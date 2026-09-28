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
var program_records_exports = {};
__export(program_records_exports, {
  ERROR_CODES_KEY: () => ERROR_CODES_KEY,
  FAVORITE_PROGRAM_RE: () => FAVORITE_PROGRAM_RE,
  HISTORY_TIME_KEY: () => HISTORY_TIME_KEY,
  HISTORY_UID_KEY: () => HISTORY_UID_KEY,
  PROGRAM_DETAILS_RE: () => PROGRAM_DETAILS_RE,
  RUN_DETAIL: () => RUN_DETAIL,
  SESSION_SUMMARY_KEY: () => SESSION_SUMMARY_KEY,
  decodeErrorCodes: () => decodeErrorCodes,
  decodeFavoriteProgram: () => decodeFavoriteProgram,
  decodeHistoryMinutes: () => decodeHistoryMinutes,
  decodeHistoryUids: () => decodeHistoryUids,
  decodeProgramDetails: () => decodeProgramDetails,
  decodeSessionSummary: () => decodeSessionSummary,
  isProgramRecordKey: () => isProgramRecordKey
});
module.exports = __toCommonJS(program_records_exports);
var import_pure_helpers = require("./pure-helpers");
const HISTORY_UID_KEY = "LaundryCare.Common.Status.Program.History.Uid";
const HISTORY_TIME_KEY = "LaundryCare.Common.Status.Program.History.EffectiveTime";
const PROGRAM_DETAILS_RE = /^LaundryCare\.Common\.Status\.Program\.Details\.Program\d+$/;
const SESSION_SUMMARY_KEY = "BSH.Common.Status.ProgramSessionSummary.Latest";
const ERROR_CODES_KEY = "BSH.Common.Status.ErrorCodesList";
const FAVORITE_PROGRAM_RE = /^BSH\.Common\.Setting\.Favorite\.(\d+)\.Program$/;
const RUN_DETAIL = {
  waterMl: 623,
  endTrigger: 626,
  energyWh: 628,
  detergentMl: 8198,
  softenerMl: 8200
};
function isProgramRecordKey(key) {
  return key === HISTORY_UID_KEY || key === HISTORY_TIME_KEY || key === SESSION_SUMMARY_KEY || key === ERROR_CODES_KEY || PROGRAM_DETAILS_RE.test(key) || FAVORITE_PROGRAM_RE.test(key);
}
const DETAILS_MARKER = 15;
const DETAILS_LENGTH = 11;
function base64Bytes(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_\-+/]+={0,2}$/.test(value)) {
    return void 0;
  }
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function u16ListNewestFirst(value) {
  const bytes = base64Bytes(value);
  if (!bytes || bytes.length === 0 || bytes.length % 2 !== 0) {
    return void 0;
  }
  const out = [];
  for (let i = 0; i < bytes.length; i += 2) {
    out.push(bytes.readUInt16BE(i));
  }
  return out.reverse();
}
function decodeHistoryUids(value) {
  return u16ListNewestFirst(value);
}
function decodeHistoryMinutes(value) {
  return u16ListNewestFirst(value);
}
function decodeProgramDetails(value) {
  const bytes = base64Bytes(value);
  if (!bytes || bytes.length !== DETAILS_LENGTH || bytes[0] !== DETAILS_MARKER) {
    return void 0;
  }
  return {
    uid: bytes.readUInt16BE(1),
    completed: bytes.readUInt16BE(3),
    started: bytes.readUInt16BE(5),
    seconds: bytes.readUInt32BE(7)
  };
}
function decodeSessionSummary(value) {
  const parsed = parseJson(value);
  if (!(0, import_pure_helpers.isRecord)(parsed) || typeof parsed.counter !== "number") {
    return void 0;
  }
  const start = typeof parsed.start === "string" ? Date.parse(parsed.start) : NaN;
  const end = typeof parsed.end === "string" ? Date.parse(parsed.end) : NaN;
  const first = Array.isArray(parsed.sequence) ? parsed.sequence[0] : void 0;
  const configuration = (0, import_pure_helpers.isRecord)(first) ? first.configuration : void 0;
  const programUid = (0, import_pure_helpers.isRecord)(configuration) ? configuration.program : void 0;
  if (Number.isNaN(start) || Number.isNaN(end) || typeof programUid !== "number" || !Number.isInteger(programUid)) {
    return void 0;
  }
  const details = {};
  const rawDetails = (0, import_pure_helpers.isRecord)(first) && Array.isArray(first.details) ? first.details : [];
  for (const d of rawDetails) {
    if ((0, import_pure_helpers.isRecord)(d) && typeof d.uid === "number" && typeof d.value === "number") {
      details[d.uid] = d.value;
    }
  }
  return { counter: parsed.counter, start, end, programUid, details };
}
function decodeErrorCodes(value) {
  const raw = parseJson(value);
  const parsed = (0, import_pure_helpers.isRecord)(raw) && Array.isArray(raw.list) ? raw.list : raw;
  if (!Array.isArray(parsed)) {
    return void 0;
  }
  const codes = parsed.map((c) => typeof c === "string" || typeof c === "number" ? String(c).trim() : void 0);
  if (codes.some((c) => c === void 0)) {
    return void 0;
  }
  return codes.filter((c) => c !== void 0 && c.length > 0).join(", ");
}
function decodeFavoriteProgram(value) {
  const parsed = parseJson(value);
  const first = (0, import_pure_helpers.isRecord)(parsed) && Array.isArray(parsed.list) ? parsed.list[0] : void 0;
  const program = (0, import_pure_helpers.isRecord)(first) ? first.program : void 0;
  return typeof program === "number" && Number.isInteger(program) ? program : void 0;
}
function parseJson(value) {
  if (typeof value !== "string") {
    return void 0;
  }
  try {
    return JSON.parse(value);
  } catch {
    return void 0;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ERROR_CODES_KEY,
  FAVORITE_PROGRAM_RE,
  HISTORY_TIME_KEY,
  HISTORY_UID_KEY,
  PROGRAM_DETAILS_RE,
  RUN_DETAIL,
  SESSION_SUMMARY_KEY,
  decodeErrorCodes,
  decodeFavoriteProgram,
  decodeHistoryMinutes,
  decodeHistoryUids,
  decodeProgramDetails,
  decodeSessionSummary,
  isProgramRecordKey
});
//# sourceMappingURL=program-records.js.map
