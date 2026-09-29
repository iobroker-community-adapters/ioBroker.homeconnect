// Appliance sync + write routing — extracted from main.ts so the device-tree
// building and the write path are a testable unit (a fake AdapterPort stands in
// for the adapter). main.ts keeps the lifecycle, OAuth, event-stream wiring and
// the REST transport (apiGet/apiWrite, which own the token + 401-refresh);
// ApplianceSync holds the object-tree state and turns BSH data ↔ ioBroker states.

import {
  transformItem,
  expandBshItem,
  isDoorStatusKey,
  transformOptionDefinition,
  shortEnum,
  shortEnumIn,
  stateIdForKey,
  parseConstraints,
  type BshOptionDefinition,
  type NameSource,
  type TransformedState,
} from "./value-transformer";
import { eventKeysForType, LOCKABLE_DOOR_TYPES, PROGRAMLESS_TYPES } from "./device-catalog";
import { deviceIcon } from "./device-icons";
import {
  resolveWrite,
  resolveEnum,
  resolveValue,
  ambiguousCandidates,
  type WriteContext,
  type WriteRequest,
} from "./command-dispatch";
import { isRecord, errMessage, cleanLabel, humanizeId, coerceForType, slugOf } from "./pure-helpers";
import { ID_SCHEME, deviceIdFor, legacyRootOf } from "./device-id";
import {
  copyDeviceTree,
  keepHistoryUnder,
  movedId,
  retargetAliases,
  rewriteMovedObject,
  type DeviceMoveDeps,
} from "./device-move";
import { LEGACY_LEAF, planLegacyCleanup } from "./legacy-cleanup";
import { tName, type I18nKey } from "./i18n";
import { stateText } from "./state-texts";
import { PROGRAM_UIDS } from "./program-uids";
import { isSwitchKey, switchRole, switchState } from "./switch-values";
import { boundShown, presentationFor, RUN_ENERGY, toShown, type Presentation } from "./value-units";
import {
  catalogValues,
  DEFAULT_LABEL_LANGUAGE,
  ownValueLabel,
  programLabels,
  unknownProgramLabel,
  valueLabel,
} from "./value-labels";
import {
  decodeErrorCodes,
  decodeHistoryMinutes,
  decodeHistoryUids,
  decodeProgramDetails,
  decodeFavoriteProgram,
  decodeSessionSummary,
  ERROR_CODES_KEY,
  FAVORITE_PROGRAM_RE,
  HISTORY_TIME_KEY,
  HISTORY_UID_KEY,
  isProgramRecordKey,
  PROGRAM_DETAILS_RE,
  RUN_DETAIL,
  SESSION_SUMMARY_KEY,
  type ProgramDetails,
  type SessionSummary,
} from "./program-records";
import { isDeviceInternalKey } from "./device-internal";
import { runSegment } from "./run-ordinal";
import type { SseEvent } from "./sse-parser";
import type { JsonResult } from "./http";

/** The slice of the adapter ApplianceSync needs — injected so it can be faked in tests. */
export interface AdapterPort {
  /** The adapter namespace, e.g. "homeconnect.0". */
  readonly namespace: string;
  /** The adapter logger. */
  readonly log: ioBroker.Logger;
  /** The ioBroker system language — the language of every value label the adapter writes. */
  readonly language?: string;
  /** Create/extend an object (idempotent). */
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<unknown>;
  /** Set a state value. */
  setState(id: string, state: ioBroker.SettableState): Promise<unknown>;
  /** Set a state value only if it changed. */
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<unknown>;
  /** Read a state. */
  getState(id: string): Promise<ioBroker.State | null | undefined>;
  /** Read an object. */
  getObject(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Delete an object (leaf state). */
  delObject(id: string): Promise<void>;
  /** Delete an object and everything below it (a whole appliance tree). */
  delObjectRecursive(id: string): Promise<void>;
  /** Enumerate this instance's objects of a type (for start-up priming and tree moves). */
  getForeignObjects(pattern: string, type: "state" | "device" | "channel"): Promise<Record<string, ioBroker.Object>>;
  /** Every object of this instance, of every type, keyed by full id — a tree move copies them all. */
  getAdapterObjects(): Promise<Record<string, ioBroker.Object | null | undefined>>;
  /** Every state matching a full-id pattern — a tree move carries them with `ack`, `ts`, `lc` and `q`. */
  getForeignStates(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** Write an object whole, by full id — also outside the namespace (an alias). */
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown>;
  /** Merge into an object, by full id. */
  extendForeignObject(id: string, patch: ioBroker.PartialObject): Promise<unknown>;
  /** Write a state, by full id. */
  setForeignState(id: string, state: ioBroker.SettableState): Promise<unknown>;
  /** Every alias state object (`alias.*`). */
  getAliases(): Promise<Record<string, ioBroker.Object | null | undefined>>;
  /** Every room and function (`enum.*`) — to see which objects of a tree are assigned. */
  getEnums(): Promise<Record<string, unknown>>;
  /**
   * Delete a whole tree (namespace-relative root) and carry the room and function assignments of
   * its objects to the ids that take their place — through the fleet helper `moveWithEnums`, which
   * reads the assignments before the delete and writes them after it.
   *
   * @returns how many room/function entries now list one of the new ids
   */
  deleteTreeCarryingEnums(root: string, carry: ReadonlyMap<string, readonly string[]>): Promise<number>;
  /**
   * GET a Home Connect resource (token + 401-refresh handled by main).
   * `null` = the appliance answered that there is none (no program selected /
   * active); `undefined` = nothing is known (failure, rate pause, busy appliance).
   */
  apiGet(path: string): Promise<unknown>;
  /** Send a Home Connect write (token + 401-refresh handled by main). */
  apiWrite(req: WriteRequest): Promise<JsonResult | undefined>;
  /** Arm a managed timeout (the adapter's `setTimeout`, never the native one). */
  setTimer(cb: () => void, ms: number): unknown;
  /** Cancel a timeout armed through {@link setTimer}. */
  clearTimer(handle: unknown): void;
}

/** The BSH parts of a state's `native`: key, write candidates, and the values its list keeps. */
interface BshNative {
  bshKey?: string;
  bshValues?: string[];
  seenValues?: string[];
  /** On an option object: the definition-cache generation that last built its list (see PROGRAM_DEF_GENERATION). */
  defGeneration?: number;
}

/** What a known state carries: its BSH key + candidate values (for the write-back resolve). */
interface KnownState {
  bshKey?: string;
  bshValues?: string[];
  /** Signature of the object parts we own — a REST re-sync refreshes the object when it changes. */
  metaSig?: string;
  /** The declared `common.type` — a user write is brought into it before it is sent. */
  type?: ioBroker.CommonType;
  /** The display name as it stands in the DB — the adapter's, always (it owns its datapoints). */
  name?: ioBroker.StringOrTranslated;
  /** Where the current name came from — an "api" name is never downgraded to a "derived" one. */
  nameSource?: NameSource;
  /** The explanation as it stands in the DB — the adapter owns it, so a changed text is written. */
  desc?: ioBroker.StringOrTranslated;
  /** Whether `common.states` / `native.bshValues` are present — both must be cleared before a refresh. */
  hasStates?: boolean;
  hasValues?: boolean;
  /**
   * Values this datapoint carried that its list did not name (`native.seenValues`,
   * append-only): handed to every transform, so the list keeps them.
   */
  seenValues?: string[];
  /**
   * On an option object: the definition-cache generation that built its list (`native.defGeneration`). Below
   * the current one, the next definition that loads rebuilds the list instead of adding to it.
   */
  defGeneration?: number;
}

/** The last decoded program records of one appliance. */
interface DeviceRecords {
  /** Program numbers of the last runs, newest first. */
  uids?: number[];
  /** Running minutes of the last runs, newest first. */
  minutes?: number[];
  /** Lifetime counters per program number. */
  details: Map<number, ProgramDetails>;
  /** The last finished run. */
  summary?: SessionSummary;
}

/** Names of the first history slots (the rest count on with a number). */
const HISTORY_PROGRAM_NAMES: readonly I18nKey[] = ["histProgram1", "histProgram2", "histProgram3", "histProgram4"];
const HISTORY_DURATION_NAMES: readonly I18nKey[] = ["histDuration1", "histDuration2", "histDuration3", "histDuration4"];
const HISTORY_RUN_NAMES: readonly I18nKey[] = ["histRun1", "histRun2", "histRun3", "histRun4"];
/** An old history datapoint that counted the runs (`history.program3`), before decision 48. */
const NUMBERED_HISTORY = /^([^.]+)\.history\.(program|duration)(\d+)$/;

/**
 * Two names joined per language ("Spin · Runs completed"), for a datapoint whose
 * name must say which of several siblings it is.
 *
 * @param first the leading name (a translation object or plain text)
 * @param second the trailing name
 * @returns the joined translation object
 */
function joinNames(first: ioBroker.StringOrTranslated, second: ioBroker.StringOrTranslated): ioBroker.Translated {
  const pick = (n: ioBroker.StringOrTranslated, lang: string): string =>
    typeof n === "string" ? n : ((n as Record<string, string>)[lang] ?? n.en);
  const langs = new Set([
    "en",
    ...(typeof first === "string" ? [] : Object.keys(first)),
    ...(typeof second === "string" ? [] : Object.keys(second)),
  ]);
  const out: Record<string, string> = {};
  for (const lang of langs) {
    out[lang] = `${pick(first, lang)} · ${pick(second, lang)}`;
  }
  return out as ioBroker.Translated;
}

/**
 * `BSH.Common.Status.ProgramRunDetail.EndTrigger` by its number — the order of the
 * appliances' own description (device-dumps-2026-09-07, `devices.json`, uid 626).
 */
const END_TRIGGERS = [
  "ProgramFinished",
  "ProgramAbortedByUser",
  "ProgramAbortedByAppliance",
  "ProgramAbortedByApplianceCriticalError",
] as const;

/** How far the program seen running may lie outside a run's reported start and end (clock skew). */
const RUN_PAIRING_TOLERANCE_MS = 60_000;

/**
 * One cached program definition: the option state ids it declares, plus the
 * adapter generation that fetched it. An entry from an older generation is
 * fetched once more, because the objects it created back then miss what the
 * current version puts on them (the cloud's localized option name).
 */
interface ProgramDef {
  ids: string[];
  /**
   * Option state id → the BSH key THIS program uses for it. Two appliance
   * families can name the same option differently (`LaundryCare.Dryer.Option.
   * DryingTarget` / `LaundryCare.WasherDryer.Option.DryingTarget`), and both land
   * on one state id; a write must go out with the key of the selected program.
   */
  keys?: Record<string, string>;
  v: number;
}

/**
 * How long a definition read that was REFUSED for good (a 4xx that is no
 * appliance state) waits before it is asked again. Such a definition otherwise
 * cost one request on every reconnect, with no end.
 */
const FAILED_DEF_RETRY_MS = 6 * 60 * 60_000;

/**
 * The current definition-cache generation — raise it when option objects or the
 * cache gain a field. 3: the per-program option keys (`keys`). 4: the option
 * value labels from the own table in the system language (decision 41) — an
 * option object is written only when its program's definition loads, so without
 * the raise an existing installation kept its old labels for good. An option
 * object carries the generation that built its list (`native.defGeneration`):
 * the first definition of a newer generation rebuilds the list from scratch, the
 * following ones add to it — a list only ever grew before, so no update could
 * take a value out that no program offers. 5: options in the shown unit and on/off
 * options as switches (decision 47) — without the raise the union kept bounds in
 * seconds next to bounds in minutes (max(86400, 1440)).
 */
const PROGRAM_DEF_GENERATION = 5;

/**
 * The candidates of one option that belong to the value family of its key:
 * `LaundryCare.WasherDryer.Option.DryingTarget` takes the `LaundryCare.WasherDryer.…`
 * values of a union that also holds the `LaundryCare.Dryer.…` ones. A key without
 * a recognisable domain, or no candidate of that domain, keeps the whole list.
 *
 * @param values the option's union of allowed values
 * @param key the BSH key the write goes out with
 * @returns the family's candidates
 */
function familyOf(values: string[] | undefined, key: string | undefined): string[] | undefined {
  if (!values || values.length === 0 || !key) {
    return values;
  }
  const cut = key.indexOf(".Option.");
  if (cut < 0) {
    return values;
  }
  const domain = key.slice(0, cut + 1);
  const own = values.filter(v => v.startsWith(domain));
  return own.length > 0 ? own : values;
}

/**
 * The value a successful write is confirmed with — the datapoint's own form.
 *
 * @param channel the state's channel
 * @param stateId the within-channel id
 * @param req the request that went out
 * @param bshValues the datapoint's candidate values (enums only)
 * @param written the value as written (already type-coerced)
 * @returns the value to confirm
 */
function confirmedValue(
  channel: string,
  stateId: string,
  req: WriteRequest,
  bshValues: string[] | undefined,
  written: ioBroker.StateValue,
): ioBroker.StateValue {
  // A switch confirms its own true/false — the appliance got On or Off, the datapoint stays a boolean.
  if (!bshValues || bshValues.length === 0 || typeof written === "boolean") {
    return written;
  }
  if (channel === "programs" && stateId === "selectedProgram") {
    return typeof req.body?.key === "string" ? shortEnumIn(req.body.key, bshValues) : written;
  }
  const sent = req.body?.value;
  if (typeof sent !== "string") {
    return written;
  }
  // Options share one short value across value families (see familyOf).
  return channel === "options" ? shortEnum(sent) : shortEnumIn(sent, bshValues);
}

/**
 * Delays of the re-reads after an appliance answered that its connection is
 * still initializing — one per attempt, then the adapter waits for the next
 * reconnect. An appliance that was just switched on sends CONNECTED before it
 * can answer; measured live (2026-09-18/20/23) it was ready 52 s to 2.5 min later,
 * and nothing but a second online edge ever read it again. Worst case: three
 * requests over 3.5 minutes.
 */
const NOT_READY_RETRY_MS = [30_000, 60_000, 120_000] as const;

/**
 * The static half of one setting's definition — everything the settings LIST does
 * not carry. `GET /settings` answers `{key, name, value, unit}`; the type, the
 * allowed values and the numeric bounds live only in `GET /settings/{key}`
 * (measured at a live installation on 2026-09-12: all 17 settings datapoints had
 * a unit but no min/max/step, and each writable enum listed exactly one candidate
 * value — its own current one, which made switching it impossible).
 *
 * Only the static fields are cached: the VALUE always comes from the list, so a
 * restart never serves a stale reading.
 */
interface SettingDef {
  constraints?: Record<string, unknown>;
  type?: string;
}

/** The BSH key carrying the program that is selected on the appliance right now. */
const SELECTED_PROGRAM_KEY = "BSH.Common.Root.SelectedProgram";
/** The operation state: whether a program is under way. */
const OPERATION_STATE_KEY = "BSH.Common.Status.OperationState";
/**
 * The operation states in which a program is under way. Outside them the appliance's remaining time and
 * progress are left over from the last run (a washer-dryer at rest: 1 min, 100 %) — Home Assistant empties
 * both there too ("Otherwise, some sensors report erroneous values", `sensor.py`), decision 48.
 */
const PROGRAM_UNDER_WAY = new Set(["delayedstart", "run", "pause", "finished"]);
/** The options that only mean something while a program is under way. */
const RUN_VALUE_KEYS: ReadonlyMap<string, string> = new Map([
  ["BSH.Common.Option.RemainingProgramTime", "options.remainingProgramTime"],
  ["BSH.Common.Option.ProgramProgress", "options.programProgress"],
]);
const ACTIVE_PROGRAM_KEY = "BSH.Common.Root.ActiveProgram";

/** The translated channel names — the adapter's own structure, not cloud text. */
const CHANNEL_KEYS: Record<string, I18nKey> = {
  info: "channelInfo",
  status: "channelStatus",
  settings: "channelSettings",
  events: "channelEvents",
  programs: "channelPrograms",
  options: "channelOptions",
  commands: "channelCommands",
  history: "channelHistory",
  lastRun: "channelLastRun",
};

/**
 * The display name of a channel object: a translation object for the known
 * channels, a readable label for anything else (the `misc` fallback).
 *
 * @param channel the channel id
 * @returns the name to store
 */
function channelName(channel: string): ioBroker.StringOrTranslated {
  const key = CHANNEL_KEYS[channel];
  return key ? tName(key) : humanizeId(channel);
}

/**
 * Whether two `common.name` values are the same label (string or translation object).
 *
 * @param a first name
 * @param b second name
 * @returns whether they render identically
 */
function sameName(a: ioBroker.StringOrTranslated | undefined, b: ioBroker.StringOrTranslated | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
}

/**
 * The `native` field that remembers where a state's name came from, read back
 * at priming (so a derived label never replaces a cloud name after a restart).
 *
 * @param native a state object's native
 * @returns the name source, when stored
 */
function storedNameSource(native: Record<string, unknown>): NameSource | undefined {
  const source = native.nameSource;
  return source === "api" || source === "derived" || source === "i18n" ? source : undefined;
}

/**
 * A cloud string as the adapter stores it in a device object's native: the
 * string itself, or nothing — never an object the cloud might send one day.
 *
 * @param v the value off the wire
 * @returns the string, or undefined
 */
function stringOrUndef(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * The form an older version stored a datapoint in, when it is not the current one: an on/off text (the key is a switch
 * now) or a number in the appliance's unit (the key shows another unit now).
 *
 * @param key the stored BSH key
 * @param common the stored `common`
 * @param rel the namespace-relative state id (the run summary's datapoints carry no key)
 * @returns what changes, or undefined when the stored form is the current one
 */
function storedForm(
  key: string | undefined,
  common: Partial<ioBroker.StateCommon>,
  rel: string,
): { kind: "switch" } | { kind: "unit"; p: Presentation } | undefined {
  if (rel.endsWith(".lastRun.energy") && common.type === "number" && RUN_ENERGY.from.includes(common.unit ?? "")) {
    return { kind: "unit", p: RUN_ENERGY };
  }
  if (key === undefined) {
    return undefined;
  }
  if (common.type === "string" && isSwitchKey(key)) {
    return { kind: "switch" };
  }
  const p = common.type === "number" ? presentationFor(key, common.unit) : undefined;
  return p ? { kind: "unit", p } : undefined;
}

/**
 * The unit, bounds and step of a stored number in its shown unit.
 *
 * @param common the stored `common`
 * @param p the presentation
 * @returns the fields to write
 */
function shownBounds(common: Partial<ioBroker.StateCommon>, p: Presentation): Partial<ioBroker.StateCommon> {
  const patch: Partial<ioBroker.StateCommon> = { unit: p.unit };
  if (typeof common.min === "number") {
    patch.min = boundShown(common.min, p, "min");
  }
  if (typeof common.max === "number") {
    patch.max = boundShown(common.max, p, "max");
  }
  if (typeof common.step === "number") {
    patch.step = boundShown(common.step, p, "step");
  }
  return patch;
}

/** The `common` fields the transformer owns. `name` is handled by the label refresh, not the signature. */
const OWNED_COMMON_KEYS = ["type", "role", "read", "write", "unit", "min", "max", "step", "states", "def"] as const;

/**
 * Deterministic signature of the object parts the adapter owns (the transformer's
 * `common` fields minus `name`, plus the BSH native data). Computed both from a
 * fresh transform and from a DB object at priming, so an unchanged object never
 * gets rewritten — and a changed one (new allowed values, changed bounds, improved
 * transform in a new adapter version) is detected and refreshed exactly once.
 *
 * @param common the state's `common` (fresh from the transformer, or from the DB)
 * @param native the BSH parts of the state's `native`
 * @param native.bshKey the fully-qualified BSH key
 * @param native.bshValues the full BSH candidate values of a writable enum
 * @returns a stable string signature
 */
function metaSignature(common: Partial<ioBroker.StateCommon>, native: BshNative): string {
  const c = common as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const key of OWNED_COMMON_KEYS) {
    const v = key === "states" && c[key] !== null && typeof c[key] === "object" ? sortedRecord(c[key]) : c[key];
    if (v !== undefined) {
      picked[key] = v;
    }
  }
  return JSON.stringify({ c: picked, k: native.bshKey, v: native.bshValues });
}

/**
 * A key-sorted shallow copy, so the signature does not depend on insertion order.
 *
 * @param v the record to sort (already checked to be a non-null object)
 * @returns the same entries in sorted key order
 */
function sortedRecord(v: unknown): Record<string, unknown> {
  const rec = v as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(rec)
      .sort()
      .map(k => [k, rec[k]]),
  );
}

/**
 * The API path for one appliance (or one of its sub-resources), with the
 * cloud-provided id safely encoded — one place instead of six template strings.
 *
 * @param haId the appliance's haId
 * @param subpath the sub-resource, e.g. "/settings" (already-encoded where dynamic)
 * @returns the request path
 */
function appliancePath(haId: string, subpath = ""): string {
  return `/api/homeappliances/${encodeURIComponent(haId)}${subpath}`;
}

/**
 * The reverse of {@link appliancePath}: split a request path into the haId and
 * the rest. The transport reports classified appliance answers by path; this is
 * how the sync finds out which appliance (and which program) one was about.
 *
 * @param path a request path, e.g. "/api/homeappliances/<haId>/status"
 * @returns the decoded haId and the sub-path, or undefined for any other path
 */
export function parseAppliancePath(path: string): { haId: string; subpath: string } | undefined {
  const match = /^\/api\/homeappliances\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) {
    return undefined;
  }
  const [, rawHaId, subpath = ""] = match;
  try {
    return { haId: decodeURIComponent(rawHaId), subpath };
  } catch {
    // A malformed escape cannot be an haId this adapter built.
    return undefined;
  }
}

/**
 * The name an appliance is shown by when the app gives none: its E-number, else its model code.
 *
 * @param a the appliance record
 * @returns the fallback name, or undefined
 */
function fallbackName(a: Record<string, unknown>): string | undefined {
  for (const field of [a.enumber, a.vib]) {
    if (typeof field === "string" && field.trim().length > 0) {
      return field;
    }
  }
  return undefined;
}

/** Builds + updates the appliance object tree and routes writes back to the Home Connect API. */
export class ApplianceSync {
  /** haId → device id (model + number, see device-id.ts), for routing stream events. */
  private readonly deviceIdByHaId = new Map<string, string>();
  /** device id → haId, for routing writes back to the appliance. */
  private readonly haIdByDeviceId = new Map<string, string>();
  /** Namespace-relative state id → its BSH key + candidate values; also gates object creation. */
  private readonly knownStates = new Map<string, KnownState>();
  /** device id → the option ids from the selected program's definition (writable, sent on start). */
  private readonly optionKeys = new Map<string, Set<string>>();
  /** device ids with an in-flight data sync — serialises concurrent CONNECTED/re-sync events. */
  private readonly syncing = new Set<string>();
  /**
   * device ids that reconnected WHILE their pass was running: that pass may have
   * read the appliance before the reconnect, so one more pass follows it. A
   * CONNECTED dropped by the serialisation left the appliance unread until its
   * next reconnect or the hourly outage re-read.
   */
  private readonly resyncPending = new Set<string>();
  /** device id → epoch-ms the running (or last) data pass started. */
  private readonly passStartedAt = new Map<string, number>();
  /**
   * `deviceId|bshKey` → epoch-ms the stream last delivered that key. A REST read
   * issued before the stream's newer value must not overwrite it.
   */
  private readonly lastStreamAt = new Map<string, number>();
  /** device id → its last written reachable value, the single source for the instance summary. */
  private readonly reachableByDeviceId = new Map<string, boolean>();
  /** device id → its appliance type ("WasherDryer", …) — drives the catalog (events, door form, programs). */
  private readonly typeByDeviceId = new Map<string, string>();
  /** device id → the appliance's display name (from the app) — for readable log lines. */
  private readonly nameByDeviceId = new Map<string, string>();
  /**
   * device id → program key → its option state ids. The definition cache: each
   * program definition is fetched ONCE, then remembered here and persisted in the
   * device object's native (an internal attribute, not a datapoint) — so a program
   * change or re-sync costs no definition request at all, which keeps the daily
   * request budget untouched and sidesteps the "wrong operation state" refusal
   * while a program runs.
   */
  private readonly programDefs = new Map<string, Record<string, ProgramDef>>();
  /**
   * haId → program keys Home Connect refuses to describe (`UnsupportedProgram`):
   * programs chosen at the appliance that the API does not offer. Remembered for
   * this run only — every turn of the dial to one of them cost a definition
   * request (measured live 2026-09-16 → 2026-09-22), and a firmware update may
   * make one supported, so a restart asks once more.
   */
  private readonly unsupportedPrograms = new Map<string, Set<string>>();
  /** device ids whose running pass met "connection still initializing" — the pass stops there. */
  private readonly notReady = new Set<string>();
  /** Request paths the transport just reported as refused for good (a 4xx that is no appliance state). */
  private readonly refusedPaths = new Set<string>();
  /**
   * `deviceId|definition key` → epoch-ms a definition read was REFUSED for good.
   * Without it such a definition cost one request on every CONNECTED, with no
   * end. A transient failure (5xx, network, rate limit) is not booked: it is
   * asked again next time, or a short outage would leave a program's options
   * unwritable for hours.
   */
  private readonly failedDefs = new Map<string, number>();
  /** device id → the armed re-read after "not ready" (at most one per appliance). */
  private readonly retryTimers = new Map<string, unknown>();
  /** device id → how many "not ready" re-reads were armed since the last full read. */
  private readonly retryAttempts = new Map<string, number>();
  /**
   * device id → setting key → its static definition, persisted in the device
   * object's native. Fetched once per setting per appliance; every later start
   * and re-sync costs nothing. No generation counter: this cache is new, so it
   * cannot hold anything written by an older version — one gets added if a future
   * transform change ever needs a forced refresh, with the reason.
   */
  private readonly settingDefs = new Map<string, Record<string, SettingDef>>();
  /**
   * device id → the appliance's program number → the full program key. The
   * numbers are the appliance family's own (cotton is 28673 on a washer and 31495
   * on a washer-dryer), so they are learned per appliance and kept in the device
   * object's `native.programUids`.
   */
  private readonly programUids = new Map<string, Record<string, string>>();
  /** device id → the program seen running, and since when (epoch ms) — what a run summary is paired with. */
  private readonly runningProgram = new Map<string, { key: string; since: number }>();
  /** device id → the last decoded program records, drawn again when a program number is learned. */
  private readonly records = new Map<string, DeviceRecords>();
  /** `deviceId|key` of every record that arrived in a shape the adapter cannot read — reported once a run. */
  private readonly unreadableRecords = new Set<string>();
  /** Channel paths written this run — a channel object is written once, not per datapoint. */
  private readonly writtenChannels = new Set<string>();
  /** device ids whose `statistics` folder was written this run — once, not per record. */
  private readonly statisticsFolders = new Set<string>();
  /** Appliances whose last operation state says no program is under way (decision 48). */
  private readonly atRest = new Set<string>();
  /** Appliances whose `history` folder was written in this run. */
  private readonly historyFolders = new Set<string>();
  /** Appliances whose setting cache has unsaved entries — persisted once per sync, not per setting. */
  private readonly settingDefsDirty = new Set<string>();
  /**
   * While a pass walks several appliances, the three `info.devices*` sums are
   * flushed once at its END instead of after every appliance. On a fresh tree the
   * per-appliance flush published values that never held: with the first (online)
   * appliance known, "all connected" was true — then false as the second, offline
   * one arrived. A value that was never true must not reach a subscriber.
   *
   * The derivation itself stays in `setReachable` (decision 11: one counting
   * place, a second one would drift).
   */
  private rollupBatched = false;
  /**
   * Set by {@link stop}: the adapter is shutting down. A sync pass that is in
   * flight when onUnload runs used to keep going — it marked appliances online
   * and created objects AFTER `markAllUnreachable` had run, so a stopped
   * adapter left half its appliances green (measured 2026-09-15: two of four).
   */
  private stopped = false;
  /**
   * device id → signature of the device object as it stands in the database.
   * Primed from the stored object, so a start that changes nothing writes nothing
   * (decision 18: after the one-off repair no start writes an object any more).
   */
  private readonly deviceObjSig = new Map<string, string>();
  /**
   * device id → the full program key the write gate is currently armed for. The
   * gate itself only holds option ids, which cannot say WHICH program they came
   * from — so a selection arriving over the stream had no way to notice that the
   * gate belongs to a different program. Keeping the key here makes
   * {@link activateProgramOptions} idempotent (a repeated NOTIFY with the same
   * program costs nothing) and lets a genuine change re-arm it.
   */
  private readonly armedProgramByDeviceId = new Map<string, string>();
  /**
   * device ids decided under the current rule ({@link ID_SCHEME}) — their device object carries the
   * mark. A tree without it still has an older id; the sync must not stamp one on it.
   */
  private readonly idDecided = new Set<string>();
  /**
   * Roots of the previous adapter generation (community 1.6.x) that wait for their appliance: they
   * are adopted — recordings, rooms, functions and aliases carried to the new datapoints — once the
   * appliance list has created the new tree ({@link adoptLegacyTrees}). No tree pass touches them.
   */
  private readonly pendingLegacyRoots = new Set<string>();

