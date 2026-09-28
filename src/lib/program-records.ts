// Decoders for the program records an appliance reports once the extended
// Home Connect data access is switched on in the developer portal. None of the
// formats is documented; each was read off real appliances (a washer-dryer and a
// dishwasher, 2026-09-27) and checked against their run history, and each
// decoder checks the shape it expects — a value of another shape decodes to
// nothing, never to a guess, and never passes through raw.
//
// - `LaundryCare.Common.Status.Program.History.Uid`: base64url, one 16-bit
//   big-endian program number per run, oldest first.
// - `LaundryCare.Common.Status.Program.History.EffectiveTime`: the same layout,
//   minutes per run.
// - `LaundryCare.Common.Status.Program.Details.ProgramNN`: base64url, 11 bytes:
//   0x0f, program number (u16), runs completed (u16), runs started (u16),
//   running time in seconds (u32) — completed ≤ started on every record measured.
// - `BSH.Common.Status.ProgramSessionSummary.Latest`: JSON — `counter`, `start`,
//   `end` (ISO times), `sequence[0].configuration.program` (the program number) and
//   `sequence[0].details` — the run's own figures by the appliance's feature numbers,
//   the same on every laundry appliance described (WNC254A0BY, WNC25410GB, WG44B2A40,
//   WQ46B2C40; research 2026-09-28): 623 water (ml), 626 end trigger, 628 energy (Wh),
//   630 running time (s), 8198 detergent (ml), 8200 softener (ml) of the last run.
// - `BSH.Common.Status.ErrorCodesList`: JSON list of strings (`contentType:
//   stringList` in the appliances' own descriptions); `[]` = no fault. Locally the same
//   list comes as `{"length":0,"list":[]}` — both forms are read.
// - `BSH.Common.Setting.Favorite.NNN.Program`: `{"length":1,"list":[{"program":8200,
//   "options":[…]}]}` (`contentType: programInstructionList`) — the favourite's program.

import { isRecord } from "./pure-helpers";

/** The history keys of the laundry family. */
export const HISTORY_UID_KEY = "LaundryCare.Common.Status.Program.History.Uid";
export const HISTORY_TIME_KEY = "LaundryCare.Common.Status.Program.History.EffectiveTime";
/** The per-program record family (`…ProgramNN`). */
export const PROGRAM_DETAILS_RE = /^LaundryCare\.Common\.Status\.Program\.Details\.Program\d+$/;
/** The summary of the last finished run. */
export const SESSION_SUMMARY_KEY = "BSH.Common.Status.ProgramSessionSummary.Latest";
/** The appliance's current fault codes. */
export const ERROR_CODES_KEY = "BSH.Common.Status.ErrorCodesList";
/** The program of a favourite slot (`…Favorite.001.Program`). */
export const FAVORITE_PROGRAM_RE = /^BSH\.Common\.Setting\.Favorite\.(\d+)\.Program$/;

/** Feature numbers of the figures a run summary carries about its run. */
export const RUN_DETAIL = {
  waterMl: 623,
  endTrigger: 626,
  energyWh: 628,
  detergentMl: 8198,
  softenerMl: 8200,
} as const;

/**
 * Whether a BSH key is one of the encoded program records — they never become a
 * datapoint of their own; their content is decoded into readable ones.
 *
 * @param key the fully-qualified BSH key
 * @returns whether the key is decoded instead of mapped
 */
export function isProgramRecordKey(key: string): boolean {
  return (
    key === HISTORY_UID_KEY ||
    key === HISTORY_TIME_KEY ||
    key === SESSION_SUMMARY_KEY ||
    key === ERROR_CODES_KEY ||
    PROGRAM_DETAILS_RE.test(key) ||
    FAVORITE_PROGRAM_RE.test(key)
  );
}

/** The first byte of a program details record. */
const DETAILS_MARKER = 0x0f;
/** The byte length of a program details record. */
const DETAILS_LENGTH = 11;

/** One program's lifetime counters. */
export interface ProgramDetails {
  /** The appliance's number for the program. */
  uid: number;
  /** Runs of this program that finished. */
  completed: number;
  /** Runs of this program that were started. */
  started: number;
  /** Total running time of this program in seconds. */
  seconds: number;
}

/** The last finished run. */
export interface SessionSummary {
  /** The appliance's run counter. */
  counter: number;
  /** Start of the run, epoch ms. */
  start: number;
  /** End of the run, epoch ms. */
  end: number;
  /** The appliance's number for the program that ran. */
  programUid: number;
  /** The run's own figures by feature number (see {@link RUN_DETAIL}); numbers only. */
  details: Record<number, number>;
}