  /**
   * @param port the injected adapter capabilities
   */
  constructor(private readonly port: AdapterPort) {}

  /**
   * Stop all further tree work: no appliance is marked online, no item is
   * applied, no stream event is routed from now on. Called by onUnload BEFORE
   * `markAllUnreachable` — the offline stamp itself (`setReachable(false)`) stays
   * allowed, it is the shutdown write of decision 9.
   */
  stop(): void {
    this.stopped = true;
    for (const deviceId of [...this.retryTimers.keys()]) {
      this.cancelNotReadyRetry(deviceId);
    }
  }

  /**
   * The transport's report that an appliance answered "connection still
   * initializing" (`SDK.Error.HomeAppliance.Connection.Initialization.Failed`) —
   * its running pass stops after the current step and a re-read is armed.
   *
   * @param path the request path the answer came for
   */
  noteNotReady(path: string): void {
    const parsed = parseAppliancePath(path);
    const deviceId = parsed ? this.deviceIdByHaId.get(parsed.haId) : undefined;
    if (deviceId) {
      this.notReady.add(deviceId);
    }
  }

  /**
   * The transport's report that a read was refused for good — a 4xx that is
   * neither an appliance state (busy, none, not ready, unsupported) nor a login
   * or rate problem. Asking again changes nothing.
   *
   * @param path the request path the answer came for
   */
  noteRefused(path: string): void {
    this.refusedPaths.add(path);
  }

  /**
   * Whether a definition read may go out: not while its last failure is younger
   * than {@link FAILED_DEF_RETRY_MS}.
   *
   * @param deviceId the id-safe device path segment
   * @param key the setting or program key
   * @returns whether to fetch it now
   */
  private mayFetchDef(deviceId: string, key: string): boolean {
    const failedAt = this.failedDefs.get(`${deviceId}|${key}`);
    return failedAt === undefined || Date.now() - failedAt >= FAILED_DEF_RETRY_MS;
  }

  /**
   * Book a definition read that brought nothing: only a refusal for good waits
   * {@link FAILED_DEF_RETRY_MS}; everything else is asked again next time.
   *
   * @param deviceId the id-safe device path segment
   * @param key the setting or program key
   * @param path the request path
   */
  private noteDefMiss(deviceId: string, key: string, path: string): void {
    if (this.refusedPaths.delete(path)) {
      this.failedDefs.set(`${deviceId}|${key}`, Date.now());
    }
  }

  /**
   * The transport's report that Home Connect refused to describe a program
   * (`SDK.Error.UnsupportedProgram` on `…/programs/available/{key}`) — remember
   * it, so the next selection of that program costs no request.
   *
   * @param path the request path the answer came for
   */
  noteUnsupportedProgram(path: string): void {
    const parsed = parseAppliancePath(path);
    const prefix = "/programs/available/";
    if (!parsed?.subpath.startsWith(prefix)) {
      return;
    }
    let programKey: string;
    try {
      programKey = decodeURIComponent(parsed.subpath.slice(prefix.length));
    } catch {
      return;
    }
    let refused = this.unsupportedPrograms.get(parsed.haId);
    if (!refused) {
      refused = new Set();
      this.unsupportedPrograms.set(parsed.haId, refused);
    }
    refused.add(programKey);
  }

  /**
   * Strip the instance namespace off a full id (`homeconnect.0.dev.channel.state`
   * → `dev.channel.state`). Ids that already are relative pass through.
   *
   * @param fullId a full or relative id
   * @returns the id relative to the instance
   */
  private relId(fullId: string): string {
    const prefix = `${this.port.namespace}.`;
    return fullId.startsWith(prefix) ? fullId.slice(prefix.length) : fullId;
  }

  /**
   * The log label for a device: `Name (id)` — the name for the human, the id to
   * find the folder in the tree (fleet convention, mirrors govee's deviceLabel).
   *
   * @param deviceId the id-safe device path segment
   * @returns the label, or just the id when no distinct name is known
   */
  private label(deviceId: string): string {
    const name = this.nameByDeviceId.get(deviceId)?.trim() ?? "";
    return name.length > 0 && name !== deviceId ? `${name} (${deviceId})` : deviceId;
  }

  /**
   * Prime the in-memory maps from the objects already in the DB, so writes work
   * for an appliance that is offline at start (its objects exist from a previous
   * run but no REST re-sync populated the maps this run). Covers all four write
   * readers: knownStates + optionKeys + the deviceId↔haId maps.
   */
  async primeFromObjects(): Promise<void> {
    try {
      // Device objects carry the haId in native — without the deviceId↔haId maps
      // the write path can't resolve a target, so this must run before the state pass.
      const devices = await this.port.getForeignObjects(`${this.port.namespace}.*`, "device");
      const haIdOf = (obj: ioBroker.Object | undefined): unknown =>
        (obj?.native as { haId?: unknown } | undefined)?.haId;
      for (const [fullId, obj] of Object.entries(devices)) {
        const deviceId = this.relId(fullId);
        const native = (obj.native ?? {}) as {
          haId?: unknown;
          type?: unknown;
          programOptions?: unknown;
          programUids?: unknown;
          settingDefs?: unknown;
          idScheme?: unknown;
          movingTo?: unknown;
        };
        // A move that did not finish leaves the old tree with its journal next to the new one. The
        // appliance lives in the new tree once that exists — the old one is only waiting for the
        // next start to finish the move. Without a new tree the run goes on under the old id.
        const moving =
          typeof native.movingTo === "string" &&
          haIdOf(devices[`${this.port.namespace}.${native.movingTo}`]) === native.haId;
        if (deviceId.length > 0 && !deviceId.includes(".") && typeof native.haId === "string" && !moving) {
          this.deviceIdByHaId.set(native.haId, deviceId);
          this.haIdByDeviceId.set(deviceId, native.haId);
          const idScheme = native.idScheme === ID_SCHEME ? ID_SCHEME : undefined;
          if (idScheme) {
            this.idDecided.add(deviceId);
          }
          if (typeof native.type === "string") {
            this.typeByDeviceId.set(deviceId, native.type);
          }
          if (typeof obj.common?.name === "string") {
            this.nameByDeviceId.set(deviceId, obj.common.name);
            // Signature of the STORED object, formed through the same builder as
            // the sync's — so an unchanged appliance costs no object write at all,
            // not even one per start.
            this.deviceObjSig.set(
              deviceId,
              JSON.stringify(
                this.deviceObject(
                  deviceId,
                  obj.common.name,
                  {
                    haId: native.haId,
                    type: stringOrUndef(native.type),
                    brand: stringOrUndef((native as { brand?: unknown }).brand),
                    vib: stringOrUndef((native as { vib?: unknown }).vib),
                    enumber: stringOrUndef((native as { enumber?: unknown }).enumber),
                    idScheme,
                  },
                  // The icon AS STORED, not the one the map would give: an object
                  // written before the adapter had pictograms carries none, and
                  // that difference is exactly what makes the sync write it once.
                  stringOrUndef(obj.common.icon),
                ),
              ),
            );
          }
          // Restore the persisted definition cache — across restarts no program
          // definition is ever fetched again unless a new program appears.
          if (isRecord(native.programOptions)) {
            const defs: Record<string, ProgramDef> = {};
            for (const [program, entry] of Object.entries(native.programOptions)) {
              // A bare array is the pre-generation shape (v1): kept, so the write
              // gate stays armed, but re-fetched once for the newer object fields.
              const ids = Array.isArray(entry)
                ? entry
                : isRecord(entry) && Array.isArray(entry.ids)
                  ? entry.ids
                  : undefined;
              if (ids) {
                const v = isRecord(entry) && typeof entry.v === "number" ? entry.v : 1;
                const keys =
                  isRecord(entry) && isRecord(entry.keys)
                    ? Object.fromEntries(
                        Object.entries(entry.keys).filter((kv): kv is [string, string] => typeof kv[1] === "string"),
                      )
                    : undefined;
                defs[program] = {
                  ids: ids.filter((id): id is string => typeof id === "string"),
                  v,
                  ...(keys ? { keys } : {}),
                };
              }
            }
            this.programDefs.set(deviceId, defs);
          }
          if (isRecord(native.programUids)) {
            this.programUids.set(
              deviceId,
              Object.fromEntries(
                Object.entries(native.programUids).filter((kv): kv is [string, string] => typeof kv[1] === "string"),
              ),
            );
          }
          // Same for the setting definitions: restored here, so a restart fetches
          // no single-setting endpoint again.
          if (isRecord(native.settingDefs)) {
            const defs: Record<string, SettingDef> = {};
            for (const [key, entry] of Object.entries(native.settingDefs)) {
              if (isRecord(entry)) {
                defs[key] = {
                  constraints: isRecord(entry.constraints) ? entry.constraints : undefined,
                  type: typeof entry.type === "string" ? entry.type : undefined,
                };
              }
            }
            this.settingDefs.set(deviceId, defs);
          }
        }
      }
    } catch (e) {
      this.port.log.debug(`priming devices from objects failed: ${errMessage(e)}`);
    }
    /** Every text datapoint of a BSH key: its stored `common` and what is known about it, for the list repair. */
    const storedLists = new Map<string, { common: Partial<ioBroker.StateCommon>; known: KnownState }>();
    /** Every datapoint an older version stored in another form: an on/off text, a number in the appliance's unit. */
    const oldForms = new Map<string, { common: Partial<ioBroker.StateCommon>; known: KnownState }>();
    try {
      const objects = await this.port.getForeignObjects(`${this.port.namespace}.*`, "state");
      for (const [fullId, obj] of Object.entries(objects)) {
        const rel = this.relId(fullId);
        if (!this.haIdByDeviceId.has(rel.split(".")[0] ?? "")) {
          // Not an appliance tree of this run: the instance's own states, a tree of the previous
          // adapter generation waiting to be adopted, or the old half of an unfinished move.
          continue;
        }
        const native = (obj.native ?? {}) as Record<string, unknown>;
        const bshKey = typeof native.bshKey === "string" ? native.bshKey : undefined;
        const bshValues = Array.isArray(native.bshValues)
          ? native.bshValues.filter((v): v is string => typeof v === "string")
          : undefined;
        const seenValues = Array.isArray(native.seenValues)
          ? native.seenValues.filter((v): v is string => typeof v === "string")
          : undefined;
        const defGeneration = typeof native.defGeneration === "number" ? native.defGeneration : undefined;
        // The pattern is type-filtered to states, so common is a StateCommon.
        const common = (obj.common ?? {}) as Partial<ioBroker.StateCommon>;
        const known: KnownState = {
          bshKey,
          bshValues,
          metaSig: metaSignature(common, { bshKey, bshValues }),
          type: common.type,
          name: common.name,
          desc: common.desc,
          hasStates: common.states !== undefined,
          hasValues: bshValues !== undefined,
          seenValues,
          defGeneration,
          nameSource: storedNameSource(native),
        };
        this.knownStates.set(rel, known);
        if (storedForm(bshKey, common, rel) !== undefined) {
          oldForms.set(rel, { common, known });
        } else if (isRecord(common.states) || (common.type === "string" && bshKey !== undefined)) {
          storedLists.set(rel, { common, known });
        }
        const parts = rel.split(".");
        // Writable options.* belong to the start-payload set (optionKeys); read-only
        // display options (RemainingProgramTime, …) must not.
        if (parts.length === 3 && parts[1] === "options" && obj.common?.write === true) {
          const deviceId = parts[0];
          const set = this.optionKeys.get(deviceId) ?? new Set<string>();
          set.add(parts[2]);
          this.optionKeys.set(deviceId, set);
        }
      }
    } catch (e) {
      this.port.log.debug(`priming known states from objects failed: ${errMessage(e)}`);
    }
    await this.refreshLegacyLabels();
    await this.bringOldFormsUpToDate(oldForms);
    await this.refreshValueLabels(storedLists);
    await this.refreshChannelNames();
    await this.restRunValuesAtStart();
  }

  /**
   * Note an operation state (stream, sync or the stored one at the start): outside a program under way the
   * appliance is at rest, and its remaining time and progress are left over (decision 48).
   *
   * @param deviceId the id-safe device path segment
   * @param value the operation state as sent (full key or short value)
   * @returns whether the appliance is at rest now
   */
  private noteOperationState(deviceId: string, value: string): boolean {
    if (PROGRAM_UNDER_WAY.has(shortEnum(value).toLowerCase())) {
      this.atRest.delete(deviceId);
      return false;
    }
    this.atRest.add(deviceId);
    return true;
  }

  /**
   * Write "no value" to the options that only mean something while a program is under way.
   *
   * @param deviceId the id-safe device path segment
   */
  private async emptyRunValues(deviceId: string): Promise<void> {
    for (const id of RUN_VALUE_KEYS.values()) {
      const rel = `${deviceId}.${id}`;
      if (this.knownStates.has(rel)) {
        await this.port.setStateChanged(rel, { val: null, ack: true });
      }
    }
  }

  /**
   * At the start, an appliance that was left at rest gets the same treatment as one that just came to rest —
   * its stored operation state decides; the first sync or event corrects it either way.
   */
  private async restRunValuesAtStart(): Promise<void> {
    for (const rel of [...this.knownStates.keys()].filter(id => id.endsWith(".status.operationState"))) {
      try {
        const stored = (await this.port.getState(rel))?.val;
        const deviceId = rel.split(".")[0];
        if (typeof stored === "string" && stored.length > 0 && this.noteOperationState(deviceId, stored)) {
          await this.emptyRunValues(deviceId);
        }
      } catch (e) {
        this.port.log.debug(`reading the stored operation state of ${rel} failed: ${errMessage(e)}`);
      }
    }
  }

  /**
   * Bring every datapoint an older version stored in another form to the current one, object and value, without a
   * single cloud request (decision 47): an on/off text becomes a switch ("on" → true), a number in the appliance's
   * unit its shown unit (2,011,440 s → 558.7 h). The same datapoint lives on — its id, and what hangs on it, stay. An
   * appliance that is off reports nothing for hours; without this its tree would show the old number under the new
   * unit, or a text in a boolean, until it does.
   *
   * @param oldForms relative id → stored `common` and known state of every datapoint in an older form
   */
  private async bringOldFormsUpToDate(
    oldForms: ReadonlyMap<string, { common: Partial<ioBroker.StateCommon>; known: KnownState }>,
  ): Promise<void> {
    for (const [rel, { common, known }] of oldForms) {
      const form = storedForm(known.bshKey, common, rel);
      if (form === undefined) {
        continue;
      }
      try {
        const patch: Partial<ioBroker.StateCommon> =
          form.kind === "switch"
            ? { type: "boolean", role: switchRole(known.bshKey ?? "", common.write === true), def: false }
            : shownBounds(common, form.p);
        if (form.kind === "switch") {
          await this.replaceWithoutList(rel, patch);
        } else {
          await this.port.extendObject(rel, { common: patch });
        }
        const val = (await this.port.getState(rel))?.val;
        const shown =
          form.kind === "switch"
            ? typeof val === "string"
              ? switchState(val)
              : undefined
            : typeof val === "number"
              ? toShown(val, form.p)
              : undefined;
        if (shown !== undefined) {
          await this.port.setState(rel, { val: shown, ack: true });
        }
        const now: Partial<ioBroker.StateCommon> = { ...common, ...patch };
        if (form.kind === "switch") {
          delete now.states;
          known.hasStates = false;
        }
        known.type = now.type;
        known.metaSig = metaSignature(now, { bshKey: known.bshKey, bshValues: known.bshValues });
      } catch (e) {
        this.port.log.debug(`bringing ${rel} to its current form failed: ${errMessage(e)}`);
      }
    }
  }

  /**
   * Write an object once more, whole, with the given `common` fields and without a value list. A merge can only null
   * `common.states`, and js-controller 7.2.2 keeps the `null` — an updated switch would then differ from the one a fresh
   * installation creates (the upgrade suite of the inventory run compares every field). Everything else on the object
   * stays, what hangs on it (`custom`) included.
   *
   * @param rel the namespace-relative state id
   * @param patch the `common` fields to set
   */
  private async replaceWithoutList(rel: string, patch: Partial<ioBroker.StateCommon>): Promise<void> {
    const obj = await this.port.getObject(rel);
    if (!obj) {
      return;
    }
    const common: Partial<ioBroker.StateCommon> = { ...(obj.common as Partial<ioBroker.StateCommon>), ...patch };
    delete common.states;
    await this.port.setForeignObject(`${this.port.namespace}.${rel}`, {
      ...obj,
      common,
    } as unknown as ioBroker.SettableObject);
  }

  /**
   * Give every stored value list the adapter's own labels in the system language, and an enum an older
   * version stored without a list the catalogue's list — without a single cloud request (decisions 41, 42).
   * A list is otherwise rebuilt only when a definition or an answer carries its datapoint again, and Home
   * Connect sends an option only in the state and program it belongs to (measured 2026-09-29: the
   * washer-dryer's definitions carried no temperature at all while it was idle), so an update left such a
   * datapoint with the labels an older version stored ("Cold" on a German installation), or with no list,
   * for good. A value the table does not know keeps the label it has; an existing list keeps its set of
   * values — which values a list holds stays the definitions' business.
   *
   * @param storedLists relative id → stored `common` and known state of every text datapoint of a BSH key
   */
  private async refreshValueLabels(
    storedLists: ReadonlyMap<string, { common: Partial<ioBroker.StateCommon>; known: KnownState }>,
  ): Promise<void> {
    const lang = this.port.language ?? DEFAULT_LABEL_LANGUAGE;
    for (const [rel, { common, known }] of storedLists) {
      if (!isRecord(common.states)) {
        await this.fillCatalogList(rel, common, known, lang);
        continue;
      }
      const stored = common.states;
      const states: Record<string, string> = { ...stored };
      let changed = false;
      const relabel = (short: string, wanted: string | undefined): void => {
        if (wanted !== undefined && typeof stored[short] === "string" && stored[short] !== wanted) {
          states[short] = wanted;
          changed = true;
        }
      };
      const values = known.bshValues ?? [];
      if (values.length > 0) {
        for (const v of values) {
          for (const short of new Set([shortEnumIn(v, values), shortEnum(v)])) {
            const label = stored[short];
            // The transformer's rule: own label, else the stored (cloud) one — never the bare short value.
            relabel(short, valueLabel(v, lang, label !== short ? label : undefined, known.bshKey));
          }
        }
      } else {
        // A read-only list stores no full values; its short value still ends like the full one,
        // which is all the own table looks at. Without a row the label stays as it is.
        for (const short of Object.keys(stored)) {
          relabel(short, ownValueLabel(short, lang));
        }
      }
      if (!changed) {
        continue;
      }
      try {
        await this.port.extendObject(rel, { common: { states } });
        // The stored object carries the new labels now: the next sync must not take them for a change.
        known.metaSig = metaSignature({ ...common, states }, { bshKey: known.bshKey, bshValues: known.bshValues });
      } catch (e) {
        this.port.log.debug(`relabelling the values of ${rel} failed: ${errMessage(e)}`);
      }
    }
  }

  /**
   * The catalogue's list for an enum an older version stored without one, built the way the transformer
   * builds it for a value without a cloud list (catalogue, then every value the datapoint carried). A key
   * the catalogue names only in the local appliance descriptions needs the prefix of a real value; the
   * stored full values lend it, and without one the datapoint waits for its next value.
   *
   * @param rel the namespace-relative state id
   * @param common the stored `common`
   * @param known its in-memory record
   * @param lang the system language
   */
  private async fillCatalogList(
    rel: string,
    common: Partial<ioBroker.StateCommon>,
    known: KnownState,
    lang: string,
  ): Promise<void> {
    const key = known.bshKey ?? "";
    const carried = [...(known.bshValues ?? []), ...(known.seenValues ?? [])];
    const catalogue = catalogValues(key, carried[0]);
    if (catalogue === undefined) {
      return;
    }
    const full = [...catalogue, ...carried.filter(v => !catalogue.includes(v))];
    // Options stay on the plain tail, every other list is list-unique (as in the transformer).
    const shortOf = (v: string): string => (rel.split(".")[1] === "options" ? shortEnum(v) : shortEnumIn(v, full));
    const states = Object.fromEntries(full.map(v => [shortOf(v), valueLabel(v, lang, undefined, key)]));
    try {
      await this.port.extendObject(rel, { common: { states } });
      known.hasStates = true;
      known.metaSig = metaSignature({ ...common, states }, { bshKey: known.bshKey, bshValues: known.bshValues });
    } catch (e) {
      this.port.log.debug(`giving ${rel} its list of values failed: ${errMessage(e)}`);
    }
  }

  /**
   * Bring datapoints an older version created up to the current naming, without
   * a single cloud request: before v1.15.0 a state's name was the bare id and it
   * carried no desc, and only the datapoints the appliance happens to report
   * right now pass through the sync that would fix them. An appliance that is
   * switched off, and every event datapoint, would keep its bare id forever.
   *
   * A stored name that is NOT the bare id came from the cloud (older versions
   * had no derived labels at all) — it is kept and marked as such, so the
   * derived label never replaces it later.
   *
   * The label is derived through {@link expandBshItem}, not `transformItem`: one
   * BSH key can carry SEVERAL datapoints (a door status becomes `doorOpen` +
   * `doorLocked`, the operation state additionally feeds `programRunning`), and
   * each of them owns its own name and explanation. Going through the 1:1
   * transform gave every one of them the label of the source item — two
   * datapoints of the same channel ended up with the same name and lost their
   * description (found and measured in the 2026-09-04 audit).
   */
  private async refreshLegacyLabels(): Promise<void> {
    for (const [rel, known] of this.knownStates) {
      if (known.bshKey === undefined) {
        continue;
      }
      const t = this.expandedLabelFor(rel, known.bshKey);
      if (!t) {
        continue;
      }
      const stored = known.name;
      if (known.nameSource !== undefined) {
        // Already stamped by this version: the normal precedence decides, and a
        // repaired object finds nothing left to change (no write per start).
        await this.refreshLabel(rel, known, t.common, t.nameSource);
        continue;
      }
      // Written before v1.15.0: a name that is not the bare id came from the
      // cloud (older versions had no derived labels) — keep it and mark it, so
      // a derived label never replaces it.
      // A name of OURS wins over one the cloud once delivered: it reaches every
      // language, the cloud name only the one that was set back then. A fallback
      // name does NOT — it carries the source "derived" precisely so that this
      // rule keeps a cloud text in an existing tree.
      const fromCloud =
        t.nameSource !== "i18n" && typeof stored === "string" && stored !== rel.slice(rel.lastIndexOf(".") + 1);
      await this.refreshLabel(
        rel,
        known,
        fromCloud ? { ...t.common, name: stored } : t.common,
        fromCloud ? "api" : t.nameSource,
      );
    }
  }

  /**
   * The transformed state that belongs to THIS datapoint id — the piece the
   * label repair needs. A BSH key expands to one state most of the time, but a
   * door status and the operation state expand to several, each with its own
   * name and explanation; only the one whose `channel.id` matches may lend its
   * label to this datapoint.
   *
   * A device whose stored `native` carries no appliance type yet (an early tree
   * whose appliance has been offline since) cannot say whether its door locks,
   * so `doorLocked` is not among the expanded states and this returns nothing:
   * the datapoint is then left exactly as it stands. Repairing it needs the
   * type, and the next sync of a reachable appliance persists that.
   *
   * @param rel the namespace-relative state id (`<device>.<channel>.<id>`)
   * @param bshKey the BSH key stored in the datapoint's native
   * @returns the matching transformed state, or undefined when none matches
   */
  private expandedLabelFor(rel: string, bshKey: string): TransformedState | undefined {
    const parts = rel.split(".");
    if (parts.length < 3) {
      return undefined;
    }
    const lockableDoor = LOCKABLE_DOOR_TYPES.has(this.typeByDeviceId.get(parts[0] ?? "") ?? "");
    const within = parts.slice(1).join(".");
    return expandBshItem({ key: bshKey, value: undefined }, lockableDoor).find(t => `${t.channel}.${t.id}` === within);
  }

  /**
   * Give the appliance channels their translated names — the channels of a tree
   * built by an older version still carry the bare id ("events", "status"), and
   * nothing else ever revisits a channel object that exists.
   */
  private async refreshChannelNames(): Promise<void> {
    try {
      const channels = await this.port.getForeignObjects(`${this.port.namespace}.*`, "channel");
      for (const [fullId, obj] of Object.entries(channels)) {
        const rel = this.relId(fullId);
        const parts = rel.split(".");
        // Only the per-appliance channels: the instance's own (auth, info) come
        // from the manifest and are named there, and a tree that is no appliance
        // of this run (a legacy tree, the old half of a move) is not ours to name.
        if (parts.length !== 2 || !this.haIdByDeviceId.has(parts[0] ?? "")) {
          continue;
        }
        const fresh = channelName(parts[1]);
        if (sameName(obj.common?.name, fresh)) {
          continue;
        }
        await this.port.extendObject(rel, { type: "channel", common: { name: fresh }, native: {} });
      }
    } catch (e) {
      this.port.log.debug(`refreshing the channel names failed: ${errMessage(e)}`);
    }
  }

  /**
   * Sort out the trees the previous adapter generation (community 1.6.x) left behind — an update
   * cleans up after itself, the user never deletes objects by hand. A tree without a room or function
   * assignment and without an alias pointing into it goes right away. A tree with one waits for its
   * appliance: once the appliance list has created the new tree and the appliance has been read in
   * full, {@link adoptLegacyTree} carries those over and deletes the old tree. A recording decides
   * nothing here — it belongs to the user and goes on only with the same datapoint. Runs first at
   * start, so no tree pass ever sees a legacy state.
   */
  async sortOutLegacyTrees(): Promise<void> {
    try {
      const all = await this.port.getAdapterObjects();
      const relative: Record<string, { type?: string; native?: unknown }> = {};
      for (const [id, obj] of Object.entries(all)) {
        const rel = this.relId(id);
        if (rel !== id && obj) {
          relative[rel] = { type: obj.type, native: obj.native };
        }
      }
      const roots = planLegacyCleanup(relative);
      if (roots.length === 0) {
        return;
      }
      const attached = await this.attachedIds();
      let removed = 0;
      for (const root of roots) {
        const rootFull = `${this.port.namespace}.${root}`;
        const holds = [...attached].some(id => id === rootFull || id.startsWith(`${rootFull}.`));
        if (holds) {
          this.pendingLegacyRoots.add(root);
          continue;
        }
        try {
          await this.port.delObjectRecursive(root);
          this.forgetWritten(root);
          removed++;
        } catch (e) {
          this.port.log.debug(`legacy cleanup: could not delete ${root}: ${errMessage(e)}`);
        }
      }
      if (removed > 0) {
        this.port.log.info(
          `Removed ${removed} object tree(s) of the previous adapter generation — the new device tree replaces them; your sign-in is kept.`,
        );
      }
      if (this.pendingLegacyRoots.size > 0) {
        this.port.log.info(
          `${this.pendingLegacyRoots.size} object tree(s) of the previous adapter generation carry rooms or aliases — ` +
            `they move to the new datapoints once the appliance has been read.`,
        );
      }
    } catch (e) {
      this.port.log.warn(`sorting out the previous adapter generation's trees failed: ${errMessage(e)}`);
    }
  }