/**
 * The bytes of a base64url (or plain base64) value, or undefined when the text is
 * not base64 at all — `Buffer.from` would silently skip foreign characters.
 *
 * @param value the value off the wire
 * @returns the decoded bytes
 */
function base64Bytes(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_\-+/]+={0,2}$/.test(value)) {
    return undefined;
  }
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

/**
 * A list of 16-bit big-endian numbers, newest first (the wire holds oldest first).
 *
 * @param value the base64url value
 * @returns the numbers, or undefined when the value is not such a list
 */
function u16ListNewestFirst(value: unknown): number[] | undefined {
  const bytes = base64Bytes(value);
  if (!bytes || bytes.length === 0 || bytes.length % 2 !== 0) {
    return undefined;
  }
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    out.push(bytes.readUInt16BE(i));
  }
  return out.reverse();
}

/**
 * The program numbers of the last runs, newest first.
 *
 * @param value the `History.Uid` value
 * @returns the program numbers, or undefined for another shape
 */
export function decodeHistoryUids(value: unknown): number[] | undefined {
  return u16ListNewestFirst(value);
}

/**
 * The running times of the last runs in minutes, newest first.
 *
 * @param value the `History.EffectiveTime` value
 * @returns the minutes, or undefined for another shape
 */
export function decodeHistoryMinutes(value: unknown): number[] | undefined {
  return u16ListNewestFirst(value);
}

/**
 * One program's lifetime counters.
 *
 * @param value the `Details.ProgramNN` value
 * @returns the counters, or undefined for another shape
 */
export function decodeProgramDetails(value: unknown): ProgramDetails | undefined {
  const bytes = base64Bytes(value);
  if (!bytes || bytes.length !== DETAILS_LENGTH || bytes[0] !== DETAILS_MARKER) {
    return undefined;
  }
  return {
    uid: bytes.readUInt16BE(1),
    completed: bytes.readUInt16BE(3),
    started: bytes.readUInt16BE(5),
    seconds: bytes.readUInt32BE(7),
  };
}

/**
 * The summary of the last finished run.
 *
 * @param value the `ProgramSessionSummary.Latest` value (JSON text)
 * @returns the summary, or undefined for another shape
 */
export function decodeSessionSummary(value: unknown): SessionSummary | undefined {
  const parsed = parseJson(value);
  if (!isRecord(parsed) || typeof parsed.counter !== "number") {
    return undefined;
  }
  const start = typeof parsed.start === "string" ? Date.parse(parsed.start) : NaN;
  const end = typeof parsed.end === "string" ? Date.parse(parsed.end) : NaN;
  const first = Array.isArray(parsed.sequence) ? parsed.sequence[0] : undefined;
  const configuration = isRecord(first) ? first.configuration : undefined;
  const programUid = isRecord(configuration) ? configuration.program : undefined;
  if (Number.isNaN(start) || Number.isNaN(end) || typeof programUid !== "number" || !Number.isInteger(programUid)) {
    return undefined;
  }
  const details: Record<number, number> = {};
  const rawDetails = isRecord(first) && Array.isArray(first.details) ? first.details : [];
  for (const d of rawDetails) {
    if (isRecord(d) && typeof d.uid === "number" && typeof d.value === "number") {
      details[d.uid] = d.value;
    }
  }
  return { counter: parsed.counter, start, end, programUid, details };
}

/**
 * The appliance's current fault codes as one readable text — "" when there is no fault.
 *
 * @param value the `ErrorCodesList` value (JSON text)
 * @returns the codes joined by ", ", or undefined for another shape
 */
export function decodeErrorCodes(value: unknown): string | undefined {
  const raw = parseJson(value);
  const parsed = isRecord(raw) && Array.isArray(raw.list) ? raw.list : raw;
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const codes = parsed.map(c => (typeof c === "string" || typeof c === "number" ? String(c).trim() : undefined));
  if (codes.some(c => c === undefined)) {
    return undefined;
  }
  return codes.filter(c => c !== undefined && c.length > 0).join(", ");
}

/**
 * The program number a favourite slot holds.
 *
 * @param value the `Favorite.NNN.Program` value (JSON text)
 * @returns the program number, or undefined for another shape
 */
export function decodeFavoriteProgram(value: unknown): number | undefined {
  const parsed = parseJson(value);
  const first = isRecord(parsed) && Array.isArray(parsed.list) ? parsed.list[0] : undefined;
  const program = isRecord(first) ? first.program : undefined;
  return typeof program === "number" && Number.isInteger(program) ? program : undefined;
}

/**
 * JSON text → value, or undefined when it is not JSON.
 *
 * @param value the value off the wire
 * @returns the parsed value
 */
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