  /**
   * The full ids that a room, a function or an alias points at.
   *
   * @returns the ids
   */
  private async attachedIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const obj of Object.values(await this.port.getEnums())) {
      const members = (obj as { common?: { members?: unknown } } | null)?.common?.members;
      if (Array.isArray(members)) {
        for (const member of members) {
          if (typeof member === "string") {
            ids.add(member);
          }
        }
      }
    }
    for (const obj of Object.values(await this.port.getAliases())) {
      const target = (obj?.common as { alias?: { id?: unknown } } | undefined)?.alias?.id;
      for (const id of typeof target === "string" ? [target] : Object.values(isRecord(target) ? target : {})) {
        if (typeof id === "string") {
          ids.add(id);
        }
      }
    }
    return ids;
  }

  /**
   * The datapoints of the new tree that take the place of one legacy datapoint: a raw BSH key leaf
   * (`status.BSH_Common_Status_OperationState`) becomes the key again and goes through the same
   * expansion as the sync (`status.operationState` and `status.programRunning`); the old
   * `general.connected` becomes `info.reachable`. Anything else has no counterpart.
   *
   * @param rel the legacy state's namespace-relative id
   * @param deviceId the appliance's new device id
   * @returns the namespace-relative target ids, the main one first
   */
  private legacyTargets(rel: string, deviceId: string): string[] {
    const parts = rel.split(".");
    const leaf = parts.at(-1) ?? "";
    if (parts.length === 3 && parts[1] === "general" && leaf === "connected") {
      return [`${deviceId}.info.reachable`];
    }
    if (!LEGACY_LEAF.test(leaf)) {
      return [];
    }
    const lockable = LOCKABLE_DOOR_TYPES.has(this.typeByDeviceId.get(deviceId) ?? "");
    return expandBshItem({ key: leaf.replace(/_/g, "."), value: undefined }, lockable).map(
      t => `${deviceId}.${t.channel}.${t.id}`,
    );
  }

  /**
   * Hand a legacy tree over to its appliance's new tree and delete it: the room and function
   * assignments and the aliases follow to the datapoints that take the old ones' place. A recording
   * goes on only where the SAME datapoint lives on — one successor of the same value type, its series
   * continued under the old id (`aliasId`); a datapoint replaced by several, or by one of another
   * type (a door text became yes/no), is a new datapoint and starts without the user's settings. A
   * legacy datapoint without a counterpart goes with the tree.
   *
   * @param deviceId the appliance's new device id
   * @param haId its haId
   */
  private async adoptLegacyTree(deviceId: string, haId: string): Promise<void> {
    const root = legacyRootOf(haId);
    if (!this.pendingLegacyRoots.delete(root)) {
      return;
    }
    const ns = this.port.namespace;
    const rootFull = `${ns}.${root}`;
    try {
      const all = await this.port.getAdapterObjects();
      const attached = await this.attachedIds();
      const carry = new Map<string, string[]>();
      let lost = 0;
      for (const [id, obj] of Object.entries(all)) {
        if (!obj || obj.type !== "state" || !id.startsWith(`${rootFull}.`)) {
          continue;
        }
        const targets = this.legacyTargets(this.relId(id), deviceId)
          .map(rel => `${ns}.${rel}`)
          .filter(full => all[full]?.type === "state");
        if (targets.length === 0) {
          if (attached.has(id)) {
            lost++;
          }
          continue;
        }
        carry.set(id, targets);
        const own = obj.common as { custom?: unknown; type?: unknown };
        const successor = all[targets[0]]?.common as { custom?: unknown; type?: unknown } | undefined;
        // The same datapoint moved: one successor of the same value type, which carries no settings of its own.
        if (
          targets.length === 1 &&
          isRecord(own.custom) &&
          successor?.type === own.type &&
          !(isRecord(successor?.custom) && Object.keys(successor.custom).length > 0)
        ) {
          const custom = JSON.parse(JSON.stringify(own.custom)) as Record<string, unknown>;
          keepHistoryUnder(custom, id);
          await this.port.extendForeignObject(targets[0], { common: { custom } });
        }
      }
      const aliases = await retargetAliases(
        await this.port.getAliases(),
        id => carry.get(id)?.[0],
        (id, obj) => this.port.setForeignObject(id, obj),
      );
      const enums = await this.port.deleteTreeCarryingEnums(root, carry);
      this.forgetWritten(root);
      const carried = [
        ...(enums > 0 ? [`${enums} room/function entr${enums === 1 ? "y" : "ies"}`] : []),
        ...(aliases > 0 ? [`${aliases} alias(es)`] : []),
      ];
      this.port.log.info(
        `${this.label(deviceId)}: took over the object tree ${root} of the previous adapter generation` +
          `${carried.length > 0 ? ` — ${carried.join(", ")} carried to the new datapoints` : ""}` +
          `${lost > 0 ? `; ${lost} datapoint(s) with a room or alias have no counterpart and are gone` : ""}.`,
      );
    } catch (e) {
      // The root waits again: the next full read tries once more.
      this.pendingLegacyRoots.add(root);
      this.port.log.warn(`${this.label(deviceId)}: taking over the old object tree ${root} failed: ${errMessage(e)}`);
    }
  }

  /**
   * Delete the waiting legacy trees whose appliance is no longer on the account — nothing will ever
   * take them over. Only after a list that named appliances (see {@link syncAppliances}).
   *
   * @param listed the haIds the account listed
   */
  private async dropOrphanLegacyTrees(listed: ReadonlySet<string>): Promise<void> {
    const wanted = new Set([...listed].map(legacyRootOf));
    for (const root of [...this.pendingLegacyRoots]) {
      if (wanted.has(root)) {
        continue;
      }
      this.pendingLegacyRoots.delete(root);
      try {
        await this.port.delObjectRecursive(root);
        this.forgetWritten(root);
        this.port.log.info(
          `Removed the object tree ${root} of the previous adapter generation — its appliance is not on the Home Connect account.`,
        );
      } catch (e) {
        this.port.log.debug(`legacy cleanup: could not delete ${root}: ${errMessage(e)}`);
      }
    }
  }

  /**
   * The one-time move of every appliance tree an earlier version created under an older id rule —
   * the app name (up to 1.12.x) or the E-number from the type plate (1.13.0 to 1.23.x), both of which
   * name the MODEL only — to its model and the last four characters of its own number
   * ({@link deviceIdFor}, `sx87tx02ce-5775`). Runs on every start, BEFORE the datapoint migration and
   * priming, so the maps only ever see current ids; a tree whose id is final carries
   * `native.idScheme` and costs one comparison.
   *
   * The order keeps every step repeatable: the journal (`native.movingTo` at the OLD device object)
   * first, then the copy ({@link copyDeviceTree}: objects with their recording settings, values,
   * alias targets, the mark last), then the delete of the old tree, which carries the room and
   * function assignments. A start that finds the journal again finds the copy complete and only
   * finishes what is left.
   *
   * A tree whose stored native carries neither a model code nor an E-number yet keeps its id this
   * run; the next sync persists those fields and the next start moves it. The trees are handled in
   * haId order, so two appliances of one model whose numbers end alike get the same ids on every
   * start and every installation.
   */
  async migrateDeviceIds(): Promise<void> {
    try {
      const devices = await this.port.getForeignObjects(`${this.port.namespace}.*`, "device");
      type Tree = { id: string; name: string; native: Record<string, unknown> & { haId: string } };
      const byHaId = new Map<string, Tree[]>();
      const taken = new Set<string>();
      for (const [fullId, obj] of Object.entries(devices)) {
        const id = this.relId(fullId);
        const native = (obj.native ?? {}) as Record<string, unknown>;
        if (id.length === 0 || id.includes(".") || typeof native.haId !== "string") {
          continue;
        }
        taken.add(id);
        const name = typeof obj.common?.name === "string" && obj.common.name.length > 0 ? obj.common.name : id;
        const trees = byHaId.get(native.haId) ?? [];
        trees.push({ id, name, native: native as Tree["native"] });
        byHaId.set(native.haId, trees);
      }
      const moves: Array<{ from: string; to: string; name: string; fillOnly: boolean }> = [];
      // haId order: two appliances of one model whose numbers end alike get the same ids on every
      // start and every installation — the listing order of the object database is no order.
      for (const haId of [...byHaId.keys()].sort()) {
        const trees = byHaId.get(haId)!;
        // One appliance, one tree. Two trees of one appliance are what an interrupted move leaves
        // behind: the one that is kept is the finished one, else the target of a journal, else the
        // one the 1.13.0 rule named after the E-number (where the older rule's move went), else the
        // first. The others are leftovers — what they still hold that the kept tree lacks moves in.
        const journalTargets = new Set(trees.map(t => t.native.movingTo).filter(v => typeof v === "string"));
        const eNumberId = (t: Tree): boolean => {
          const plate = typeof t.native.enumber === "string" ? slugOf(t.native.enumber) : "";
          return plate.length > 0 && (t.id === plate || t.id.startsWith(`${plate}-`));
        };
        const kept =
          trees.find(t => t.native.idScheme === ID_SCHEME) ??
          trees.find(t => journalTargets.has(t.id)) ??
          (trees.length > 1 ? trees.find(eNumberId) : undefined) ??
          [...trees].sort((a, b) => a.id.localeCompare(b.id))[0];
        let target: string | undefined;
        const journal = kept.native.movingTo;
        if (kept.native.idScheme === ID_SCHEME) {
          target = kept.id;
        } else if (typeof journal === "string" && journal.length > 0 && !journal.includes(".") && journal !== kept.id) {
          // A move that did not finish: it goes on to the id it was decided for.
          target = journal;
          taken.add(journal);
        } else if ([kept.native.vib, kept.native.enumber].some(v => typeof v === "string" && v.trim().length > 0)) {
          const own = new Set(trees.map(t => t.id));
          target = deviceIdFor(
            { haId, vib: kept.native.vib, enumber: kept.native.enumber, type: kept.native.type },
            new Set([...taken].filter(other => !own.has(other))),
          );
          taken.add(target);
        }
        if (target === undefined) {
          // No model code and no E-number stored yet: the next sync persists them, the next start
          // moves the tree. Guessing now would move it twice.
          continue;
        }
        if (target === kept.id) {
          if (kept.native.idScheme !== ID_SCHEME) {
            await this.port.extendObject(kept.id, { native: { idScheme: ID_SCHEME } });
          }
        } else {
          moves.push({ from: kept.id, to: target, name: kept.name, fillOnly: false });
        }
        for (const leftover of trees) {
          if (leftover !== kept) {
            moves.push({ from: leftover.id, to: target, name: kept.name, fillOnly: true });
          }
        }
      }
      for (const move of moves) {
        if (this.stopped) {
          return;
        }
        await this.moveDeviceTree(move.from, move.to, move.name, move.fillOnly);
      }
    } catch (e) {
      this.port.log.warn(`migrating device ids failed: ${errMessage(e)} — the appliances run under their current ids`);
    }
  }

  /**
   * Move one appliance tree: journal, copy, delete with the room and function assignments carried.
   * A failure leaves the journal in place — the next start tries again, and this run keeps the
   * appliance where it was.
   *
   * @param from the current device id
   * @param to the new device id
   * @param name the appliance's display name, for the log line
   * @param fillOnly `from` is a leftover next to the kept tree — only what that one lacks moves in
   */
  private async moveDeviceTree(from: string, to: string, name: string, fillOnly: boolean): Promise<void> {
    const ns = this.port.namespace;
    try {
      await this.port.extendObject(from, { native: { movingTo: to } });
      const report = await copyDeviceTree(this.moveDeps(), from, to, fillOnly);
      const objects = await this.port.getAdapterObjects();
      const carry = new Map<string, string[]>();
      for (const id of Object.keys(objects)) {
        const next = movedId(id, `${ns}.${from}`, `${ns}.${to}`);
        if (next) {
          carry.set(id, [next]);
        }
      }
      report.enums = await this.port.deleteTreeCarryingEnums(from, carry);
      this.forgetWritten(from);
      const carried = [
        ...(report.enums > 0 ? [`${report.enums} room/function entr${report.enums === 1 ? "y" : "ies"}`] : []),
        ...(report.aliases > 0 ? [`${report.aliases} alias(es)`] : []),
      ];
      this.port.log.info(
        `${
          fillOnly
            ? `Appliance "${name}": finished the interrupted move of ${from} to ${to} — moved ${report.datapoints} more datapoint(s)`
            : `Appliance "${name}": device id is now ${to} (was ${from}) — moved ${report.datapoints} datapoint(s)`
        }${carried.length > 0 ? ` with ${carried.join(", ")}` : ""}`,
      );
    } catch (e) {
      this.port.log.warn(
        `Appliance "${name}": could not move ${from} to ${to} (${errMessage(e)}) — tried again on the next start`,
      );
    }
  }

  /**
   * The object and state calls a tree move needs, over the port.
   *
   * @returns the move's dependencies
   */
  private moveDeps(): DeviceMoveDeps {
    return {
      namespace: this.port.namespace,
      objects: () => this.port.getAdapterObjects(),
      states: pattern => this.port.getForeignStates(pattern),
      setObject: (id, obj) => this.port.setForeignObject(id, obj),
      extendObject: (id, patch) => this.port.extendForeignObject(id, patch),
      setState: (id, state) => this.port.setForeignState(id, state),
      aliases: () => this.port.getAliases(),
    };
  }

  /**
   * Move the numbered history datapoints of an older version (`history.program3`, `history.duration3`) to the
   * run they describe (`history.thirdLatest.program`), decision 48. It is the same datapoint with the same
   * value type, so its object, value, recording, aliases, rooms and functions move along; `history` becomes the
   * folder the run channels sit in. Runs before priming, like every other migration.
   */
  async migrateHistoryRuns(): Promise<void> {
    try {
      const ns = this.port.namespace;
      const all = await this.port.getAdapterObjects();
      let moved = 0;
      for (const [fullId, obj] of Object.entries(all)) {
        const match = NUMBERED_HISTORY.exec(this.relId(fullId));
        if (!match || !obj) {
          continue;
        }
        const [, deviceId, kind, digits] = match;
        const run = this.historyRun(Number(digits));
        const toRel = `${deviceId}.${run.channel}.${kind}`;
        const toFull = `${ns}.${toRel}`;
        await this.ensureHistoryFolder(deviceId);
        await this.port.extendObject(`${deviceId}.${run.channel}`, {
          type: "channel",
          common: { name: run.label },
          native: {},
        });
        const { object } = rewriteMovedObject(fullId, obj, fullId, toFull);
        await this.port.setForeignObject(toFull, object);
        const state = (await this.port.getForeignStates(fullId))[fullId];
        if (state) {
          await this.port.setForeignState(toFull, {
            val: state.val,
            ack: state.ack,
            ...(typeof state.ts === "number" ? { ts: state.ts } : {}),
            ...(typeof state.lc === "number" ? { lc: state.lc } : {}),
            ...(typeof state.q === "number" ? { q: state.q } : {}),
          });
        }
        await retargetAliases(
          await this.port.getAliases(),
          id => (id === fullId ? toFull : undefined),
          (id, alias) => this.port.setForeignObject(id, alias),
        );
        await this.port.deleteTreeCarryingEnums(this.relId(fullId), new Map([[fullId, [toFull]]]));
        moved++;
      }
      if (moved > 0) {
        this.port.log.info(`Moved ${moved} history datapoint(s) to named runs.`);
      }
    } catch (e) {
      this.port.log.warn(`moving the history datapoints failed: ${errMessage(e)} — tried again on the next start`);
    }
  }

  /**
   * Migrate datapoints whose id changed with a newer adapter version to their
   * corrected place — the update cleans up after itself, the user never deletes
   * objects by hand. Runs BEFORE priming, so the maps only ever see current ids.
   *
   * Covered: every state whose stored BSH key now routes to a different
   * channel/id (the old "misc" mis-channeling, nested keys), the door text
   * states that became booleans, and the whole `programs` channel of appliance
   * types that have no programs. A 1:1 rename carries the user's recording
   * along and continues its series under the old id (`aliasId`); a reshaped
   * state (text → boolean pair) starts fresh and gets its live value from the
   * next sync. Rooms, functions and aliases follow to the new place either way.
   */
  async migrateRenamedStates(): Promise<void> {
    try {
      const devices = await this.port.getForeignObjects(`${this.port.namespace}.*`, "device");
      const typeByDevice = new Map<string, string>();
      for (const [fullId, obj] of Object.entries(devices)) {
        const deviceId = this.relId(fullId);
        const type = (obj.native as { type?: unknown } | undefined)?.type;
        if (!deviceId.includes(".") && typeof type === "string") {
          typeByDevice.set(deviceId, type);
        }
      }
      const states = await this.port.getForeignObjects(`${this.port.namespace}.*`, "state");
      // Per device.channel: how many states remain — drained old channels lose their channel object.
      const remaining = new Map<string, number>();
      for (const fullId of Object.keys(states)) {
        const parts = this.relId(fullId).split(".");
        if (parts.length >= 3) {
          const channelPath = `${parts[0]}.${parts[1]}`;
          remaining.set(channelPath, (remaining.get(channelPath) ?? 0) + 1);
        }
      }
      const drainedCandidates = new Set<string>();
      /** old full id → the full ids that take its place, for the rooms and the aliases. */
      const moved = new Map<string, string[]>();
      let migrated = 0;

      for (const [fullId, obj] of Object.entries(states)) {
        const rel = this.relId(fullId);
        const parts = rel.split(".");
        if (parts.length < 3) {
          continue;
        }
        const deviceId = parts[0] ?? "";
        const channelPath = `${deviceId}.${parts[1]}`;
        const type = typeByDevice.get(deviceId);
        // A program-less appliance type loses its whole programs channel.
        if (type && PROGRAMLESS_TYPES.has(type) && parts[1] === "programs") {
          await this.deleteMigratedState(rel, [], channelPath, remaining, drainedCandidates);
          migrated++;
          continue;
        }
        const native = (obj.native ?? {}) as { bshKey?: unknown };
        if (typeof native.bshKey !== "string") {
          continue;
        }
        const lockable = LOCKABLE_DOOR_TYPES.has(type ?? "");
        // The target ids do not depend on the value — so the "already in place"
        // check runs on a value-less expansion, and the value is read only for
        // a datapoint that actually moves. Reading it first cost one getState per
        // datapoint per start (929 on the full inventory) for nothing.
        const current = parts.slice(1).join(".");
        if (
          expandBshItem({ key: native.bshKey, value: undefined }, lockable).some(
            t => `${t.channel}.${t.id}` === current,
          )
        ) {
          continue; // already in its current place
        }
        const oldValue = (await this.port.getState(rel))?.val;
        // For a door the old short text ("open"/"locked") is folded back into a
        // synthetic enum value, so the expansion derives the right booleans. The
        // expansion with the real value decides the target TYPE (a number stays
        // a number) — the value-less one above only knew the ids.
        const value =
          isDoorStatusKey(native.bshKey) && typeof oldValue === "string"
            ? `BSH.Common.EnumType.DoorState.${oldValue.charAt(0).toUpperCase()}${oldValue.slice(1)}`
            : oldValue;
        const expanded = expandBshItem({ key: native.bshKey, value }, lockable);
        const oneToOne = expanded.length === 1;
        for (const t of expanded) {
          const newRel = `${deviceId}.${t.channel}.${t.id}`;
          const common: ioBroker.StateCommon = { ...t.common };
          const oldCommon = (obj.common ?? {}) as Partial<ioBroker.StateCommon>;
          if (oneToOne && t.common.type === oldCommon.type) {
            // Same shape, new place: keep the authoritative metadata the REST
            // sync established (unit, bounds, allowed values, writability) and
            // the user's recording configuration — a migration is our own
            // maintenance, it must not cost the user their charts.
            Object.assign(common, oldCommon);
            // The recording goes on in its series, under the id it ran under so far.
            if (oldCommon.custom) {
              const custom = JSON.parse(JSON.stringify(oldCommon.custom)) as Record<string, unknown>;
              keepHistoryUnder(custom, fullId);
              common.custom = custom;
            }
            if (t.channel === "settings") {
              // The old misc mis-channeling also mis-derived read-only; the next
              // REST sync re-tightens genuine read-only settings via the signature.
              common.write = true;
            }
          }
          // Name and desc are the adapter's — the new place gets the current
          // label whatever stood on the old object (the adapter owns its
          // datapoints; a user's own datapoints live under 0_userdata).
          common.name = t.common.name;
          common.desc = t.common.desc;
          await this.port.extendObject(`${deviceId}.${t.channel}`, {
            type: "channel",
            common: { name: channelName(t.channel) },
            native: {},
          });
          await this.port.extendObject(newRel, {
            type: "state",
            common,
            native: { bshKey: native.bshKey, bshValues: t.bshValues, nameSource: t.nameSource },
          });
          // The target lives in a channel too — one that received a migrated state
          // must not be deleted as drained (a move within one channel emptied it
          // of the old id and took the new one's parent with it).
          const targetChannel = `${deviceId}.${t.channel}`;
          remaining.set(targetChannel, (remaining.get(targetChannel) ?? 0) + 1);
          const newValue = oneToOne && t.common.type === oldCommon.type ? oldValue : t.value;
          if (newValue !== null && newValue !== undefined) {
            await this.port.setState(newRel, { val: newValue, ack: true });
          }
          this.port.log.debug(`migrated ${rel} → ${newRel}`);
        }
        const targets = expanded.map(t => `${this.port.namespace}.${deviceId}.${t.channel}.${t.id}`);
        moved.set(fullId, targets);
        await this.deleteMigratedState(rel, targets, channelPath, remaining, drainedCandidates);
        migrated++;
      }
      const aliases =
        moved.size > 0
          ? await retargetAliases(
              await this.port.getAliases(),
              id => moved.get(id)?.[0],
              (id, obj) => this.port.setForeignObject(id, obj),
            )
          : 0;
      for (const channelPath of drainedCandidates) {
        if ((remaining.get(channelPath) ?? 0) === 0) {
          await this.port.delObject(channelPath).catch(() => undefined);
          this.forgetWritten(channelPath);
        }
      }
      if (migrated > 0) {
        this.port.log.info(
          `Migrated ${migrated} datapoint(s) to the corrected tree layout` +
            `${aliases > 0 ? ` with ${aliases} alias(es)` : ""}.`,
        );
      }
    } catch (e) {
      this.port.log.warn(`migrating renamed datapoints failed: ${errMessage(e)}`);
    }
  }

  /**
   * Delete one migrated-away state — its room and function assignments go to the
   * datapoints that take its place — and account for its channel possibly
   * draining empty (the channel object is removed at the end then).
   *
   * @param rel the namespace-relative state id to delete
   * @param targets the full ids that take its place (none: it simply goes)
   * @param channelPath the device-qualified channel it lives under
   * @param remaining the per-channel remaining-state counter
   * @param drained the set of channels that may end up empty
   */
  private async deleteMigratedState(
    rel: string,
    targets: readonly string[],
    channelPath: string,
    remaining: Map<string, number>,
    drained: Set<string>,
  ): Promise<void> {
    try {
      await this.port.deleteTreeCarryingEnums(rel, new Map([[`${this.port.namespace}.${rel}`, [...targets]]]));
      this.forgetWritten(rel);
    } catch (e) {
      this.port.log.debug(`removing ${rel} failed: ${errMessage(e)}`);
    }
    remaining.set(channelPath, (remaining.get(channelPath) ?? 1) - 1);
    drained.add(channelPath);
  }

  /**
   * Route a stream event to its device's states.
   *
   * @param event the parsed SSE event
   */
  handleStreamEvent(event: SseEvent): void {
    if (this.stopped) {
      return;
    }
    try {
      // A frame without a JSON body (CONNECTED/DISCONNECTED can come with an empty
      // `data`) still names its appliance in the SSE id — it is not thrown away.
      let parsed: unknown;
      try {
        parsed = event.data.length > 0 ? JSON.parse(event.data) : {};
      } catch {
        parsed = {};
      }
      const payload: Record<string, unknown> = isRecord(parsed) ? parsed : {};
      // The payload haId is authoritative. The SSE id only serves as a fallback
      // (issue #88: sometimes one of the two is missing) — it persists across
      // events per the SSE spec, so a stale id must never override the payload.
      const payloadHaId = typeof payload.haId === "string" && payload.haId.length > 0 ? payload.haId : undefined;
      const haId = payloadHaId ?? (event.id || undefined);
      if (!haId) {
        return;
      }
      const deviceId = this.deviceIdByHaId.get(haId);

      // A device coming (back) online, or a newly paired one: (re)build its data tree.
      if (event.event === "CONNECTED" || event.event === "PAIRED") {
        if (deviceId) {
          // The fresh pass takes over from a pending "not ready" re-read, with a
          // fresh back-off.
          this.cancelNotReadyRetry(deviceId);
          if (this.syncing.has(deviceId)) {
            this.resyncPending.add(deviceId);
          }
          void this.guarded(async () => {
            await this.setReachable(deviceId, true);
            await this.syncApplianceData(deviceId, haId);
          });
        } else if (event.event === "PAIRED") {
          // A genuinely new appliance — fetch the full list once.
          void this.guarded(() => this.syncAppliances());
        } else {
          // CONNECTED for an unknown haId — fetch just that appliance, not a full re-sync.
          void this.guarded(() => this.syncSingleAppliance(haId));
        }
        return;
      }

      if (!deviceId) {
        return;
      }

      // Merely offline: the appliance is switched off but still on the account.
      if (event.event === "DISCONNECTED") {
        // Switched off again before it was ready: its next CONNECTED reads it.
        this.cancelNotReadyRetry(deviceId);
        void this.guarded(() => this.setReachable(deviceId, false));
        return;
      }

      // Removed from the account: what is not there any more does not stay in the
      // tree. Keeping it would leave datapoints that can never update again and an
      // entry that counts as permanently offline in the instance summary.
      if (event.event === "DEPAIRED") {
        this.port.log.info(
          `Appliance ${this.label(deviceId)} was removed from the Home Connect account — removing its objects.`,
        );
        void this.guarded(() => this.removeAppliance(deviceId, haId));
        return;
      }

      const items = Array.isArray(payload.items) ? payload.items : [];
      const now = Date.now();
      for (const raw of items) {
        if (isRecord(raw)) {
          if (typeof raw.key === "string") {
            this.lastStreamAt.set(`${deviceId}|${raw.key}`, now);
          }
          void this.guarded(() => this.applyBshItem(deviceId, raw, "values"));
        }
      }
    } catch (e) {
      this.port.log.warn(`handling stream event failed: ${errMessage(e)}`);
    }
  }

  /**
   * Run a fire-and-forget async unit with a top-level catch (no unhandled rejection).
   *
   * @param fn the async unit to run
   */
  private async guarded(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.port.log.warn(`appliance sync task failed: ${errMessage(e)}`);
    }
  }

  /** Fetch the paired appliances and build/update their object tree. */
  async syncAppliances(): Promise<boolean> {
    const data = await this.port.apiGet("/api/homeappliances");
    // A failed or malformed fetch must not report "0 appliances" — nothing was learned.
    if (!isRecord(data) || !Array.isArray(data.homeappliances)) {
      this.port.log.debug("appliance list not available — keeping the current tree.");
      // Reported to the caller: the outage catch-up must not announce a re-read
      // that never happened, nor start its cooldown on it.
      return false;
    }
    const list = data.homeappliances;
    // The summary comes FIRST — before any per-device work writes its lines
    // (fleet convention; the old trailing "N found" read like an afterthought).
    this.port.log.info(`Setting up ${list.length} appliance(s) from the Home Connect account...`);
    const seen = new Set<string>();
    // One flush of the three sums at the end of the pass, not after every
    // appliance — see {@link rollupBatched}.
    this.rollupBatched = true;
    try {
      for (const raw of list) {
        if (this.stopped) {
          break;
        }
        if (isRecord(raw)) {
          if (typeof raw.haId === "string") {
            seen.add(raw.haId);
          }
          // One appliance whose objects cannot be written must not cost the
          // others, the removal pass and the sums: the failure stays with it.
          try {
            await this.syncAppliance(raw);
          } catch (e) {
            if (this.stopped) {
              break;
            }
            const who = typeof raw.haId === "string" ? raw.haId : "an appliance";
            this.port.log.warn(`Could not set up ${who}: ${errMessage(e)} — the other appliances go on.`);
          }
        }
      }
    } finally {
      this.rollupBatched = false;
    }
    if (this.stopped) {
      // Stopped mid-pass: the rollup and the removal pass below belong to a
      // completed read — markAllUnreachable writes the final sums.
      return false;
    }
    await this.writeDeviceRollup();
    // The second way an appliance disappears: not through a DEPAIRED event but by
    // simply no longer being in the list — removed while the adapter was off. Only
    // reached on a SUCCESSFUL fetch (the guard above returns early otherwise), so a
    // failed request can never wipe the tree.
    //
    // An EMPTY list is not that case. It answers with HTTP 200 and takes the same
    // path, but "the account lists nothing at all" is what a token that lost its
    // appliance scope, an account move or a cloud-side hiccup looks like — and it
    // would delete every tree at once. An appliance that really is gone still goes
    // through its DEPAIRED event, which needs no list at all.
    if (list.length === 0) {
      if (this.deviceIdByHaId.size > 0) {
        this.port.log.warn(
          `Home Connect listed no appliances at all while ${this.deviceIdByHaId.size} are known — keeping their objects. ` +
            `An appliance removed from the account is dropped on its removal event.`,
        );
      }
      // The cloud DID answer — this is a reached sync, just an empty account.
      // The suspicious case (appliances known, none listed) is carried by the
      // warning above, not by hammering the endpoint on every stream flap.
      return true;
    }
    await this.dropOrphanLegacyTrees(seen);
    for (const [haId, deviceId] of [...this.deviceIdByHaId]) {
      if (!seen.has(haId)) {
        this.port.log.info(
          `Appliance ${this.label(deviceId)} is no longer on the Home Connect account — removing its objects.`,
        );
        await this.removeAppliance(deviceId, haId);
      }
    }
    return true;
  }

  /**
   * Fetch a single appliance (used for a CONNECTED event whose haId we don't know yet).
   *
   * @param haId the appliance's haId
   */
  private async syncSingleAppliance(haId: string): Promise<void> {
    const data = await this.port.apiGet(appliancePath(haId));
    if (isRecord(data)) {
      await this.syncAppliance(data);
    }
  }

  /**
   * The device object the adapter owns — built in ONE place, so the signature
   * taken at priming (from the stored object) and the one taken at sync (from the
   * cloud record) are formed identically. Two hand-rolled shapes would differ in
   * key order alone and make every start rewrite every device object.
   *
   * @param deviceId the id-safe device path segment
   * @param name the appliance's display name (cleaned cloud text)
   * @param native the appliance's own fields, the ones the adapter owns
   * @param native.haId the appliance's haId (the cloud's own identifier)
   * @param native.type the appliance type, e.g. "Dishwasher"
   * @param native.brand the brand from the type plate
   * @param native.vib the model code (VIB)
   * @param native.enumber the E-number from the type plate
   * @param native.idScheme the id-rule generation the device id was decided under (`ID_SCHEME`), or
   *   undefined for a tree that still carries an older id — the mark is part of the object, so a
   *   decided id is written with it and a stored one compared with it
   * @param icon the pictogram for the appliance type, or `undefined` for a type
   *   we have none for. Passed IN rather than derived here for the same reason
   *   the name is: priming has to be able to form the signature of what is
   *   actually STORED. Deriving it inside would make a brand-new field match
   *   itself, and no existing device would ever be given its icon.
   * @returns the partial object to compare and, on a difference, to write
   */
  private deviceObject(
    deviceId: string,
    name: string,
    native: { haId: string; type?: string; brand?: string; vib?: string; enumber?: string; idScheme?: number },
    icon: string | undefined,
  ): ioBroker.PartialObject {
    return {
      type: "device",
      // statusStates is what puts the green/grey dot on the device node — the
      // `info.reachable` state alone is just a value nobody links to the icon.
      // The id has to be the full path, not the device-relative one.
      common: { name, icon, statusStates: { onlineId: `${this.port.namespace}.${deviceId}.info.reachable` } },
      native: {
        haId: native.haId,
        type: native.type,
        brand: native.brand,
        vib: native.vib,
        enumber: native.enumber,
        idScheme: native.idScheme,
      },
    };
  }

  /**
   * Build the object tree for one appliance under its device id and sync its data
   * (only when currently connected).
   *
   * @param a the appliance record from /api/homeappliances
   */
  private async syncAppliance(a: Record<string, unknown>): Promise<void> {
    const haId = typeof a.haId === "string" ? a.haId : undefined;
    if (!haId) {
      return;
    }
    // The app name is cloud text: cleaned before it becomes an object name and a
    // log label (a line break in it would split both).
    const name = cleanLabel(a.name, fallbackName(a) ?? haId);
    const deviceId = this.deviceIdByHaId.get(haId) ?? this.assignDeviceId(a, haId, name);
    this.nameByDeviceId.set(deviceId, name);
    const deviceObj = this.deviceObject(
      deviceId,
      name,
      {
        haId,
        type: stringOrUndef(a.type),
        brand: stringOrUndef(a.brand),
        vib: stringOrUndef(a.vib),
        enumber: stringOrUndef(a.enumber),
        idScheme: this.idDecided.has(deviceId) ? ID_SCHEME : undefined,
      },
      deviceIcon(stringOrUndef(a.type)),
    );
    // Memory-guarded, like every other object write here. An identical
    // `extendObject` is a REAL write plus an `objectChange` to every subscriber
    // (js-controller 7.2.2 stamps `obj.ts` and never short-circuits), so writing
    // this unconditionally cost one object write per appliance per pass — and per
    // CONNECTED event. Comparing rather than freezing: the app name must keep
    // following a rename in the Home Connect app.
    const sig = JSON.stringify(deviceObj);
    if (this.deviceObjSig.get(deviceId) !== sig) {
      await this.port.extendObject(deviceId, deviceObj);
      this.deviceObjSig.set(deviceId, sig);
    }
    if (typeof a.type === "string") {
      this.typeByDeviceId.set(deviceId, a.type);
    }
    // The catalog events exist from the first sync on — even for an appliance
    // that is currently switched off (they need no cloud data, only the type).
    await this.ensureEventStates(deviceId);
    await this.setReachable(deviceId, a.connected === true);
    if (a.connected === true) {
      await this.syncApplianceData(deviceId, haId);
    }
  }

  /**
   * Create the catalog events of the appliance's type upfront (value `false`),
   * so no event datapoint first appears only when it first fires. Events can not
   * be enumerated over REST — the catalog (device-catalog.ts) is the only source.
   * An unknown type simply gets none; its events still appear via the stream.
   *
   * @param deviceId the id-safe device path segment
   */
  private async ensureEventStates(deviceId: string): Promise<void> {
    for (const key of eventKeysForType(this.typeByDeviceId.get(deviceId))) {
      const t = transformItem({ key, value: undefined });
      const fullId = `${deviceId}.${t.channel}.${t.id}`;
      const known = this.knownStates.get(fullId);
      if (known) {
        await this.refreshLabel(fullId, known, t.common, t.nameSource);
        continue;
      }
      await this.createState(deviceId, t.channel, t.id, t.common, { bshKey: key }, t.nameSource);
      await this.port.setStateChanged(fullId, { val: false, ack: true });
    }
  }

  /**
   * Create one state object (with its channel) and register it in the in-memory
   * map — the one shared shape behind every state-creating path (items, events,
   * options, buttons, the reachable marker).
   *
   * @param deviceId the id-safe device path segment
   * @param channel the channel the state lives under
   * @param id the within-channel state id
   * @param common the state's `common`
   * @param native the BSH parts for the state's `native`
   * @param native.bshKey the fully-qualified BSH key, when there is one
   * @param native.bshValues the full BSH candidate values of a writable enum
   * @param nameSource where `common.name` came from (remembered in native, so a
   *   later start can tell an auto-name from a rename by the user)
   * @param channelLabel the channel's name when it is none of the fixed channels (a program's statistics)
   * @returns the namespace-relative state id
   */
  private async createState(
    deviceId: string,
    channel: string,
    id: string,
    common: ioBroker.StateCommon,
    native: BshNative,
    nameSource: NameSource,
    channelLabel?: ioBroker.StringOrTranslated,
  ): Promise<string> {
    const fullId = `${deviceId}.${channel}.${id}`;
    // A stop while the definition or list read was on its way: nothing is written
    // past the teardown (the step boundaries alone left the step's own writes).
    if (this.stopped) {
      return fullId;
    }
    // A channel is written once per run, not once per datapoint created in it
    // (the status channel of a fresh appliance was written dozens of times).
    // Its name is kept current at start (refreshChannelNames).
    if (!this.writtenChannels.has(`${deviceId}.${channel}`)) {
      await this.port.extendObject(`${deviceId}.${channel}`, {
        type: "channel",
        common: { name: channelLabel ?? channelName(channel) },
        native: {},
      });
      this.writtenChannels.add(`${deviceId}.${channel}`);
    }
    await this.port.extendObject(fullId, {
      type: "state",
      common,
      native: { ...native, nameSource },
    });
    this.knownStates.set(fullId, {
      bshKey: native.bshKey,
      bshValues: native.bshValues,
      metaSig: metaSignature(common, native),
      type: common.type,
      name: common.name,
      nameSource,
      desc: common.desc,
      hasStates: common.states !== undefined,
      hasValues: native.bshValues !== undefined,
      seenValues: native.seenValues,
    });
    return fullId;
  }

  /**
   * Bring a known state's display name and desc up to date — once, guarded by
   * the in-memory record, so it never turns into per-event object churn.
   *
   * The adapter owns its datapoints: whatever stands in the DB, the current
   * label wins (a user's own datapoints live under 0_userdata). The only
   * precedence is the adapter's own: a label derived from the id never
   * replaces the cloud's localized text.
   *
   * @param fullId the namespace-relative state id
   * @param known its in-memory record (updated in place)
   * @param common the freshly transformed `common` (name + desc)
   * @param nameSource where the fresh name came from
   */
  private async refreshLabel(
    fullId: string,
    known: KnownState,
    common: ioBroker.StateCommon,
    nameSource: NameSource,
  ): Promise<void> {
    const fresh = common.name;
    // What the record says BEFORE this attempt — the state the database is still
    // in if the write below does not land. Taken here, before the patch is built:
    // the record is updated as the patch grows.
    const previousName = known.name;
    const previousDesc = known.desc;
    const previousSource = known.nameSource;
    // A derived label never replaces a name the cloud gave — but the
    // EXPLANATION belongs to the adapter either way, so the guard covers the
    // name only (an object of an older version carries the cloud name plus the
    // manufacturer's key as desc; the key has to go).
    const nameWins = !(nameSource === "derived" && known.nameSource === "api");
    const patch: { common?: Partial<ioBroker.StateCommon>; native?: Record<string, unknown> } = {};
    if (nameWins && !sameName(known.name, fresh)) {
      patch.common = { name: fresh };
      known.name = fresh;
    }
    // The adapter owns the explanation: whatever stands in the DB, the current
    // text wins — that is how a tree written by an older version loses the
    // manufacturer's key and gets a readable sentence instead.
    if (common.desc !== undefined && !sameName(known.desc, common.desc)) {
      patch.common = { ...patch.common, desc: common.desc };
      known.desc = common.desc;
    } else if (common.desc === undefined && known.desc !== undefined) {
      // Nothing to explain about this one — then nothing may stand there. An
      // older version left the manufacturer's key behind; `null` removes it
      // (a merge never drops a field on its own).
      patch.common = { ...patch.common, desc: null } as unknown as Partial<ioBroker.StateCommon>;
      known.desc = undefined;
    }
    if (nameWins && known.nameSource !== nameSource) {
      patch.native = { nameSource };
      known.nameSource = nameSource;
    }
    if (patch.common || patch.native) {
      try {
        await this.port.extendObject(fullId, patch);
      } catch (e) {
        // A write that failed must not be remembered as done. The record is the
        // only guard against per-start object churn, so leaving it on the fresh
        // value made every later pass of the SAME run skip the datapoint — it
        // kept the bare id and lost its explanation until the next adapter
        // start. Rolling the record back to the database's state is what arms
        // the retry; same rule as the metadata refresh in applyTransformedState.
        known.name = previousName;
        known.desc = previousDesc;
        known.nameSource = previousSource;
        this.port.log.debug(`updating the label of ${fullId} failed: ${errMessage(e)}`);
      }
    }
  }

  /**
   * Create (once) and set the per-device online indicator, fed by the appliance
   * list's `connected` flag and the CONNECTED / DISCONNECTED / DEPAIRED stream
   * events — so stale values are distinguishable from live ones.
   *
   * @param deviceId the id-safe device path segment
   * @param reachable whether the appliance is currently connected to Home Connect
   */
  private async setReachable(deviceId: string, reachable: boolean): Promise<void> {
    if (reachable && this.stopped) {
      // An "online" that lands after the teardown's offline stamp would leave
      // the appliance green while the adapter is off. Offline stays allowed.
      return;
    }
    const fullId = `${deviceId}.info.reachable`;
    const common: ioBroker.StateCommon = {
      name: tName("reachable"),
      desc: tName("reachableDesc"),
      type: "boolean",
      role: "indicator.reachable",
      read: true,
      write: false,
      def: false,
    };
    const known = this.knownStates.get(fullId);
    if (known) {
      // The marker carries no BSH key, so the label repair at priming skips it —
      // a tree from an older version has the bare id standing here.
      await this.refreshLabel(fullId, known, common, "i18n");
    } else {
      await this.createState(deviceId, "info", "reachable", common, {}, "i18n");
    }
    // An online/offline transition logs at debug (fleet convention: routine
    // per-device connectivity is not info material — the tree's green/grey dot
    // and info.devicesOnline carry it; debug keeps it traceable in bug reports).
    const previous = this.reachableByDeviceId.get(deviceId);
    if (previous !== undefined && previous !== reachable) {
      this.port.log.debug(`Appliance ${this.label(deviceId)} is now ${reachable ? "online" : "offline"}.`);
    }
    await this.port.setStateChanged(fullId, { val: reachable, ack: true });
    this.reachableByDeviceId.set(deviceId, reachable);
    if (!this.rollupBatched) {
      await this.writeDeviceRollup();
    }
  }

  /**
   * Write the instance-level summary of how many appliances there are and how
   * many of them are connected to Home Connect.
   *
   * Derived here because every marker write goes through `setReachable` — a
   * second place doing the counting would drift away from the per-device values.
   *
   * `devicesTotal` deliberately keeps its value while the adapter is stopped: how
   * many appliances are paired does not change because the adapter is off, and a
   * `0` there would read as "nothing paired". `devicesAllOnline` needs at least
   * one appliance, otherwise an account without a single one would report that
   * all of them are connected.
   */
  private async writeDeviceRollup(): Promise<void> {
    const values = [...this.reachableByDeviceId.values()];
    const online = values.filter(Boolean).length;
    await this.port.setStateChanged("info.devicesTotal", { val: values.length, ack: true });
    await this.port.setStateChanged("info.devicesOnline", { val: online, ack: true });
    await this.port.setStateChanged("info.devicesAllOnline", {
      val: values.length > 0 && online === values.length,
      ack: true,
    });
  }

  /**
   * Mark every known appliance as not reachable.
   *
   * Two moments need this and neither may wait for the cloud: start-up (the
   * previous run's values survive in the database, and the appliance list can
   * fail to arrive — an expired token, no internet — in which case nothing would
   * ever correct a stale "reachable") and shutdown (nothing else resets them).
   */
  async markAllUnreachable(): Promise<void> {
    this.rollupBatched = true;
    try {
      for (const deviceId of this.haIdByDeviceId.keys()) {
        await this.setReachable(deviceId, false);
      }
    } finally {
      this.rollupBatched = false;
    }
    await this.writeDeviceRollup();
  }

  /**
   * Drop an appliance that is no longer in the Home Connect account: its whole
   * object tree goes, along with every in-memory trace of it.
   *
   * What is not on the account is not there any more (krobi 2026-08-27) — keeping
   * the tree would leave datapoints that can never update again, and would keep
   * the appliance in the instance summary as permanently offline.
   *
   * @param deviceId the device id to remove
   * @param haId its Home Connect appliance id
   */
  private async removeAppliance(deviceId: string, haId: string): Promise<void> {
    try {
      await this.port.delObjectRecursive(deviceId);
      this.forgetWritten(deviceId);
    } catch (e) {
      this.port.log.debug(`removing the object tree of ${deviceId} failed: ${errMessage(e)}`);
    }
    this.deviceIdByHaId.delete(haId);
    this.haIdByDeviceId.delete(deviceId);
    this.optionKeys.delete(deviceId);
    this.reachableByDeviceId.delete(deviceId);
    this.typeByDeviceId.delete(deviceId);
    this.nameByDeviceId.delete(deviceId);
    this.programDefs.delete(deviceId);
    this.unsupportedPrograms.delete(haId);
    this.cancelNotReadyRetry(deviceId);
    this.notReady.delete(deviceId);
    this.resyncPending.delete(deviceId);
    this.passStartedAt.delete(deviceId);
    for (const key of [...this.failedDefs.keys()]) {
      if (key.startsWith(`${deviceId}|`)) {
        this.failedDefs.delete(key);
      }
    }
    // Without this a re-paired appliance matched its old signature and its device
    // object was never written again: channels and states under a missing parent,
    // no online marker link — until the next adapter start.
    this.deviceObjSig.delete(deviceId);
    for (const key of [...this.lastStreamAt.keys()]) {
      if (key.startsWith(`${deviceId}|`)) {
        this.lastStreamAt.delete(key);
      }
    }
    this.settingDefs.delete(deviceId);
    this.settingDefsDirty.delete(deviceId);
    this.armedProgramByDeviceId.delete(deviceId);
    this.idDecided.delete(deviceId);
    for (const rel of [...this.knownStates.keys()]) {
      if (rel === deviceId || rel.startsWith(`${deviceId}.`)) {
        this.knownStates.delete(rel);
      }
    }
    await this.writeDeviceRollup();
  }

  /**
   * Assign the device id of an appliance seen for the first time: its model and the last four
   * characters of its own number ({@link deviceIdFor}); an appliance of the same model whose number
   * ends alike already holds that id, so this one gets the whole number. Decided once — the device
   * object carries it with the mark `native.idScheme`, priming pins it, and a later rename in the app
   * changes only the display name, never the folder.
   *
   * @param a the appliance record
   * @param haId its haId
   * @param name its display name (for the one-time log line)
   * @returns the assigned device id
   */
  private assignDeviceId(a: Record<string, unknown>, haId: string, name: string): string {
    const deviceId = deviceIdFor({ haId, vib: a.vib, enumber: a.enumber, type: a.type }, this.takenDeviceIds());
    this.deviceIdByHaId.set(haId, deviceId);
    this.haIdByDeviceId.set(deviceId, haId);
    this.nameByDeviceId.set(deviceId, name);
    this.idDecided.add(deviceId);
    this.port.log.info(`New appliance ${this.label(deviceId)} — creating its tree.`);
    return deviceId;
  }

  /**
   * Every device id that is in use or reserved: the appliances known to this run, and the trees of
   * the previous adapter generation that still wait for their appliance.
   *
   * @returns the ids a new appliance must not take
   */
  private takenDeviceIds(): Set<string> {
    return new Set([...this.haIdByDeviceId.keys(), ...this.pendingLegacyRoots]);
  }

  /**
   * Sync a connected appliance's full data tree. Serialised per device so
   * overlapping CONNECTED / re-sync events don't double-fetch or race the maps.
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   */
  private async syncApplianceData(deviceId: string, haId: string): Promise<void> {
    if (this.syncing.has(deviceId)) {
      return;
    }
    this.syncing.add(deviceId);
    this.notReady.delete(deviceId);
    this.passStartedAt.set(deviceId, Date.now());
    try {
      const steps: Array<() => Promise<void>> = [
        () => this.syncItems(deviceId, haId, "/status", "status"),
        () => this.syncItems(deviceId, haId, "/settings", "settings"),
        () => this.syncPrograms(deviceId, haId),
        // The status came before the program list: the datapoints that name a
        // program by its number are drawn again against the list now complete, so
        // the next pass finds nothing to change.
        () => this.drawProgramNames(deviceId),
        () => this.ensureCommands(deviceId, haId),
      ];
      for (const step of steps) {
        // Mirrors the start-up chain in main: a stop between two cloud reads
        // ends the pass here instead of writing on past the teardown. Same for an
        // appliance removed from the account meanwhile (DEPAIRED): writing on
        // left orphans without a device object that nothing ever removed.
        if (this.stopped || this.haIdByDeviceId.get(deviceId) !== haId) {
          return;
        }
        await step();
        // An appliance still initializing answers every read the same way — the
        // rest of the pass would only repeat it. It is read again on its own.
        if (this.notReady.has(deviceId)) {
          this.scheduleNotReadyRetry(deviceId, haId);
          return;
        }
      }
      // A full read: a "not ready" re-read still armed from an earlier pass has
      // nothing left to do (it cost a second full pass of six requests).
      this.cancelNotReadyRetry(deviceId);
      // Every datapoint the appliance has exists now — the tree the previous adapter
      // generation built for it can hand over what the user attached to it.
      await this.adoptLegacyTree(deviceId, haId);
    } finally {
      this.syncing.delete(deviceId);
      if (this.resyncPending.delete(deviceId) && !this.stopped && this.haIdByDeviceId.get(deviceId) === haId) {
        void this.guarded(() => this.syncApplianceData(deviceId, haId));
      }
    }
  }

  /**
   * Arm the next re-read of an appliance that answered "not ready", on the
   * {@link NOT_READY_RETRY_MS} back-off; after the last stage the adapter waits
   * for the appliance's next reconnect. All on debug: an appliance that is not
   * ready is a state, not a log line.
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   */
  private scheduleNotReadyRetry(deviceId: string, haId: string): void {
    if (this.stopped || this.retryTimers.has(deviceId)) {
      return;
    }
    if (this.reachableByDeviceId.get(deviceId) === false) {
      // Went offline while the read was on its way: its next CONNECTED reads it.
      // A re-read now would only meet an offline appliance.
      this.retryAttempts.delete(deviceId);
      return;
    }
    const attempt = this.retryAttempts.get(deviceId) ?? 0;
    if (attempt >= NOT_READY_RETRY_MS.length) {
      this.retryAttempts.delete(deviceId);
      this.port.log.debug(
        `${this.label(deviceId)} did not finish connecting — its data is read on its next reconnect.`,
      );
      return;
    }
    const delay = NOT_READY_RETRY_MS[attempt];
    this.retryAttempts.set(deviceId, attempt + 1);
    this.port.log.debug(`${this.label(deviceId)} is still initializing — reading it again in ${delay / 1000} s.`);
    this.retryTimers.set(
      deviceId,
      this.port.setTimer(() => {
        this.retryTimers.delete(deviceId);
        if (this.reachableByDeviceId.get(deviceId) === false) {
          this.retryAttempts.delete(deviceId);
          return;
        }
        void this.guarded(() => this.syncApplianceData(deviceId, haId));
      }, delay),
    );
  }

  /**
   * Drop an appliance's pending "not ready" re-read and its back-off.
   *
   * @param deviceId the id-safe device path segment
   */
  private cancelNotReadyRetry(deviceId: string): void {
    const handle = this.retryTimers.get(deviceId);
    if (handle !== undefined) {
      this.port.clearTimer(handle);
      this.retryTimers.delete(deviceId);
    }
    this.retryAttempts.delete(deviceId);
  }

  /**
   * Fetch a status/settings list, transform each item, and create the object +
   * set the value under the speaking channel/id.
   *
   * Deliberately NO pruning of states missing from the response: the cloud
   * reports a state-dependent SUBSET (a switched-off washer in network standby
   * answers with `powerState` only), so "not in this response" never means "the
   * appliance does not have it". Appliance capabilities do not change — every
   * datapoint stays once created; only removing an appliance from the account
   * deletes its tree.
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   * @param subpath the endpoint sub-path, e.g. "/status"
   * @param arrayKey the array field in the response body, e.g. "status"
   */
  private async syncItems(deviceId: string, haId: string, subpath: string, arrayKey: string): Promise<void> {
    const data = await this.port.apiGet(appliancePath(haId, subpath));
    if (!isRecord(data) || !Array.isArray(data[arrayKey])) {
      return;
    }
    const isSettings = arrayKey === "settings";
    for (const raw of data[arrayKey]) {
      // A single-setting read that met "not ready" ends the loop — every further
      // one would only get the same answer.
      if (this.notReady.has(deviceId)) {
        break;
      }
      // An appliance-internal key never becomes a datapoint — not even its definition is read (decision 48).
      if (isRecord(raw) && !(typeof raw.key === "string" && isDeviceInternalKey(raw.key))) {
        await this.applyBshItem(deviceId, isSettings ? await this.withSettingDef(deviceId, haId, raw) : raw, "sync");
      }
    }
    if (isSettings) {
      await this.persistSettingDefs(deviceId);
    }
  }

  /**
   * Complete one settings list entry with the fields only the single-setting
   * endpoint carries (type, allowed values, bounds) — see {@link SettingDef}.
   *
   * Without them a writable enum ends up with its own current value as the ONLY
   * write candidate, so the adapter cannot switch it (an appliance sitting at
   * `off` could not be turned on), and a numeric setting reaches Admin/VIS with
   * no range at all.
   *
   * One request per setting per appliance, then never again — the cache lives in
   * the device object's native. **Strictly sequential**, like
   * {@link syncProgramDefs}: that is what keeps the burst limit (10/s, whose 429
   * arrives with no `Retry-After`) out of reach; a 429 would still land in the
   * transport's existing rate pause. A failed fetch leaves the entry uncached and
   * is retried on a later sync rather than being remembered as "has none".
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   * @param raw the raw settings list entry
   * @returns the entry, with the definition fields merged in when available
   */
  private async withSettingDef(
    deviceId: string,
    haId: string,
    raw: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (typeof raw.key !== "string") {
      return raw;
    }
    const cached = this.settingDefs.get(deviceId) ?? {};
    this.settingDefs.set(deviceId, cached);
    let def = cached[raw.key];
    if (!def) {
      if (!this.mayFetchDef(deviceId, raw.key)) {
        return raw;
      }
      const path = appliancePath(haId, `/settings/${encodeURIComponent(raw.key)}`);
      const single = await this.port.apiGet(path);
      if (!isRecord(single)) {
        this.noteDefMiss(deviceId, raw.key, path);
        return raw;
      }
      def = {
        constraints: isRecord(single.constraints) ? single.constraints : undefined,
        type: typeof single.type === "string" ? single.type : undefined,
      };
      cached[raw.key] = def;
      this.settingDefsDirty.add(deviceId);
    }
    // The list owns the value; the cache owns only the static fields.
    return { ...raw, ...(def.type === undefined ? {} : { type: def.type }), constraints: def.constraints };
  }

  /**
   * Persist the setting definitions of one appliance — once per sync, not per
   * setting, and only when something was actually fetched.
   *
   * @param deviceId the id-safe device path segment
   */
  private async persistSettingDefs(deviceId: string): Promise<void> {
    if (this.stopped || !this.settingDefsDirty.delete(deviceId)) {
      return;
    }
    try {
      // Internal attribute on the device object (not a datapoint): survives restarts.
      await this.port.extendObject(deviceId, { native: { settingDefs: this.settingDefs.get(deviceId) ?? {} } });
    } catch (e) {
      // Keeping it uncached costs one fetch per setting on the next start — far
      // better than remembering a definition the database never accepted.
      this.settingDefsDirty.add(deviceId);
      this.port.log.debug(`persisting the setting definition cache of ${deviceId} failed: ${errMessage(e)}`);
    }
  }

  /**
   * Transform one raw BSH item and write it under the device's speaking tree
   * (usually one state; a door status or the operation state expand to several).
   * A new state creates the channel + object; a known one normally only updates
   * the value. A REST-sourced item additionally refreshes the object's metadata
   * when it changed (new allowed values, changed bounds, improved transform in a
   * newer adapter version) — stream events never touch objects, so the old
   * adapter's object-tree flood (#387) stays impossible.
   *
   * @param deviceId the id-safe device path segment
   * @param raw the raw status / setting / event item
   * @param source "sync" for a REST sync that owns the metadata; "values" for
   *   value-only items (stream events, and a program's option values — whose
   *   object shape is owned by the option *definition*, not the value item)
   */
  private async applyBshItem(deviceId: string, raw: Record<string, unknown>, source: "sync" | "values"): Promise<void> {
    if (this.stopped || typeof raw.key !== "string") {
      return;
    }
    // The type source declares both program roots as `ProgramKey | null`: for
    // them `null` IS the value "no program" and becomes the idle "" — resolved
    // ONCE here, so the datapoint below and the gate branch further down see the
    // same value. Every other key keeps the general rule: `null` is not a value
    // and writes nothing (see the transformer's fallback).
    const value =
      (raw.key === SELECTED_PROGRAM_KEY || raw.key === ACTIVE_PROGRAM_KEY) && raw.value === null ? "" : raw.value;
    const lockableDoor = LOCKABLE_DOOR_TYPES.has(this.typeByDeviceId.get(deviceId) ?? "");
    // A REST answer that was requested before the stream delivered a newer value
    // for the same key must not put the older one back (a CONNECTED runs both
    // side by side). Its metadata still counts; its value does not.
    const staleRead =
      source === "sync" &&
      (this.lastStreamAt.get(`${deviceId}|${raw.key}`) ?? -1) >= (this.passStartedAt.get(deviceId) ?? Infinity);
    if (isProgramRecordKey(raw.key)) {
      // An encoded record never becomes a datapoint of its own: it is decoded
      // into readable ones (decision 40).
      await this.applyProgramRecord(deviceId, raw.key, value);
      return;
    }
    // The operation state decides at once whether a program is under way — before any await, so a run value
    // the stream sends right after it is judged by the new state (decision 48).
    const restingNow =
      raw.key === OPERATION_STATE_KEY &&
      typeof value === "string" &&
      !staleRead &&
      this.noteOperationState(deviceId, value);
    if (raw.key === ACTIVE_PROGRAM_KEY && typeof value === "string" && !staleRead) {
      this.noteRunningProgram(deviceId, value);
    }
    const { channel: itemChannel, id: itemId } = stateIdForKey(raw.key);
    const programRoot = raw.key === SELECTED_PROGRAM_KEY || raw.key === ACTIVE_PROGRAM_KEY;
    let constraints = parseConstraints(raw.constraints);
    if (!programRoot && !constraints?.allowedvalues) {
      // An answer without the list (a response carries only what the appliance
      // reports right now; a single-setting read can fail) keeps the list the
      // cloud gave before — neither the catalogue nor the bare value replaces it.
      const kept = this.knownStates.get(`${deviceId}.${itemChannel}.${itemId}`)?.bshValues;
      if (kept && kept.length > 0) {
        constraints = { ...constraints, allowedvalues: kept };
      }
    }
    if (raw.key === ACTIVE_PROGRAM_KEY && !constraints?.allowedvalues) {
      // The running program reads from the same list the selection offers — one
      // list for both, or the running program would show as a bare short value.
      const offered = this.knownStates.get(`${deviceId}.programs.selectedProgram`)?.bshValues;
      if (offered && offered.length > 0) {
        constraints = { ...constraints, allowedvalues: offered };
      }
    }
    const states = expandBshItem(
      {
        key: raw.key,
        name: typeof raw.name === "string" ? raw.name : undefined,
        value,
        unit: typeof raw.unit === "string" ? raw.unit : undefined,
        constraints,
        lang: this.port.language,
        seen: programRoot
          ? this.seenPrograms(deviceId)
          : this.knownStates.get(`${deviceId}.${itemChannel}.${itemId}`)?.seenValues,
      },
      lockableDoor,
    );
    for (const t of states) {
      // A value from the stream (or without a list) comes as the bare last
      // segment; within the datapoint's own list that segment may name two
      // programs. The list-unique form keeps the value in the dropdown and the
      // write path unambiguous (see shortEnumIn). Options keep the bare segment.
      if (staleRead) {
        t.value = undefined;
      }
      if (t.channel !== "options" && typeof value === "string" && t.value === shortEnum(value) && value.includes(".")) {
        // The datapoint's list first: a value-only item brings no list, and the
        // transformer's fallback candidate set is just the value itself.
        const known = this.knownStates.get(`${deviceId}.${t.channel}.${t.id}`);
        const candidates = [
          ...(known?.bshValues ??
            t.bshValues ??
            (raw.key === ACTIVE_PROGRAM_KEY
              ? this.knownStates.get(`${deviceId}.programs.selectedProgram`)?.bshValues
              : undefined) ??
            []),
          ...(programRoot ? this.seenPrograms(deviceId) : (known?.seenValues ?? [])),
        ];
        if (candidates.length > 0) {
          t.value = shortEnumIn(value, [...new Set([...candidates, value])]);
        }
      }
      // A value-less item (key only, or `null` outside the program roots) cannot
      // say what type its datapoint has — the transformer falls back to text. Its
      // metadata would turn a number or a switch into a string (and a write of
      // 40 would go out as "40"), and the next item with a value would turn it
      // back: one object write per alternation. It refreshes nothing.
      const valueless = value === undefined || value === null;
      if (RUN_VALUE_KEYS.has(raw.key) && this.atRest.has(deviceId)) {
        // A value left over from the last run: the metadata still counts, the value is not shown (decision 48).
        t.value = undefined;
      }
      await this.applyTransformedState(deviceId, raw.key, t, valueless && !staleRead ? "values" : source);
    }
    if (restingNow) {
      await this.emptyRunValues(deviceId);
    }
    // A program the user chose AT THE APPLIANCE arrives here as a plain value
    // item — and only here is the FULL program key still available: the state it
    // becomes carries the short value ("intensiv70"), which the write gate
    // cannot use. Without re-arming, the gate stays on the previously selected
    // program: its options would be refused as "not writable" while the old
    // program's options are sent along with a start of the new one.
    if (raw.key === SELECTED_PROGRAM_KEY && typeof value === "string" && !staleRead) {
      if (value.length === 0) {
        // DESELECTED at the appliance — the mirror image of arming. The gate used
        // to stay armed for the program that was just dropped, so the adapter
        // sent its options to the cloud with no program selected at all: one
        // wasted request answered `SDK.Error.NoProgramSelected`, which `apiWrite`
        // reports as a warning for a situation the adapter could have known.
        this.optionKeys.delete(deviceId);
        this.armedProgramByDeviceId.delete(deviceId);
      } else {
        const haId = this.haIdByDeviceId.get(deviceId);
        if (haId) {
          await this.activateProgramOptions(deviceId, haId, value);
        }
      }
    }
  }

  /**
   * Whether a written value names a program the appliance only RAN — one in the
   * list, but not among the programs the cloud offers for selection.
   *
   * @param deviceId the id-safe device path segment
   * @param value the written value
   * @returns whether it is such a program
   */
  private isSeenOnlyProgram(deviceId: string, value: ioBroker.StateValue): boolean {
    if (typeof value !== "string") {
      return false;
    }
    const offered = this.knownStates.get(`${deviceId}.programs.selectedProgram`)?.bshValues ?? [];
    const seen = this.seenPrograms(deviceId).filter(v => !offered.includes(v));
    const full = [...offered, ...seen];
    const wanted = value.toLowerCase();
    return seen.some(v => v.toLowerCase() === wanted || shortEnumIn(v, full) === wanted || shortEnum(v) === wanted);
  }

  // ─── encoded program records → readable datapoints (decision 40) ───────────

  /**
   * Remember the program that is running — the anchor a run summary is paired
   * with to learn the appliance's number for it. "" (idle) keeps the last one:
   * the summary of a run arrives when the run is over.
   *
   * @param deviceId the id-safe device path segment
   * @param value the full program key of the active program, "" when idle
   */
  private noteRunningProgram(deviceId: string, value: string): void {
    if (value.length === 0 || this.runningProgram.get(deviceId)?.key === value) {
      return;
    }
    this.runningProgram.set(deviceId, { key: value, since: Date.now() });
  }

  /**
   * The decoded records of one appliance.
   *
   * @param deviceId the id-safe device path segment
   * @returns its record store
   */
  private recordsOf(deviceId: string): DeviceRecords {
    let rec = this.records.get(deviceId);
    if (!rec) {
      rec = { details: new Map() };
      this.records.set(deviceId, rec);
    }
    return rec;
  }

  /**
   * Decode one encoded record and draw the readable datapoints it feeds. A value
   * of a shape the decoder does not know writes nothing — never the raw text —
   * and is reported once a run, so the format can be added.
   *
   * @param deviceId the id-safe device path segment
   * @param key the record's BSH key
   * @param value the raw value
   */
  private async applyProgramRecord(deviceId: string, key: string, value: unknown): Promise<void> {
    if (value === undefined || value === null) {
      return;
    }
    const rec = this.recordsOf(deviceId);
    if (key === HISTORY_UID_KEY) {
      const uids = decodeHistoryUids(value);
      if (!uids) {
        return this.reportUnreadable(deviceId, key, value);
      }
      rec.uids = uids;
      // Inside a device pass the program list is read AFTER the status: the pass
      // draws the program names once it is complete (drawProgramNames) — drawing
      // here as well cost every first start one extra object write per datapoint.
      if (!this.syncing.has(deviceId)) {
        await this.drawHistoryPrograms(deviceId);
      }
    } else if (key === HISTORY_TIME_KEY) {
      const minutes = decodeHistoryMinutes(value);
      if (!minutes) {
        return this.reportUnreadable(deviceId, key, value);
      }
      rec.minutes = minutes;
      await this.drawHistoryDurations(deviceId);
    } else if (PROGRAM_DETAILS_RE.test(key)) {
      const details = decodeProgramDetails(value);
      if (!details) {
        return this.reportUnreadable(deviceId, key, value);
      }
      rec.details.set(details.uid, details);
      await this.drawStatistics(deviceId, details);
    } else if (key === SESSION_SUMMARY_KEY) {
      const summary = decodeSessionSummary(value);
      if (!summary) {
        return this.reportUnreadable(deviceId, key, value);
      }
      rec.summary = summary;
      await this.learnProgramUid(deviceId, summary);
      if (!this.syncing.has(deviceId)) {
        await this.drawLastRun(deviceId);
      }
    } else if (FAVORITE_PROGRAM_RE.test(key)) {
      const uid = decodeFavoriteProgram(value);
      if (uid === undefined) {
        return this.reportUnreadable(deviceId, key, value);
      }
      const slot = FAVORITE_PROGRAM_RE.exec(key)?.[1] ?? "";
      await this.applyRecordState(
        deviceId,
        "settings",
        `favorite${slot}Program`,
        {
          name: tName("favProgram", slot),
          desc: tName("favProgramDesc"),
          type: "string",
          role: "text",
          states: this.programStates(deviceId, [uid]),
        },
        this.programValue(deviceId, uid),
      );
    } else if (key === ERROR_CODES_KEY) {
      const codes = decodeErrorCodes(value);
      if (codes === undefined) {
        return this.reportUnreadable(deviceId, key, value);
      }
      await this.applyRecordState(
        deviceId,
        "status",
        "errorCodes",
        { name: tName("stErrorCodes"), desc: tName("errorCodesDesc"), type: "string", role: "text" },
        codes,
      );
      // What a script reacts to is whether there IS a fault — its own datapoint,
      // never something to parse out of the code text.
      await this.applyRecordState(
        deviceId,
        "status",
        "faultActive",
        { name: tName("stFaultActive"), desc: tName("faultActiveDesc"), type: "boolean", role: "indicator.error" },
        codes.length > 0,
      );
    }
  }

  /**
   * One line, once a run and record, for a value the adapter cannot read — the
   * datapoint stays away rather than showing the raw text.
   *
   * @param deviceId the id-safe device path segment
   * @param key the record's BSH key
   * @param value the raw value
   */
  private reportUnreadable(deviceId: string, key: string, value: unknown): void {
    const family = PROGRAM_DETAILS_RE.test(key) ? "LaundryCare.Common.Status.Program.Details.*" : key;
    if (this.unreadableRecords.has(`${deviceId}|${family}`)) {
      return;
    }
    this.unreadableRecords.add(`${deviceId}|${family}`);
    const shown = typeof value === "string" ? value.slice(0, 200) : JSON.stringify(value);
    this.port.log.info(
      `${deviceId}: ${key} came in a form the adapter cannot read yet, so it is not shown: ${shown} — please report it at https://github.com/krobipd/ioBroker.homeconnect/issues`,
    );
  }

  /**
   * Create/refresh one datapoint the adapter derives itself (no BSH key of its
   * own — a decoded record must never look like a mapped key to the start-up
   * repairs) and set its value.
   *
   * @param deviceId the id-safe device path segment
   * @param channel the channel path (may be nested: `statistics.cotton`)
   * @param id the within-channel id
   * @param shape the name, desc, type, role and optional unit / list
   * @param value the value to set
   * @param channelLabel the channel's name, when it is not one of the fixed channels
   */
  private async applyRecordState(
    deviceId: string,
    channel: string,
    id: string,
    shape: Pick<ioBroker.StateCommon, "name" | "desc" | "type" | "role" | "unit" | "states">,
    value: ioBroker.StateValue,
    channelLabel?: ioBroker.StringOrTranslated,
  ): Promise<void> {
    const common: ioBroker.StateCommon = { read: true, write: false, ...shape };
    for (const k of ["unit", "states", "desc"] as const) {
      if (common[k] === undefined) {
        delete common[k];
      }
    }
    await this.applyTransformedState(
      deviceId,
      undefined,
      { channel, id, common, nameSource: "i18n", value },
      "sync",
      channelLabel,
    );
  }

  /**
   * Every program this appliance can be named with: the cloud's offer, the
   * programs it ran, and the ones learned from its program numbers.
   *
   * @param deviceId the id-safe device path segment
   * @returns the full program keys
   */
  private knownPrograms(deviceId: string): string[] {
    const offered = this.knownStates.get(`${deviceId}.programs.selectedProgram`)?.bshValues ?? [];
    return [
      ...new Set([...offered, ...this.seenPrograms(deviceId), ...Object.values(this.programUids.get(deviceId) ?? {})]),
    ];
  }

  /**
   * The value a program number stands for in a datapoint: the program's short
   * value once the number is learned, `program<number>` until then.
   *
   * @param deviceId the id-safe device path segment
   * @param uid the appliance's program number
   * @returns the short value
   */
  private programValue(deviceId: string, uid: number): string {
    const key = this.programKeyFor(deviceId, uid);
    if (!key) {
      return `program${uid}`;
    }
    const all = this.knownPrograms(deviceId);
    return shortEnumIn(key, all.includes(key) ? all : [...all, key]);
  }

  /**
   * The program an appliance number stands for: the one learned on this appliance,
   * else the one the appliances' own descriptions give for its type (program-uids.ts).
   * A described program the cloud also names for this appliance by the same last
   * segment IS that program — the cloud's key is taken, so the value matches the
   * program lists ("…Spin.Spin.SpinDrain" is reported as "…Program.Spin").
   *
   * @param deviceId the id-safe device path segment
   * @param uid the appliance's program number
   * @returns the full program key, or undefined while the number is unknown
   */
  private programKeyFor(deviceId: string, uid: number): string | undefined {
    const learned = this.programUids.get(deviceId)?.[String(uid)];
    if (learned) {
      return learned;
    }
    const described = PROGRAM_UIDS[this.typeByDeviceId.get(deviceId) ?? ""]?.[uid];
    if (!described) {
      return undefined;
    }
    const same = this.knownPrograms(deviceId).filter(k => shortEnum(k) === shortEnum(described));
    return same.length === 1 ? same[0] : described;
  }

  /**
   * The selection list of a datapoint that names a program by its number.
   *
   * @param deviceId the id-safe device path segment
   * @param uids the numbers the datapoints show right now
   * @returns short value → label, in the system language
   */
  private programStates(deviceId: string, uids: readonly number[]): Record<string, string> {
    const lang = this.port.language ?? DEFAULT_LABEL_LANGUAGE;
    const all = this.knownPrograms(deviceId);
    const states: Record<string, string> = {};
    for (const key of all) {
      states[shortEnumIn(key, all)] = valueLabel(key, lang);
    }
    for (const uid of uids) {
      const key = this.programKeyFor(deviceId, uid);
      const value = this.programValue(deviceId, uid);
      if (states[value] === undefined) {
        states[value] = key ? valueLabel(key, lang) : unknownProgramLabel(uid, lang);
      }
    }
    return states;
  }

  /**
   * The `history` folder of an appliance, written once per run — each run below it is a channel of its own.
   *
   * @param deviceId the id-safe device path segment
   */
  private async ensureHistoryFolder(deviceId: string): Promise<void> {
    if (this.historyFolders.has(deviceId)) {
      return;
    }
    await this.port.extendObject(`${deviceId}.history`, {
      type: "folder",
      common: { name: tName("channelHistory") },
      native: {},
    });
    this.historyFolders.add(deviceId);
  }

  /**
   * The channel of the n-th run counted back from the newest, and its name (decision 48).
   *
   * @param n 1 for the newest run
   * @returns the channel path below the device and its label
   */
  private historyRun(n: number): { channel: string; label: ioBroker.StringOrTranslated } {
    return {
      channel: `history.${runSegment(n)}`,
      label: n <= HISTORY_RUN_NAMES.length ? tName(HISTORY_RUN_NAMES[n - 1]) : tName("histRunN", n),
    };
  }

  /**
   * `history.<run>.program` — the programs of the last runs, newest first (`latest`, `previous`, …).
   *
   * @param deviceId the id-safe device path segment
   */
  private async drawHistoryPrograms(deviceId: string): Promise<void> {
    const uids = this.records.get(deviceId)?.uids ?? [];
    if (uids.length === 0) {
      return;
    }
    await this.ensureHistoryFolder(deviceId);
    const states = this.programStates(deviceId, uids);
    for (const [i, uid] of uids.entries()) {
      const n = i + 1;
      const run = this.historyRun(n);
      await this.applyRecordState(
        deviceId,
        run.channel,
        "program",
        {
          name: n <= HISTORY_PROGRAM_NAMES.length ? tName(HISTORY_PROGRAM_NAMES[i]) : tName("histProgramN", n),
          desc: tName("histProgramDesc"),
          type: "string",
          role: "text",
          states,
        },
        this.programValue(deviceId, uid),
        run.label,
      );
    }
  }

  /**
   * Draw the datapoints that name a program by its number again (history, last run).
   *
   * @param deviceId the id-safe device path segment
   */
  private async drawProgramNames(deviceId: string): Promise<void> {
    if (!this.records.has(deviceId)) {
      return;
    }
    await this.drawHistoryPrograms(deviceId);
    await this.drawLastRun(deviceId);
  }

  /**
   * `history.<run>.duration` — how long the last runs took, newest first.
   *
   * @param deviceId the id-safe device path segment
   */
  private async drawHistoryDurations(deviceId: string): Promise<void> {
    // Called right after a history that decoded to at least one run — the decoder never returns an empty list.
    const minutesList = this.records.get(deviceId)?.minutes ?? [];
    await this.ensureHistoryFolder(deviceId);
    for (const [i, minutes] of minutesList.entries()) {
      const n = i + 1;
      const run = this.historyRun(n);
      await this.applyRecordState(
        deviceId,
        run.channel,
        "duration",
        {
          name: n <= HISTORY_DURATION_NAMES.length ? tName(HISTORY_DURATION_NAMES[i]) : tName("histDurationN", n),
          desc: tName("histDurationDesc"),
          type: "number",
          role: "value",
          unit: "min",
        },
        minutes,
        run.label,
      );
    }
  }

  /**
   * The id segment of a program's statistics channel: the last segment of the
   * program's key, `program<number>` while the number is unknown. Never the
   * list-unique short value: that one depends on the program list at hand (two
   * programs ending in "Cotton" make it two segments), and a channel id must not
   * change with it — on an upgrade the list is known before the status is read,
   * on a fresh start after, and the same statistics landed under two ids.
   * Two programs of one appliance ending alike keep apart by their number.
   *
   * @param deviceId the id-safe device path segment
   * @param uid the appliance's program number
   * @returns the channel segment
   */
  private statisticsSegment(deviceId: string, uid: number): string {
    const key = this.programKeyFor(deviceId, uid);
    if (!key) {
      return `program${uid}`;
    }
    const tail = shortEnum(key);
    const others = [...(this.records.get(deviceId)?.details.keys() ?? [])].filter(u => u !== uid);
    const clash = others.some(u => {
      const k = this.programKeyFor(deviceId, u);
      return k !== undefined && shortEnum(k) === tail && u < uid;
    });
    return clash ? `${tail}${uid}` : tail;
  }

  /**
   * `statistics.<program>.completed/started/runtime` — one program's lifetime counters.
   *
   * @param deviceId the id-safe device path segment
   * @param d the decoded counters
   */
  private async drawStatistics(deviceId: string, d: ProgramDetails): Promise<void> {
    const key = this.programKeyFor(deviceId, d.uid);
    const channel = `statistics.${this.statisticsSegment(deviceId, d.uid)}`;
    const label = key ? programLabels(key) : tName("unknownProgram", d.uid);
    if (!this.statisticsFolders.has(deviceId)) {
      await this.port.extendObject(`${deviceId}.statistics`, {
        type: "folder",
        common: { name: tName("channelStatistics") },
        native: {},
      });
      this.statisticsFolders.add(deviceId);
    }
    const counters: Array<[string, I18nKey, I18nKey, number, string | undefined]> = [
      ["completed", "statCompleted", "statCompletedDesc", d.completed, undefined],
      ["started", "statStarted", "statStartedDesc", d.started, undefined],
      ["runtime", "statRuntime", "statRuntimeDesc", Math.round(d.seconds / 360) / 10, "h"],
    ];
    for (const [id, name, desc, value, unit] of counters) {
      // The name carries the program: every program has the same three counters,
      // and two datapoints of one appliance never share a name.
      await this.applyRecordState(
        deviceId,
        channel,
        id,
        {
          name: joinNames(label, tName(name)),
          desc: tName(desc),
          type: "number",
          role: "value",
          ...(unit ? { unit } : {}),
        },
        value,
        label,
      );
    }
  }

  /**
   * `lastRun.*` — the last finished run: program, start, end, duration.
   *
   * @param deviceId the id-safe device path segment
   */
  private async drawLastRun(deviceId: string): Promise<void> {
    const s = this.records.get(deviceId)?.summary;
    if (!s) {
      return;
    }
    await this.applyRecordState(
      deviceId,
      "lastRun",
      "program",
      {
        name: tName("lrProgram"),
        desc: tName("lrProgramDesc"),
        type: "string",
        role: "text",
        states: this.programStates(deviceId, [s.programUid]),
      },
      this.programValue(deviceId, s.programUid),
    );
    await this.applyRecordState(
      deviceId,
      "lastRun",
      "start",
      { name: tName("lrStart"), desc: tName("lrStartDesc"), type: "number", role: "date.start" },
      s.start,
    );
    await this.applyRecordState(
      deviceId,
      "lastRun",
      "end",
      { name: tName("lrEnd"), desc: tName("lrEndDesc"), type: "number", role: "date.end" },
      s.end,
    );
    await this.applyRecordState(
      deviceId,
      "lastRun",
      "duration",
      { name: tName("lrDuration"), desc: tName("lrDurationDesc"), type: "number", role: "value", unit: "min" },
      Math.round((s.end - s.start) / 60_000),
    );
    // The run's own figures, where the appliance reports them (laundry appliances).
    const figures: Array<[string, number, I18nKey, I18nKey, string, string, (v: number) => number]> = [
      ["water", RUN_DETAIL.waterMl, "lrWater", "lrWaterDesc", "l", "value", v => v / 1000],
      [
        "energy",
        RUN_DETAIL.energyWh,
        "lrEnergy",
        "lrEnergyDesc",
        "kWh",
        "value.energy.consumed",
        v => toShown(v, RUN_ENERGY),
      ],
      ["detergent", RUN_DETAIL.detergentMl, "lrDetergent", "lrDetergentDesc", "ml", "value", v => v],
      ["softener", RUN_DETAIL.softenerMl, "lrSoftener", "lrSoftenerDesc", "ml", "value", v => v],
    ];
    for (const [id, uid, name, desc, unit, role, scale] of figures) {
      const v = s.details[uid];
      if (v !== undefined) {
        await this.applyRecordState(
          deviceId,
          "lastRun",
          id,
          { name: tName(name), desc: tName(desc), type: "number", role, unit },
          scale(v),
        );
      }
    }
    const trigger = s.details[RUN_DETAIL.endTrigger];
    const triggerNames = END_TRIGGERS;
    if (trigger !== undefined && triggerNames[trigger] !== undefined) {
      const lang = this.port.language ?? DEFAULT_LABEL_LANGUAGE;
      await this.applyRecordState(
        deviceId,
        "lastRun",
        "endTrigger",
        {
          name: tName("lrEndTrigger"),
          desc: tName("lrEndTriggerDesc"),
          type: "string",
          role: "text",
          states: Object.fromEntries(triggerNames.map(n => [n.toLowerCase(), valueLabel(n, lang)])),
        },
        triggerNames[trigger].toLowerCase(),
      );
    }
  }

  /**
   * Learn which program an appliance number stands for: a run summary names the
   * number of the run that just ended, and the program seen RUNNING inside that
   * run's start and end is that program. Only that pairing counts — a summary read
   * again later (every reconnect reads it) while another program runs must not
   * teach anything, and a number keeps the program it was learned with.
   *
   * @param deviceId the id-safe device path segment
   * @param s the decoded summary
   */
  private async learnProgramUid(deviceId: string, s: SessionSummary): Promise<void> {
    const running = this.runningProgram.get(deviceId);
    if (
      !running ||
      running.since < s.start - RUN_PAIRING_TOLERANCE_MS ||
      running.since > s.end + RUN_PAIRING_TOLERANCE_MS
    ) {
      return;
    }
    const learned = { ...(this.programUids.get(deviceId) ?? {}) };
    const uid = String(s.programUid);
    if (learned[uid] !== undefined) {
      if (learned[uid] !== running.key) {
        this.port.log.debug(
          `${deviceId}: program number ${uid} ran as ${running.key}, but is known as ${learned[uid]} — kept`,
        );
      }
      return;
    }
    if (Object.values(learned).includes(running.key)) {
      this.port.log.debug(`${deviceId}: ${running.key} already has a program number — ${uid} not taken`);
      return;
    }
    // Where its statistics stand until now: `program<number>`, or the name the
    // appliances' descriptions gave — the move below starts from there.
    const before = this.statisticsSegment(deviceId, s.programUid);
    learned[uid] = running.key;
    this.programUids.set(deviceId, learned);
    try {
      await this.port.extendObject(deviceId, { native: { programUids: learned } });
    } catch (e) {
      this.port.log.debug(`storing the program numbers of ${deviceId} failed: ${errMessage(e)}`);
    }
    this.port.log.debug(`${deviceId}: program number ${uid} is ${running.key}`);
    await this.moveStatistics(deviceId, s.programUid, before);
    await this.drawHistoryPrograms(deviceId);
  }

  /**
   * A program number just got its program: its statistics channel moves from
   * where it stood (`program<number>`, or a described name the appliance reports
   * differently) to the program's name, carrying recordings, aliases, rooms and
   * functions (the tree-move helpers of decision 36), and is drawn again.
   *
   * @param deviceId the id-safe device path segment
   * @param uid the appliance's program number
   * @param before the channel segment the statistics stood under until now
   */
  private async moveStatistics(deviceId: string, uid: number, before: string): Promise<void> {
    const from = `${deviceId}.statistics.${before}`;
    const to = `${deviceId}.statistics.${this.statisticsSegment(deviceId, uid)}`;
    const details = this.records.get(deviceId)?.details.get(uid);
    const moving = [...this.knownStates.keys()].some(id => id.startsWith(`${from}.`));
    if (moving && from !== to) {
      try {
        await copyDeviceTree(this.moveDeps(), from, to);
        const ns = this.port.namespace;
        const carry = new Map<string, string[]>();
        for (const id of [...this.knownStates.keys()].filter(k => k === from || k.startsWith(`${from}.`))) {
          const next = movedId(`${ns}.${id}`, `${ns}.${from}`, `${ns}.${to}`);
          if (next) {
            carry.set(`${ns}.${id}`, [next]);
          }
          this.knownStates.delete(id);
        }
        await this.port.deleteTreeCarryingEnums(from, carry);
        this.forgetWritten(from);
        // Drawing below writes the copies once more, by MERGE: the recording
        // configuration the copy carries stays, the names become the program's.
      } catch (e) {
        this.port.log.warn(`moving ${from} to ${to} failed: ${errMessage(e)} — tried again on the next start`);
      }
    }
    if (details) {
      await this.drawStatistics(deviceId, details);
    }
  }

  /**
   * Forget the once-per-run write marks below a deleted tree: a tree built again
   * in the same run (an appliance paired again, a moved tree) needs its channels
   * and statistics folder written again.
   *
   * @param rel the namespace-relative root that was deleted
   */
  private forgetWritten(rel: string): void {
    for (const path of [...this.writtenChannels]) {
      if (path === rel || path.startsWith(`${rel}.`)) {
        this.writtenChannels.delete(path);
      }
    }
    for (const deviceId of [...this.historyFolders]) {
      const folder = `${deviceId}.history`;
      if (folder === rel || folder.startsWith(`${rel}.`)) {
        this.historyFolders.delete(deviceId);
      }
    }
    for (const deviceId of [...this.statisticsFolders]) {
      const folder = `${deviceId}.statistics`;
      if (folder === rel || folder.startsWith(`${rel}.`)) {
        this.statisticsFolders.delete(deviceId);
      }
    }
  }

  /**
   * The programs an appliance ran that its selection list did not name — kept by
   * the selected AND the running program, and handed to both, so the two
   * datapoints show one list.
   *
   * @param deviceId the id-safe device path segment
   * @returns the full program keys, in the order they were first seen
   */
  private seenPrograms(deviceId: string): string[] {
    const selected = this.knownStates.get(`${deviceId}.programs.selectedProgram`)?.seenValues ?? [];
    const active = this.knownStates.get(`${deviceId}.programs.activeProgram`)?.seenValues ?? [];
    return [...new Set([...selected, ...active])];
  }

  /**
   * A value arrived that the datapoint's list does not name (a program chosen at
   * the appliance, a process phase no source lists). Its label is ADDED to the
   * object once — a merge adds keys, so nothing is cleared and nothing else is
   * touched — and the value joins `native.seenValues`, so every later transform
   * keeps it in the list. This is the only object write a value item can cause,
   * and it happens once per new value, never per event.
   *
   * @param fullId the namespace-relative state id
   * @param known its in-memory record
   * @param t the transformed state carrying the grown `seenValues`
   */
  private async addSeenValue(fullId: string, known: KnownState, t: TransformedState): Promise<void> {
    const before = known.seenValues ?? [];
    const grown = t.seenValues ?? [];
    const added = grown.filter(v => !before.includes(v));
    const states = t.common.states;
    if (added.length === 0 || typeof t.value !== "string" || !isRecord(states)) {
      return;
    }
    const label = states[t.value];
    if (typeof label !== "string") {
      return;
    }
    try {
      await this.port.extendObject(fullId, {
        common: { states: { [t.value]: label } },
        native: { seenValues: [...before, ...added] },
      });
      known.seenValues = [...before, ...added];
      known.hasStates = true;
      this.port.log.debug(`${fullId}: added "${t.value}" to its list of values`);
    } catch (e) {
      this.port.log.debug(`adding "${t.value}" to the list of ${fullId} failed: ${errMessage(e)}`);
    }
  }

  /**
   * Create/refresh one transformed state and set its value (the per-state half
   * of {@link applyBshItem}).
   *
   * @param deviceId the id-safe device path segment
   * @param bshKey the source BSH key (shared by all states of an expanded item)
   * @param t the transformed state
   * @param source "sync" (owns metadata) or "values" (value-only)
   * @param channelLabel the channel's name when it is none of the fixed channels (a program's statistics)
   */
  private async applyTransformedState(
    deviceId: string,
    bshKey: string | undefined,
    t: TransformedState,
    source: "sync" | "values",
    channelLabel?: ioBroker.StringOrTranslated,
  ): Promise<void> {
    const fullId = `${deviceId}.${t.channel}.${t.id}`;
    const known = this.knownStates.get(fullId);
    if (!known) {
      await this.createState(
        deviceId,
        t.channel,
        t.id,
        t.common,
        { bshKey, bshValues: t.bshValues, ...(t.seenValues ? { seenValues: t.seenValues } : {}) },
        t.nameSource,
        channelLabel,
      );
    } else {
      if (source === "values") {
        await this.addSeenValue(fullId, known, t);
      }
      if (source === "sync") {
        const sig = metaSignature(t.common, { bshKey, bshValues: t.bshValues });
        // Only a SUCCESSFUL refresh may stamp the signature. The refresh clears
        // `common.states` / `native.bshValues` first (a merge cannot remove) and
        // writes them back in a second call — a failed second call leaves the
        // datapoint with an empty selection list and an unresolvable write path.
        // Stamping regardless declared that damage as the current state, so no
        // later sync of the same run retried it.
        if (
          known.metaSig !== sig &&
          (await this.refreshStateObject(
            fullId,
            t.common,
            { bshKey, bshValues: t.bshValues, ...(t.seenValues ? { seenValues: t.seenValues } : {}) },
            known,
            t.nameSource,
          ))
        ) {
          known.bshKey = bshKey;
          known.bshValues = t.bshValues;
          known.metaSig = sig;
          known.type = t.common.type;
        }
      }
      // The name may come with a value item too (an event's first arrival over the
      // stream carries its localized name) — this is a once-only label update, not
      // the metadata refresh above, and it is memory-guarded against churn.
      await this.refreshLabel(fullId, known, t.common, t.nameSource);
    }
    if (t.value === undefined) {
      // No value in this item — the metadata above may still refresh, but the
      // reading must not be touched. Writing `undefined` replaced a good value
      // with nothing, and the cloud legitimately sends key-only items: a
      // response carries only the SUBSET the appliance reports right now
      // (decision 6), so "missing" never means "cleared".
      return;
    }
    await this.port.setStateChanged(fullId, { val: t.value, ack: true });
  }

  /**
   * Refresh a state object whose owned metadata changed — by MERGING, never by
   * deleting and re-creating it (the shelly adapter's model, krobi 2026-09-02:
   * "we follow the Shelly adapter"). A merge cannot lose anything the
   * object carries beyond our own fields: a recording configuration, an alias
   * and the state value all stay untouched, and there is no window in which the
   * object does not exist.
   *
   * What a merge cannot do is REMOVE: `common.states` is merged key by key and
   * `native.bshValues` element by element (js-controller 7.2.2 → `node.extend(true, …)`),
   * so a program the appliance no longer offers would linger in the dropdown and
   * stay resolvable on write. Those two are therefore cleared first (`null`) and
   * written fresh in the second pass. The remaining owned fields (unit, min, max,
   * step, def) are overwritten but never cleared — as in shelly, a leftover there
   * is cosmetic.
   *
   * @param fullId the namespace-relative state id
   * @param common the fresh `common` from the transformer
   * @param native the fresh BSH native data
   * @param native.bshKey the fully-qualified BSH key
   * @param native.bshValues the full BSH candidate values of a writable enum
   * @param known the state's in-memory record (updated in place)
   * @param nameSource where the fresh name came from
   * @returns whether the object now carries the fresh metadata — a caller must
   *   not remember the new signature for a refresh that failed halfway
   */
  private async refreshStateObject(
    fullId: string,
    common: ioBroker.StateCommon,
    native: BshNative,
    known: KnownState,
    nameSource: NameSource,
  ): Promise<boolean> {
    const fresh: ioBroker.StateCommon = { ...common };
    // WHICH of the two merge-proof fields the clearing pass actually removed. It
    // decides what the record may claim afterwards and what the catch below may
    // claim: only a clearing that SUCCEEDED removed a field, and one call can
    // carry one of the two without the other.
    let clearedStates = false;
    let clearedValues = false;
    try {
      if (nameSource === "derived" && known.nameSource === "api" && known.name !== undefined) {
        fresh.name = known.name;
        nameSource = "api";
      }
      // Clear the two merge-proof fields first, so no stale entry survives.
      // A list goes when a new one comes, and when the value type changes — an on/off text that became a switch
      // (decision 47) keeps no list of "on"/"off" a merge would leave standing.
      const clearCommon = known.hasStates === true && fresh.states !== undefined;
      const clearNative = known.hasValues === true && native.bshValues !== undefined;
      if (
        known.hasStates === true &&
        known.type !== undefined &&
        fresh.type !== known.type &&
        fresh.states === undefined
      ) {
        // An on/off text that became a switch (decision 47): its list goes with the key, not as a stored null.
        await this.replaceWithoutList(fullId, {});
        clearedStates = true;
      }
      if (clearCommon || clearNative) {
        // A failure here must NOT be swallowed. Swallowing it let the second pass
        // merge the fresh values OVER the stale ones — a removed program stayed
        // selectable and resolvable — and still reported success, so the caller
        // stamped the signature and no later sync of this run tried again.
        await this.port.extendObject(fullId, {
          ...(clearCommon ? { common: { states: null } } : {}),
          ...(clearNative ? { native: { bshValues: null } } : {}),
        });
        clearedStates = clearCommon;
        clearedValues = clearNative;
      }
      await this.port.extendObject(fullId, { type: "state", common: fresh, native: { ...native, nameSource } });
      known.name = fresh.name;
      known.nameSource = nameSource;
      known.desc = fresh.desc;
      // What the OBJECT carries now — not what this refresh brought. A fresh
      // transform WITHOUT a selection list removes nothing (a merge keeps what
      // stands), so remembering "none" for it would disarm the clearing pass the
      // next time a real list arrives: that list would merge OVER the stale
      // entries, and a value the appliance no longer offers would stay in the
      // dropdown and resolvable on write. Reachable whenever the single-setting
      // read fails and the list entry alone carries no `allowedvalues`.
      known.hasStates = fresh.states !== undefined || (known.hasStates === true && !clearedStates);
      known.hasValues = native.bshValues !== undefined || known.hasValues === true;
      known.seenValues = native.seenValues ?? known.seenValues;
      this.port.log.debug(`refreshed object metadata of ${fullId}`);
      return true;
    } catch (e) {
      this.port.log.warn(`refreshing object metadata of ${fullId} failed: ${errMessage(e)}`);
      // What the object carries after a FAILED refresh: everything it had, minus
      // what the clearing pass actually removed. Only a clearing that SUCCEEDED
      // removed a field — then the retry must not clear it twice; if the
      // clearing itself was what failed, both still stand, and saying otherwise
      // would disarm the retry for good. Per field, because one call can carry
      // the one without the other.
      known.hasStates = known.hasStates === true && !clearedStates;
      known.hasValues = known.hasValues === true && !clearedValues;
      return false;
    }
  }

  /**
   * Apply a `/programs/selected` answer: the selected program (idle = "") into
   * its datapoint — which arms the option write gate — and the option values it
   * carries. Shared by the sync and by the read-back after a rejected write, so
   * both take exactly the same path.
   *
   * @param deviceId the id-safe device path segment
   * @param selected the answer: `null` (nothing selected) or the program record
   * @param knownKeys every program the appliance offers (from the list or the cache)
   */
  private async applySelectedProgram(deviceId: string, selected: unknown, knownKeys: string[]): Promise<void> {
    const selectedKey = isRecord(selected) && typeof selected.key === "string" ? selected.key : "";
    if (
      selectedKey.length > 0 ||
      knownKeys.length > 0 ||
      this.knownStates.has(`${deviceId}.programs.selectedProgram`)
    ) {
      // Without a usable program list the item runs as value-only, so the
      // existing allowed-values metadata survives untouched.
      await this.applyBshItem(
        deviceId,
        {
          key: SELECTED_PROGRAM_KEY,
          value: selectedKey,
          ...(knownKeys.length > 0 ? { constraints: { allowedvalues: knownKeys } } : {}),
        },
        knownKeys.length > 0 ? "sync" : "values",
      );
    }
    // The write gate for the selected program is armed inside applyBshItem above:
    // it sees the SELECTED_PROGRAM_KEY item and arms from its value, so a program
    // chosen at the appliance and one read here take exactly the same path. That
    // call happens before any value touches options.* below.
    if (isRecord(selected)) {
      await this.applyProgramOptions(deviceId, selected.options);
    }
  }

  /**
   * Read active + selected + available programs into the tree, and load any
   * not-yet-cached program option definitions (union of ALL programs → every
   * option datapoint exists upfront, none appears only when its program is used).
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   */
  private async syncPrograms(deviceId: string, haId: string): Promise<void> {
    // Appliance types without programs (refrigeration family, air conditioner)
    // get no programs channel at all.
    if (PROGRAMLESS_TYPES.has(this.typeByDeviceId.get(deviceId) ?? "")) {
      return;
    }
    const avail = await this.port.apiGet(appliancePath(haId, "/programs/available"));
    const fetchedKeys =
      isRecord(avail) && Array.isArray(avail.programs)
        ? avail.programs
            .filter(isRecord)
            .map(p => p.key)
            .filter((k): k is string => typeof k === "string")
        : undefined;
    if (fetchedKeys) {
      await this.syncProgramDefs(deviceId, haId, fetchedKeys);
    }
    // "Not ready" on the list: the selected and the active program would only
    // get the same answer.
    if (this.notReady.has(deviceId)) {
      return;
    }
    // Flicker guard: a failed/refused list (the API answers "wrong operation
    // state" while a program runs) must not shrink the program list — fall back
    // to every program the definition cache knows. That fallback only decides
    // whether the appliance HAS programs; it never becomes the datapoint's value
    // list: the cache is never pruned, and a program the appliance no longer
    // offers came back into the dropdown with every refused list.
    const liveKeys = fetchedKeys && fetchedKeys.length > 0 ? fetchedKeys : [];
    const knownKeys = liveKeys.length > 0 ? liveKeys : Object.keys(this.programDefs.get(deviceId) ?? {});
    // Only a datapoint WITHOUT a list yet takes the cache as its list (first start
    // while a program runs); an existing list is widened by no cache.
    const hasList = this.knownStates.get(`${deviceId}.programs.selectedProgram`)?.hasStates === true;
    const listKeys = liveKeys.length > 0 ? liveKeys : hasList ? [] : knownKeys;

    // `undefined` means the answer did not arrive (outage, rate pause, busy
    // appliance) — nothing is known, so nothing is written and the option gate
    // keeps its program. Only `null` ("nothing selected") or a record may say
    // "idle": a single timeout used to write "" over a running program and
    // disarm the gate with it, and nothing corrected that until the next full
    // sync — the stream only reports changes.
    const selected = await this.port.apiGet(appliancePath(haId, "/programs/selected"));
    if (selected !== undefined) {
      await this.applySelectedProgram(deviceId, selected, listKeys);
    }

    const active = await this.port.apiGet(appliancePath(haId, "/programs/active"));
    if (active !== undefined) {
      const activeKey = isRecord(active) && typeof active.key === "string" ? active.key : "";
      // Written when there is a value, when the appliance has programs — or when the
      // state already exists: then an "idle" ("") must still overwrite a stale name.
      if (activeKey.length > 0 || knownKeys.length > 0 || this.knownStates.has(`${deviceId}.programs.activeProgram`)) {
        await this.applyBshItem(deviceId, { key: ACTIVE_PROGRAM_KEY, value: activeKey }, "sync");
      }
      if (isRecord(active)) {
        await this.applyProgramOptions(deviceId, active.options);
      }
    }

    // Start/stop only make sense for an appliance that actually has programs.
    if (knownKeys.length > 0) {
      await this.ensureButton(
        deviceId,
        "programs",
        "start",
        tName("startProgram"),
        "i18n",
        undefined,
        tName("startProgramDesc"),
      );
      await this.ensureButton(
        deviceId,
        "programs",
        "stop",
        tName("stopProgram"),
        "i18n",
        undefined,
        tName("stopProgramDesc"),
      );
    }
  }

  /**
   * Apply a program's `options[]` array under `options.*`. Value-only: the
   * object shape of a writable option is owned by its *definition*
   * ({@link applyOptionDefinition}) — a value item must not overwrite it.
   *
   * @param deviceId the id-safe device path segment
   * @param options the options array from a program response
   */
  private async applyProgramOptions(deviceId: string, options: unknown): Promise<void> {
    if (!Array.isArray(options)) {
      return;
    }
    for (const raw of options) {
      if (isRecord(raw)) {
        await this.applyBshItem(deviceId, raw, "values");
      }
    }
  }

  /**
   * Fetch the option definitions of programs the cache does not know yet —
   * each program is fetched ONCE, ever (the cache persists in the device
   * object's native and is restored at start). A failed fetch is simply
   * retried on a later sync; nothing is removed.
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   * @param programKeys the full program keys that should be cached
   */
  private async syncProgramDefs(deviceId: string, haId: string, programKeys: readonly string[]): Promise<void> {
    const cached = this.programDefs.get(deviceId) ?? {};
    this.programDefs.set(deviceId, cached);
    let changed = false;
    const refused = this.unsupportedPrograms.get(haId);
    for (const programKey of programKeys) {
      if (this.notReady.has(deviceId)) {
        break;
      }
      const entry = cached[programKey];
      if ((entry && entry.v >= PROGRAM_DEF_GENERATION) || refused?.has(programKey)) {
        continue;
      }
      if (!this.mayFetchDef(deviceId, programKey)) {
        continue;
      }
      const defPath = appliancePath(haId, `/programs/available/${encodeURIComponent(programKey)}`);
      const def = await this.port.apiGet(defPath);
      // A record without an options list AND without the program key is a shape
      // we don't understand — do not cache it as "no options" (that would stick
      // forever); skipping means it is retried on a later sync. A well-formed
      // no-options program carries its key and is cached as [] correctly.
      if (!isRecord(def) || (!Array.isArray(def.options) && typeof def.key !== "string")) {
        // An unsupported program is remembered on its own (noteUnsupportedProgram).
        if (!this.unsupportedPrograms.get(haId)?.has(programKey)) {
          this.noteDefMiss(deviceId, programKey, defPath);
        }
        continue;
      }
      const options = Array.isArray(def.options) ? def.options : [];
      const ids: string[] = [];
      const keys: Record<string, string> = {};
      for (const raw of options) {
        if (isRecord(raw)) {
          const id = await this.applyOptionDefinition(deviceId, raw);
          if (id) {
            ids.push(id);
            if (typeof raw.key === "string") {
              keys[id] = raw.key;
            }
          }
        }
      }
      cached[programKey] = { ids, keys, v: PROGRAM_DEF_GENERATION };
      changed = true;
    }
    if (changed && !this.stopped) {
      try {
        // The pre-generation shape (a bare id list) needs no clearing first: the
        // deep merge only unites two lists — a record written over a list replaces
        // it (node.extend, `clone = src && is.hash(src) ? src : {}`).
        // Internal attribute on the device object (not a datapoint): survives restarts.
        await this.port.extendObject(deviceId, { native: { programOptions: cached } });
      } catch (e) {
        this.port.log.debug(`persisting the program definition cache of ${deviceId} failed: ${errMessage(e)}`);
      }
    }
  }

  /**
   * Arm the write gate with the selected program's option ids — from the cache;
   * only a program the cache has never seen costs a definition request.
   * Option states of other programs stay untouched (their objects are the
   * union across all programs and never disappear).
   *
   * Idempotent: re-arming for the program the gate already holds does nothing,
   * so the REST sync and a stream-borne selection can both call this without
   * costing anything twice.
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   * @param programKey the full key of the now-selected program
   */
  async activateProgramOptions(deviceId: string, haId: string, programKey: string): Promise<void> {
    // Already armed for exactly this program AND its definition is cached ⇒
    // nothing to do. The cache half of the condition matters: a definition fetch
    // that failed leaves the gate empty, and that attempt must stay repeatable.
    if (
      this.armedProgramByDeviceId.get(deviceId) === programKey &&
      (this.programDefs.get(deviceId)?.[programKey]?.v ?? 0) >= PROGRAM_DEF_GENERATION
    ) {
      return;
    }
    let cached = this.programDefs.get(deviceId);
    if ((cached?.[programKey]?.v ?? 0) < PROGRAM_DEF_GENERATION) {
      await this.syncProgramDefs(deviceId, haId, [programKey]);
      cached = this.programDefs.get(deviceId);
    }
    this.optionKeys.set(deviceId, new Set(cached?.[programKey]?.ids ?? []));
    this.armedProgramByDeviceId.set(deviceId, programKey);
  }

  /**
   * Create one writable option state from its definition — or, if it already
   * exists (from another program of the same appliance), merge the definitions
   * into a UNION: allowed values united, numeric bounds widened. The union keeps
   * the object stable across program switches (no rewrite ping-pong); which
   * values the currently selected program really accepts is the write gate's
   * business, not the object's.
   *
   * @param deviceId the id-safe device path segment
   * @param raw the raw option definition
   * @returns the option's state id, or undefined if it had no key
   */
  private async applyOptionDefinition(deviceId: string, raw: Record<string, unknown>): Promise<string | undefined> {
    if (this.stopped || typeof raw.key !== "string") {
      return undefined;
    }
    const opt: BshOptionDefinition = {
      key: raw.key,
      name: typeof raw.name === "string" ? raw.name : undefined,
      type: typeof raw.type === "string" ? raw.type : undefined,
      unit: typeof raw.unit === "string" ? raw.unit : undefined,
      constraints: parseConstraints(raw.constraints),
      lang: this.port.language,
    };
    const t = transformOptionDefinition(opt);
    const fullId = `${deviceId}.options.${t.id}`;
    const known = this.knownStates.get(fullId);
    if (!known) {
      await this.createState(
        deviceId,
        "options",
        t.id,
        t.common,
        { bshKey: opt.key, bshValues: t.bshValues, defGeneration: PROGRAM_DEF_GENERATION },
        t.nameSource,
      );
      const created = this.knownStates.get(fullId);
      if (created) {
        created.defGeneration = PROGRAM_DEF_GENERATION;
      }
      // The definition's default only seeds a brand-new state; a known one keeps
      // its value (the `known` check above is what does that — setStateChanged is
      // used for consistency with the rest of the value path, not as the gate).
      if (t.value !== undefined) {
        await this.port.setStateChanged(fullId, { val: t.value, ack: true });
      }
      return t.id;
    }
    // The first definition of a newer generation rebuilds the list; the stored union of an older
    // one may hold values no program offers any more (1.24.0 fixtures: tea sorts on an oven level).
    const rebuild = (known.defGeneration ?? 0) < PROGRAM_DEF_GENERATION;
    const merged = await this.mergeOptionDefinition(fullId, known, t, rebuild);
    // The object keeps the key it was created with. Two appliance families can
    // name one option differently (`…IDos1.Active` / `…IDos1Active`, even inside
    // ONE program definition), and both land on this state id: taking each
    // definition's key flipped the signature on every definition and rewrote the
    // object each time (up to 401 rewrites of one option per start, measured on
    // the fixture washer-dryer 2026-09-28). A write never needs this key — it
    // goes out with the key of the armed program (decision 34).
    const objectKey = known.bshKey ?? opt.key;
    const sig = metaSignature(merged.common, { bshKey: objectKey, bshValues: merged.bshValues });
    // Same rule as in the item path: a refresh that failed halfway must not be
    // remembered as done, or the option keeps an empty selection list until the
    // next adapter start.
    // A rebuild is written even when the signature matches: the stamp has to reach the object, or
    // the next definition would rebuild once more and drop what this one's siblings added.
    const refreshed =
      (!rebuild && known.metaSig === sig) ||
      (await this.refreshStateObject(
        fullId,
        merged.common,
        {
          bshKey: objectKey,
          bshValues: merged.bshValues,
          ...(rebuild ? { defGeneration: PROGRAM_DEF_GENERATION } : {}),
        },
        known,
        t.nameSource,
      ));
    if (refreshed) {
      known.bshKey = objectKey;
      known.bshValues = merged.bshValues;
      known.metaSig = sig;
      known.type = merged.common.type;
      known.defGeneration = PROGRAM_DEF_GENERATION;
    }
    await this.refreshLabel(fullId, known, t.common, t.nameSource);
    return t.id;
  }

  /**
   * The union of an existing option state and a fresh definition of the same
   * option (from another program): allowed values united (existing display
   * labels win), numeric bounds widened, unit/step kept when the fresh
   * definition lacks them.
   *
   * @param fullId the option's namespace-relative state id
   * @param known its in-memory entry (accumulated allowed values)
   * @param t the freshly transformed definition
   * @param rebuild start from this definition alone — the stored list and bounds are of an older generation
   * @returns the merged common + allowed values
   */
  private async mergeOptionDefinition(
    fullId: string,
    known: KnownState,
    t: TransformedState,
    rebuild: boolean,
  ): Promise<{ common: ioBroker.StateCommon; bshValues?: string[] }> {
    const common: ioBroker.StateCommon = { ...t.common };
    let exCommon: Partial<ioBroker.StateCommon> = {};
    try {
      exCommon = ((await this.port.getObject(fullId))?.common ?? {}) as Partial<ioBroker.StateCommon>;
    } catch (e) {
      this.port.log.debug(`reading ${fullId} for the definition merge failed: ${errMessage(e)}`);
    }
    if (rebuild) {
      // Labels a stored value may lend stay usable; its bounds and list do not.
      exCommon = { states: exCommon.states };
    }
    let bshValues = t.bshValues;
    const base = rebuild ? [] : (known.bshValues ?? []);
    if (base.length > 0 || (t.bshValues?.length ?? 0) > 0) {
      const union = [...base];
      for (const v of t.bshValues ?? []) {
        if (!union.includes(v)) {
          union.push(v);
        }
      }
      bshValues = union;
    }
    // A switch keeps its On/Off values for the write path, but shows no list (decision 47).
    if (bshValues && bshValues.length > 0 && common.type === "string") {
      const union = bshValues;
      const exStates = isRecord(exCommon.states) ? exCommon.states : {};
      const newStates = isRecord(common.states) ? common.states : {};
      const lang = this.port.language ?? DEFAULT_LABEL_LANGUAGE;
      const states: Record<string, string> = {};
      for (const v of union) {
        const short = shortEnum(v);
        // The adapter's own label, in the system language, beats whatever stands:
        // a stored label is the cloud's (English on a German installation — "1400
        // rpm") or an older adapter's bare short value. Only a value the table
        // does not know keeps the label it has.
        const stored = exStates[short];
        states[short] =
          ownValueLabel(v, lang) ??
          newStates[short] ??
          (typeof stored === "string" && stored !== short ? stored : undefined) ??
          valueLabel(v, lang, undefined, known.bshKey);
      }
      common.states = states;
    }
    if (typeof exCommon.min === "number") {
      common.min = typeof common.min === "number" ? Math.min(common.min, exCommon.min) : exCommon.min;
    }
    if (typeof exCommon.max === "number") {
      common.max = typeof common.max === "number" ? Math.max(common.max, exCommon.max) : exCommon.max;
    }
    if (common.step === undefined && typeof exCommon.step === "number") {
      common.step = exCommon.step;
    }
    if (common.unit === undefined && typeof exCommon.unit === "string") {
      common.unit = exCommon.unit;
    }
    return { common, bshValues };
  }

  /**
   * Create the available commands as momentary buttons under `commands.*`.
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   */
  private async ensureCommands(deviceId: string, haId: string): Promise<void> {
    const data = await this.port.apiGet(appliancePath(haId, "/commands"));
    const commands = isRecord(data) && Array.isArray(data.commands) ? data.commands : [];
    for (const raw of commands) {
      // A command of the appliance's own connection (switching its Wi-Fi off) is never offered (decision 48).
      if (isRecord(raw) && typeof raw.key === "string" && !isDeviceInternalKey(raw.key)) {
        const id = stateIdForKey(raw.key).id;
        const texts = stateText(raw.key);
        // The explanation belongs to the BSH key, not to the path the NAME took:
        // it is the adapter's own text either way. Computing it per branch meant a
        // command named from the cloud or from the fallback table silently lost
        // the description that stood right next to that name in the same table.
        const desc = texts?.desc ? tName(texts.desc) : undefined;
        if (texts?.name) {
          await this.ensureButton(deviceId, "commands", id, tName(texts.name), "i18n", raw.key, desc);
          continue;
        }
        const apiName = cleanLabel(raw.name);
        if (apiName.length > 0) {
          await this.ensureButton(deviceId, "commands", id, apiName, "api", raw.key, desc);
          continue;
        }
        // Neither ours nor the cloud's: the English label derived from the key.
        await this.ensureButton(deviceId, "commands", id, humanizeId(id), "derived", raw.key, desc);
      }
    }
  }

  /**
   * Create a momentary button state (boolean, role "button", write-only) once —
   * and keep its label current afterwards (a command's localized name).
   *
   * @param deviceId the id-safe device path segment
   * @param channel the channel the button lives under (programs / commands)
   * @param id the button's state id
   * @param name the human-readable name
   * @param nameSource where that name came from
   * @param bshKey the BSH command key, for command buttons (omitted for start/stop)
   * @param desc the explanation to store, where the adapter has one
   */
  private async ensureButton(
    deviceId: string,
    channel: string,
    id: string,
    name: ioBroker.StringOrTranslated,
    nameSource: NameSource,
    bshKey?: string,
    desc?: ioBroker.StringOrTranslated,
  ): Promise<void> {
    if (this.stopped) {
      return;
    }
    const fullId = `${deviceId}.${channel}.${id}`;
    const common: ioBroker.StateCommon = { name, type: "boolean", role: "button", read: false, write: true };
    if (desc !== undefined) {
      common.desc = desc;
    }
    const known = this.knownStates.get(fullId);
    if (known) {
      await this.refreshLabel(fullId, known, common, nameSource);
      return;
    }
    await this.createState(deviceId, channel, id, common, { bshKey }, nameSource);
  }

  /**
   * Handle a user write (ack:false already filtered by main): resolve it into a
   * Home Connect request and send it, with a top-level catch (fire-and-forget safe).
   *
   * @param id the full (namespace-qualified) state id
   * @param value the written value
   */
  async handleWrite(id: string, value: ioBroker.StateValue): Promise<void> {
    try {
      const rel = this.relId(id);
      const parts = rel.split(".");
      const deviceId = parts[0];
      const channel = parts[1];
      const stateId = parts.slice(2).join(".");
      if (!deviceId || !channel || stateId.length === 0) {
        return;
      }
      const haId = this.haIdByDeviceId.get(deviceId);
      if (!haId) {
        return;
      }
      // Only options from the selected program's definition are writable — a
      // script write to a read-only display option (RemainingProgramTime, …)
      // would only produce a server-side error, so it is not sent at all.
      if (channel === "options" && !this.optionKeys.get(deviceId)?.has(stateId)) {
        this.port.log.debug(`Write to ${rel} ignored (not a writable option of the selected program).`);
        return;
      }
      const meta = this.knownStates.get(rel);
      // A script may write "true" into a switch or "40" into a number: the
      // appliance gets the typed value, and so does the confirmation below.
      const typed = coerceForType(value, meta?.type);
      if (typed === undefined) {
        this.port.log.debug(`Write to ${rel} ignored (${JSON.stringify(value)} is not a ${meta?.type ?? "value"}).`);
        return;
      }
      value = typed;
      // An option goes out with the key the SELECTED program uses for it, and its
      // value is resolved within that key's value family (see ProgramDef.keys).
      const optionKey = channel === "options" ? this.optionKeyFor(deviceId, stateId, meta?.bshKey) : undefined;
      const ctx: WriteContext = {
        haId,
        channel,
        id: stateId,
        bshKey: optionKey ?? meta?.bshKey,
        bshValues: channel === "options" ? familyOf(meta?.bshValues, optionKey) : meta?.bshValues,
        collapseEnum: channel === "options",
        value,
      };
      if (channel === "programs" && stateId === "start") {
        ctx.selectedProgramKey = await this.resolveSelectedProgramKey(deviceId);
        ctx.selectedOptions = await this.collectSelectedOptions(deviceId);
      }
      const req = resolveWrite(ctx);
      if (req) {
        const res = await this.port.apiWrite(req);
        await this.postWrite(channel, stateId, deviceId, haId, req, res);
        if (!this.isMomentaryButton(channel, stateId)) {
          if (res?.ok) {
            // Confirmed in the datapoint's own form: a tolerant spelling ("EXTRA",
            // a full program key) was sent correctly but confirmed verbatim — and
            // the next program start matched the stored value against the short
            // form, found nothing and dropped the option without a word.
            await this.port.setState(rel, {
              val: confirmedValue(channel, stateId, req, meta?.bshValues, value),
              ack: true,
            });
          } else if (res) {
            // Rejected (409 "wrong operation state", 4xx): the user's wish stayed in
            // the datapoint with ack:false and nothing corrected it — no poll, and
            // the stream reports changes at the appliance, where nothing changed.
            // One targeted read restores the real value. `undefined` = not sent.
            await this.readBackAfterRejection(deviceId, haId, channel, stateId, meta?.bshKey);
          }
        }
      } else if (channel === "programs" && stateId === "selectedProgram" && this.isSeenOnlyProgram(deviceId, value)) {
        // A program the appliance ran but the cloud does not offer: it is in the
        // list (so the value reads as a name), but Home Connect refuses to select
        // it remotely. The user asked for something — the answer goes to info,
        // and the datapoint goes back to what the appliance really has.
        this.port.log.info(
          `Write to ${rel} not sent: "${String(value)}" can only be chosen at the appliance — Home Connect does not offer it for remote selection.`,
        );
        await this.readBackAfterRejection(deviceId, haId, channel, stateId, meta?.bshKey);
      } else if (typeof value === "boolean" && ctx.bshValues && ctx.bshValues.length > 0) {
        // A switch the appliance cannot be set to remotely (a power state without Off or Standby): the user asked for
        // something — the answer goes to info, and the datapoint goes back to what the appliance really has.
        this.port.log.info(
          `Write to ${rel} not sent: the appliance cannot be switched ${value ? "on" : "off"} remotely.`,
        );
        await this.readBackAfterRejection(deviceId, haId, channel, stateId, meta?.bshKey);
      } else {
        const both = ambiguousCandidates(value, ctx.bshValues);
        if (both.length > 0 && channel !== "options") {
          // Two different programs end in the same word: the bare word names neither.
          this.port.log.warn(
            `Write to ${rel} not sent: "${String(value)}" matches ${both.length} programs — write one of: ${both.map(v => shortEnumIn(v, ctx.bshValues)).join(", ")}.`,
          );
        } else {
          this.port.log.debug(`Write to ${rel} ignored (no matching Home Connect command).`);
        }
      }
      if (this.isMomentaryButton(channel, stateId)) {
        await this.port.setStateChanged(rel, { val: false, ack: true });
      }
    } catch (e) {
      this.port.log.warn(`handling write to ${id} failed: ${errMessage(e)}`);
    }
  }

  /**
   * The BSH key an option goes out with: the key the ARMED program's definition
   * uses for this state id; the key on the object otherwise (a cache entry from
   * before the per-program keys, or no program armed).
   *
   * @param deviceId the id-safe device path segment
   * @param stateId the option's state id
   * @param fallback the key stored on the object
   * @returns the key to write with
   */
  private optionKeyFor(deviceId: string, stateId: string, fallback: string | undefined): string | undefined {
    const armed = this.armedProgramByDeviceId.get(deviceId);
    const key = armed ? this.programDefs.get(deviceId)?.[armed]?.keys?.[stateId] : undefined;
    return key ?? fallback;
  }

  /**
   * Whether a state is a momentary button (a press carrying no lasting value).
   *
   * @param channel the state's channel
   * @param stateId the within-channel id
   * @returns whether it is a command / program-start / program-stop button
   */
  private isMomentaryButton(channel: string, stateId: string): boolean {
    return channel === "commands" || (channel === "programs" && (stateId === "start" || stateId === "stop"));
  }

  /**
   * After the appliance rejected a write: read the affected resource back once
   * so the datapoint shows what the appliance really has (decision 8). A
   * setting comes from its single-setting endpoint; the program selection and
   * its options from `/programs/selected`, through the same path the sync
   * uses. Costs one request per rejection; a script that stubbornly repeats a
   * rejected write pays two per attempt.
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   * @param channel the written state's channel
   * @param stateId the within-channel id
   * @param bshKey the written state's BSH key, if known
   */
  private async readBackAfterRejection(
    deviceId: string,
    haId: string,
    channel: string,
    stateId: string,
    bshKey: string | undefined,
  ): Promise<void> {
    if (channel === "settings" && bshKey !== undefined) {
      const item = await this.port.apiGet(appliancePath(haId, `/settings/${encodeURIComponent(bshKey)}`));
      if (isRecord(item)) {
        await this.applyBshItem(deviceId, item, "values");
      }
      return;
    }
    if (channel === "options" || (channel === "programs" && stateId === "selectedProgram")) {
      // This read is its own "pass" for the stale-value check: only a stream value
      // newer than THIS request may win over its answer.
      this.passStartedAt.set(deviceId, Date.now());
      const selected = await this.port.apiGet(appliancePath(haId, "/programs/selected"));
      if (selected !== undefined) {
        // Value only — the program list is the live list's business (see syncPrograms).
        await this.applySelectedProgram(deviceId, selected, []);
      }
    }
  }

  /**
   * Resolve the full BSH key of the currently selected program.
   *
   * @param deviceId the id-safe device path segment
   * @returns the full program key, or undefined
   */
  private async resolveSelectedProgramKey(deviceId: string): Promise<string | undefined> {
    const st = await this.port.getState(`${deviceId}.programs.selectedProgram`);
    const short = typeof st?.val === "string" ? st.val : "";
    if (short.length === 0) {
      return undefined;
    }
    return resolveEnum(short, this.knownStates.get(`${deviceId}.programs.selectedProgram`)?.bshValues);
  }

  /**
   * Follow-up after a write was sent: a program change reloads its option
   * definitions; a program start the appliance rejected (409) is retried once
   * with defaults.
   *
   * @param channel the written state's channel
   * @param stateId the within-channel id
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   * @param req the request that was sent
   * @param res the result, or undefined if nothing was sent
   */
  private async postWrite(
    channel: string,
    stateId: string,
    deviceId: string,
    haId: string,
    req: WriteRequest,
    res: JsonResult | undefined,
  ): Promise<void> {
    if (!res) {
      return;
    }
    // `req.body?.key` is a type guard: resolveWrite only returns a selectedProgram
    // request WITH a key, so it never actually filters at runtime.
    if (channel === "programs" && stateId === "selectedProgram" && res.ok && req.body?.key) {
      // Re-arm the write gate for the new program — from the cache, so a program
      // change normally costs no definition request at all.
      await this.activateProgramOptions(deviceId, haId, req.body.key);
      return;
    }
    if (channel === "programs" && stateId === "start" && res.status === 409 && req.body?.options) {
      this.port.log.info("Program did not start with the selected options — retrying with defaults.");
      await this.port.apiWrite({ method: "PUT", path: req.path, body: { key: req.body.key } });
    }
  }

  /**
   * Collect the selected program's option values, resolved back to their BSH
   * values, to send with a program start.
   *
   * @param deviceId the id-safe device path segment
   * @returns the option key/value pairs for the start body
   */
  private async collectSelectedOptions(deviceId: string): Promise<Array<{ key: string; value: ioBroker.StateValue }>> {
    const result: Array<{ key: string; value: ioBroker.StateValue }> = [];
    const ids = this.optionKeys.get(deviceId);
    if (!ids) {
      return result;
    }
    for (const id of ids) {
      const relId = `${deviceId}.options.${id}`;
      const meta = this.knownStates.get(relId);
      const key = this.optionKeyFor(deviceId, id, meta?.bshKey);
      if (!key) {
        continue;
      }
      const st = await this.port.getState(relId);
      if (!st || st.val === null || st.val === undefined) {
        continue;
      }
      const values = familyOf(meta?.bshValues, key);
      const value = resolveValue(st.val, values, true, key);
      if (value !== undefined && value !== null) {
        result.push({ key, value });
      }
    }
    return result;
  }
}
