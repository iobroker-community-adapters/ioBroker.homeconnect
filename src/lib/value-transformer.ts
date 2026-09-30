// Value transformer — the core of the greenfield: turn BSH's raw enum strings
// into idiomatic ioBroker states (boolean / short enum + states / number+unit)
// and derive a speaking state id from the BSH key. Enum catalogue + wire shapes:
// `Ressourcen/homeconnect/bsh-api-research-2026-08-05.md` / reference_bsh_home_connect_api.
//
// Unknown keys/values are NOT dropped: they fall back to the raw value as a
// string, so nothing is lost — the mapping is then extended device by device.

import { cleanLabel, humanizeId, isRecord, numberOrUndef, stringArrayOrUndef } from "./pure-helpers";
import { tName } from "./i18n";
import { stateText, DOOR_COMPARTMENT_NAMES } from "./state-texts";
import { catalogValues, DEFAULT_LABEL_LANGUAGE, noProgramLabel, valueLabel } from "./value-labels";
import { isProgramRecordKey } from "./program-records";
import { isDeviceInternalKey } from "./device-internal";
import { boundShown, presentationFor, shownUnit, toShown } from "./value-units";
import { isSwitchKey, switchRole, switchState } from "./switch-values";

/**
 * Where a state's display name came from — decides whether a later label may
 * replace it: an "api" name (the cloud's localized text) is never downgraded to
 * a "derived" one (English from the key); an "i18n" name is the adapter's own
 * translation object for the states it invents itself.
 */
export type NameSource = "api" | "derived" | "i18n";

/** A single status / setting / option / event item as the BSH API returns it. */
export interface BshItem {
  /** The fully-qualified BSH key, e.g. "BSH.Common.Status.OperationState". */
  key: string;
  /** The localized display name the API sent for this item (Accept-Language), if any. */
  name?: string;
  /** The raw value (enum string, number, boolean). */
  value: unknown;
  /** Optional unit (e.g. "seconds", "°C") from the API. */
  unit?: string;
  /** Optional constraints from the API (numeric bounds, allowed enum values, access rights). */
  constraints?: ParsedConstraints;
  /** The ioBroker system language the value labels are written in (default English). */
  lang?: string;
  /**
   * Full values this datapoint carried before that its list does not name (stored in
   * the object's `native.seenValues`) — they stay in the list, so a value the
   * appliance really had is never outside it.
   */
  seen?: readonly string[];
}

/** A program option as `GET /programs/available/{programKey}` defines it (type + constraints). */
export interface BshOptionDefinition {
  /** The option key, e.g. "Dishcare.Dishwasher.Option.IntensivZone". */
  key: string;
  /** The localized option name. */
  name?: string;
  /** The BSH data type: "Int" / "Double" / "Boolean" / an enum type. */
  type?: string;
  /** The unit, e.g. "sec", "°C". */
  unit?: string;
  /** Constraints: numeric bounds, allowed enum values + their display labels, default. */
  constraints?: ParsedConstraints;
  /** The ioBroker system language the value labels are written in (default English). */
  lang?: string;
}

/** The transformed state: the `common` fragment to create it with, and the value. */
export interface TransformedState {
  /** The channel this state lives under (status / settings / events / options / …). */
  channel: string;
  /** The state id within the channel, e.g. "operationState". */
  id: string;
  /** The `common` fragment for the object (name + desc included). */
  common: ioBroker.StateCommon;
  /** Where `common.name` came from (see {@link NameSource}). */
  nameSource: NameSource;
  /**
   * The transformed value — `undefined` when the item carried none. The cloud
   * sends key-only items (a response holds only the subset the appliance reports
   * right now), and those must leave the stored reading alone.
   */
  value: ioBroker.StateValue | undefined;
  /**
   * The full BSH candidate values (e.g. `["…PowerState.On", "…PowerState.Off"]`):
   * the cloud's list whenever it came, otherwise — for a writable enum — the
   * catalogue's or the value itself. `shortEnum` is lossy, so these are stored in
   * the state's `native` to resolve a short value back on write.
   */
  bshValues?: string[];
  /**
   * Full values in the selection list that neither the cloud's list nor the
   * catalogue named — values the appliance really had. Kept in the object's
   * `native.seenValues` and handed back in {@link BshItem.seen} on every transform.
   */
  seenValues?: string[];
}

const EVENT_PRESENT = "BSH.Common.EnumType.EventPresentState.Present";
/**
 * An event key the type source lists among the EVENT values
 * (`upstream-refs/api-value-types.ts`, `EventEventValues`, collected from real
 * appliance logs) that names only the value TYPE, not the event. It is an event
 * all the same — not a "misc" text.
 */
export const UNNAMED_EVENT_KEY = "BSH.Common.EnumType.EventPresentState";

/** BSH `<Kind>` segment → the ioBroker channel it maps to. */
const KIND_TO_CHANNEL: Record<string, string> = {
  Status: "status",
  Setting: "settings",
  Event: "events",
  Option: "options",
  Command: "commands",
  Root: "programs",
};

/**
 * The short, lower-case tail of a dotted BSH value, e.g. "…OperationState.Run" → "run".
 *
 * @param bshValue the dotted BSH enum/program value
 * @returns the lower-case last segment
 */
export function shortEnum(bshValue: string): string {
  const parts = bshValue.split(".");
  const tail = parts[parts.length - 1] ?? bshValue;
  return tail.toLowerCase();
}

/**
 * The short value of a BSH value WITHIN its list: the last segment, unless
 * another value of the same list ends in the same segment — then the last two
 * ("…Oven.Program.HeatingMode.DoughProving" → "heatingmode.doughproving" next to
 * "…SteamModes.DoughProving" → "steammodes.doughproving"). Those are different
 * programs: one short value for both left one entry in the dropdown, and a
 * write chose whichever came first. Without a collision it is exactly
 * {@link shortEnum}, so no existing value changes.
 *
 * @param bshValue the dotted BSH value
 * @param candidates the list it belongs to
 * @returns the list-unique short value
 */
export function shortEnumIn(bshValue: string, candidates?: readonly string[]): string {
  const short = shortEnum(bshValue);
  if (!candidates?.some(c => c !== bshValue && shortEnum(c) === short)) {
    return short;
  }
  return bshValue.split(".").slice(-2).join(".").toLowerCase();
}

/** The constraint fields either a status/setting item or an option definition may carry. */
export interface ParsedConstraints {
  /** Lower numeric bound. */
  min?: number;
  /** Upper numeric bound. */
  max?: number;
  /** Allowed step size between numeric values. */
  stepsize?: number;
  /** The allowed enum values (full BSH values). */
  allowedvalues?: string[];
  /** The parallel human-readable labels for {@link allowedvalues}. */
  displayvalues?: string[];
  /** The default value (an option definition may carry one). */
  default?: unknown;
  /** Access rights of a setting/status: "readWrite" or "read" (absent for options). */
  access?: string;
}

/**
 * Parse the `constraints` field of a raw BSH item/definition into the typed
 * shape both {@link transformItem} and {@link transformOptionDefinition}
 * consume. Superset of both callers' needs (a status item ignores
 * `default`); one boundary parser instead of two near-identical
 * inline blocks (the adapter's applyBshItem + applyOptionDefinition).
 *
 * @param rawConstraints the raw `constraints` value off an API record (unknown)
 * @returns the parsed constraints, or undefined when there is no constraints object
 */
export function parseConstraints(rawConstraints: unknown): ParsedConstraints | undefined {
  if (!isRecord(rawConstraints)) {
    return undefined;
  }
  return {
    min: numberOrUndef(rawConstraints.min),
    max: numberOrUndef(rawConstraints.max),
    stepsize: numberOrUndef(rawConstraints.stepsize),
    allowedvalues: stringArrayOrUndef(rawConstraints.allowedvalues),
    displayvalues: stringArrayOrUndef(rawConstraints.displayvalues),
    default: rawConstraints.default,
    access: typeof rawConstraints.access === "string" ? rawConstraints.access : undefined,
  };
}

/**
 * Lower-case the first character, e.g. "OperationState" → "operationState".
 *
 * @param s the string to transform
 * @returns the string with a lower-case first character
 */
function lowerFirst(s: string): string {
  return s.length > 0 ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

/**
 * Derive the speaking channel + id from a BSH key. The kind segment is searched
 * anywhere in the key (not just second-to-last), because BSH nests freely:
 * "BSH.Common.Status.OperationState" → { channel: "status", id: "operationState" };
 * "Refrigeration.Common.Status.Door.Freezer" → { channel: "status", id: "doorFreezer" };
 * "Refrigeration.Common.Setting.Light.Internal.Brightness" → { channel: "settings", id: "lightInternalBrightness" };
 * "BSH.Common.Event.Favorite.001.ExternalTrigger" → { channel: "events", id: "favorite001ExternalTrigger" }.
 * The old second-to-last rule sent every nested key into a wrong "misc" channel
 * (and thereby also mis-derived its writability).
 *
 * @param key the fully-qualified BSH key
 * @returns the channel and the within-channel id
 */
export function stateIdForKey(key: string): { channel: string; id: string } {
  if (key === UNNAMED_EVENT_KEY) {
    return { channel: "events", id: "unnamedEvent" };
  }
  const parts = key.split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    const channel = KIND_TO_CHANNEL[parts[i] ?? ""];
    if (channel) {
      return { channel, id: camelJoin(parts.slice(i + 1)) };
    }
  }
  return { channel: "misc", id: lowerFirst(parts[parts.length - 1] ?? key) };
}

/**
 * Join key segments after the kind into one speaking camelCase id:
 * ["Door", "Freezer"] → "doorFreezer"; ["Favorite", "001", "ExternalTrigger"] →
 * "favorite001ExternalTrigger".
 *
 * @param segments the key segments after the kind segment
 * @returns the joined id
 */
function camelJoin(segments: string[]): string {
  return segments.map((s, i) => (i === 0 ? lowerFirst(s) : s.charAt(0).toUpperCase() + s.slice(1))).join("");
}

/**
 * Transform one BSH item into an idiomatic ioBroker state (channel, id, common, value).
 *
 * @param item the BSH status/setting/option/event item
 * @returns the transformed state ready to create and set
 */
export function transformItem(item: BshItem): TransformedState {
  const { channel, id } = stateIdForKey(item.key);
  const { common, value, bshValues, nameSource, seenValues } = transformValue(item);
  return { channel, id, common, nameSource, value, bshValues, ...(seenValues ? { seenValues } : {}) };
}

/** The two synthetic program items — the adapter names them itself (translated). */
const PROGRAM_ITEM_NAMES: Record<string, "selectedProgram" | "activeProgram"> = {
  "BSH.Common.Root.SelectedProgram": "selectedProgram",
  "BSH.Common.Root.ActiveProgram": "activeProgram",
};

/**
 * The display name for a BSH-keyed state, in this order: our own name from the
 * text table (it beats the cloud's — the cloud answers in whatever language it
 * likes, ours reaches eleven), the cloud's localized name, and finally a
 * readable English label derived from the id. `desc` is an explanation, never
 * the technical key.
 *
 * @param key the fully-qualified BSH key
 * @param apiName the item's `name` off the wire, if any
 * @param id the derived state id
 * @returns the name, its source, and the desc
 */
function itemLabel(
  key: string,
  apiName: string | undefined,
  id: string,
): { name: ioBroker.StringOrTranslated; nameSource: NameSource; desc: ioBroker.StringOrTranslated | undefined } {
  const texts = stateText(key);
  // Our own explanation, in every language — never the manufacturer's key
  // (krobi 2026-09-02: that is exactly what makes a tree unreadable).
  const desc = texts?.desc ? tName(texts.desc) : undefined;
  if (texts?.name) {
    // The adapter names it itself: events never come with a name over REST, and
    // a name of ours reaches every language, a cloud name only one.
    return { name: tName(texts.name), nameSource: "i18n", desc };
  }
  const own = PROGRAM_ITEM_NAMES[key];
  if (own) {
    return { name: tName(own), nameSource: "i18n", desc };
  }
  const cleaned = cleanLabel(apiName);
  if (cleaned.length > 0) {
    return { name: cleaned, nameSource: "api", desc };
  }
  // No name of ours and none from the cloud: the English label derived from the
  // key. (This is also what an appliance switched off since the tree was built
  // used to keep forever — option names only arrive with a program definition.)
  return { name: humanizeId(id), nameSource: "derived", desc };
}

/** The common door status key, carrying Open/Closed/Locked. */
const DOOR_STATE_KEY = "BSH.Common.Status.DoorState";
/** The operation state key — source of the derived `programRunning` boolean. */
const OPERATION_STATE_KEY = "BSH.Common.Status.OperationState";

/**
 * Whether a key is a door status — the common `DoorState` or a per-compartment
 * `…Status.Door.*` key of the refrigeration family. (Door *settings* like
 * `…Setting.Door.AssistantFreezer` stay on the generic path.)
 *
 * @param key the fully-qualified BSH key
 * @returns whether the key gets the boolean door mapping
 */
export function isDoorStatusKey(key: string): boolean {
  return key === DOOR_STATE_KEY || key.includes(".Status.Door.");
}

/**
 * Expand one BSH item into its idiomatic states. Almost always 1:1
 * ({@link transformItem}), with these exceptions:
 * - an encoded program record (program-records.ts) or an appliance-internal key
 *   (device-internal.ts, decision 48) expands to nothing;
 * - a door status becomes boolean `doorOpen` (+ `doorLocked` on appliance types
 *   whose door locks), a per-compartment door becomes `door<Compartment>Open`;
 * - the operation state additionally feeds the derived boolean `programRunning`.
 *
 * @param item the BSH status / setting / option / event item
 * @param lockableDoor whether the appliance type has a lockable door
 * @returns the transformed states ready to create and set
 */
export function expandBshItem(item: BshItem, lockableDoor: boolean): TransformedState[] {
  // An encoded program record has no datapoint of its own (see program-records.ts):
  // its readable datapoints come from the decoder, and an old raw one is migrated away.
  if (isProgramRecordKey(item.key)) {
    return [];
  }
  // An appliance-internal key (connection, firmware) never becomes a datapoint, and an old one is migrated away
  // (decision 48).
  if (isDeviceInternalKey(item.key)) {
    return [];
  }
  // No value in, no value out — at EVERY expansion. A key-only item (the cloud
  // sends them: a response carries only what the appliance reports right now)
  // must not become `false` for a door, the running flag or an event; the
  // fallback path below already keeps an absent value absent.
  if (isDoorStatusKey(item.key)) {
    const short = typeof item.value === "string" ? shortEnum(item.value) : undefined;
    if (item.key === DOOR_STATE_KEY) {
      const states: TransformedState[] = [
        {
          channel: "status",
          id: "doorOpen",
          common: { ...booleanCommon(tName("doorOpen"), "sensor.door", false), desc: tName("doorOpenDesc") },
          nameSource: "i18n",
          value: short === undefined ? undefined : short === "open",
        },
      ];
      if (lockableDoor) {
        states.push({
          channel: "status",
          id: "doorLocked",
          common: { ...booleanCommon(tName("doorLocked"), "indicator", false), desc: tName("doorLockedDesc") },
          nameSource: "i18n",
          value: short === undefined ? undefined : short === "locked",
        });
      }
      return states;
    }
    const id = `${stateIdForKey(item.key).id}Open`;
    // The compartment is the key's last segment ("Freezer", "Refrigerator", …).
    const compartment = item.key.split(".").at(-1) ?? "";
    const named = DOOR_COMPARTMENT_NAMES[compartment];
    return [
      {
        channel: "status",
        id,
        common: {
          ...booleanCommon(named ? tName(named) : tName("doorCompartmentOpen", compartment), "sensor.door", false),
          desc: tName("doorCompartmentOpenDesc"),
        },
        nameSource: "i18n",
        value: short === undefined ? undefined : short === "open",
      },
    ];
  }
  const t = transformItem(item);
  if (item.key === OPERATION_STATE_KEY) {
    return [
      t,
      {
        channel: "status",
        id: "programRunning",
        common: {
          ...booleanCommon(tName("programRunning"), "indicator.working", false),
          desc: tName("programRunningDesc"),
        },
        nameSource: "i18n",
        value: t.value === undefined ? undefined : t.value === "run",
      },
    ];
  }
  return [t];
}

/**
 * Transform a program-option *definition* (from `/programs/available/{programKey}`)
 * into a writable options state. Unlike {@link transformItem} the type comes from
 * `option.type` (a definition may carry no value), and the state is writable unless
 * the definition marks it `access: "read"` (then it is a display value of the
 * program). Enum options get `common.states` labels from the adapter's own table in
 * the system language, else the cloud's `displayvalues[]`, else a readable English
 * label; an on/off option becomes a switch. The full allowed values go in
 * `bshValues` for resolving a short write back.
 *
 * @param opt the option definition
 * @returns the writable options state
 */
export function transformOptionDefinition(opt: BshOptionDefinition): TransformedState {
  const { channel, id } = stateIdForKey(opt.key);
  const { name, nameSource, desc } = itemLabel(opt.key, opt.name, id);
  const c = opt.constraints;

  // An option the definition marks access:"read" is a display value of the
  // program (a remaining time, a phase), not something to set.
  const writable = c?.access !== "read";
  // Only the definition's own default becomes the option's value — an invented
  // 0 / false / "" read like a measurement for a program that never ran. A
  // boolean's `common.def: false` is ioBroker's start value, not a reading:
  // js-controller writes it with quality 0x20 (substitute initial value).
  if (opt.type === "Boolean") {
    const common: ioBroker.StateCommon = {
      name,
      desc,
      type: "boolean",
      role: writable ? "switch" : "indicator",
      read: true,
      write: writable,
      def: false,
    };
    return { channel, id, common, nameSource, value: typeof c?.default === "boolean" ? c.default : undefined };
  }

  if (opt.type === "Int" || opt.type === "Double") {
    const common = numberCommon(name, desc, writable, opt.key, opt.unit, c);
    const p = presentationFor(opt.key, opt.unit);
    const def = typeof c?.default === "number" ? c.default : undefined;
    return { channel, id, common, nameSource, value: def !== undefined && p ? toShown(def, p) : def };
  }

  // Enum (allowedvalues) or plain string option.
  const allowed = c?.allowedvalues?.filter(v => v.length > 0);
  if (isSwitchKey(opt.key) && allowed && allowed.length > 0) {
    const common: ioBroker.StateCommon = {
      ...booleanCommon(name, switchRole(opt.key, writable), writable),
      desc,
    };
    return { channel, id, common, nameSource, value: switchState(c?.default), bshValues: allowed };
  }
  const common: ioBroker.StateCommon = { name, desc, type: "string", role: "text", read: true, write: writable };
  let bshValues: string[] | undefined;
  if (allowed && allowed.length > 0) {
    common.states = allowedStates(allowed, c?.displayvalues, shortEnum, opt.lang ?? DEFAULT_LABEL_LANGUAGE, opt.key);
    bshValues = allowed;
  }
  const value = typeof c?.default === "string" ? shortEnum(c.default) : undefined;
  return { channel, id, common, nameSource, value, bshValues };
}

/**
 * Build a `common.states` map from allowed enum values: each labelled in the
 * system language from the adapter's table, else by the cloud's parallel display
 * label, else by a readable English label from the value (never the bare short value).
 *
 * @param allowed the full allowed BSH values
 * @param displayvalues the cloud's parallel labels
 * @param shortOf how a full value becomes its short value
 * @param lang the ioBroker system language
 * @param key the BSH key the values belong to
 * @returns the short-value → label map
 */
function allowedStates(
  allowed: string[],
  displayvalues: string[] | undefined,
  shortOf: (v: string) => string,
  lang: string,
  key: string,
): Record<string, string> {
  const cloud = displayvalues && displayvalues.length === allowed.length ? displayvalues : undefined;
  const states: Record<string, string> = {};
  allowed.forEach((v, i) => {
    states[shortOf(v)] = valueLabel(v, lang, cloud?.[i], key);
  });
  return states;
}

/**
 * Whether a key maps to a writable state: settings are writable (PUT /settings),
 * and the selected program is writable (PUT /programs/selected). Status, events,
 * options and the active program are read-only.
 *
 * @param key the fully-qualified BSH key
 * @returns whether the resulting state should be writable
 */
function isWritable(key: string): boolean {
  const { channel, id } = stateIdForKey(key);
  return channel === "settings" || (channel === "programs" && id === "selectedProgram");
}

/** The keys whose text is an RGB colour (`#rrggbb`). */
const COLOR_KEYS = new Set(["BSH.Common.Setting.AmbientLightCustomColor"]);

/**
 * The value + common part of the transform (id/channel handled by the caller).
 *
 * @param item the BSH item to transform
 * @returns the common fragment, the transformed value, and (for writable enums) the full candidate values
 */
function transformValue(item: BshItem): {
  common: ioBroker.StateCommon;
  nameSource: NameSource;
  /** `undefined` when the item carried no value — see {@link TransformedState.value}. */
  value: ioBroker.StateValue | undefined;
  bshValues?: string[];
  seenValues?: string[];
} {
  const { key, value } = item;
  const { name, nameSource, desc } = itemLabel(key, item.name, stateIdForKey(key).id);
  // A setting the API marks access:"read" is not writable, whatever its channel says.
  const writable = isWritable(key) && item.constraints?.access !== "read";
  const allowed = item.constraints?.allowedvalues?.filter(v => v.length > 0);

  // Events carry an EventPresentState enum → boolean "is present" (always read-only).
  if (key.includes(".Event.") || key === UNNAMED_EVENT_KEY) {
    return {
      common: { ...booleanCommon(name, "indicator.alarm", false), desc },
      nameSource,
      value: value === undefined || value === null ? undefined : value === EVENT_PRESENT,
    };
  }

  // Numeric values → number, carrying unit + min/max when the API supplied them, in the unit a user reads
  // (value-units.ts, decision 47).
  if (typeof value === "number") {
    const p = presentationFor(key, item.unit);
    const common = numberCommon(name, desc, writable, key, item.unit, item.constraints);
    return { common, nameSource, value: p ? toShown(value, p) : value };
  }

  // On/off keys (PowerState, TimeLight, …) → a switch (switch-values.ts). The appliance's own values stay on a
  // writable one for the write path: On, and Off or Standby — whichever it offers.
  if (isSwitchKey(key)) {
    const catalogue = catalogValues(key, value);
    const bshValues = !writable
      ? undefined
      : allowed && allowed.length > 0
        ? allowed
        : catalogue && catalogue.length > 0
          ? [...catalogue]
          : typeof value === "string" && value.length > 0
            ? [value]
            : undefined;
    return {
      common: { ...booleanCommon(name, switchRole(key, writable), writable), desc },
      nameSource,
      value: switchState(value),
      bshValues,
    };
  }

  // Native booleans (RemoteControlActive, ChildLock, …).
  if (typeof value === "boolean") {
    return {
      common: { ...booleanCommon(name, writable ? "switch" : "indicator", writable), desc },
      nameSource,
      value,
    };
  }

  // Enum strings, any value that came with an allowed-values list, and any key the
  // catalogue knows a value set for → short value with a labelled selection list.
  // The list is everything the value can be: the cloud's list (or, without one,
  // the catalogue's), plus every value this datapoint carried that neither names
  // (`seen`), plus the value itself — a value outside its own list is a value the
  // user cannot read (objectsschema: "Only these values are allowed").
  const isEnumString = typeof value === "string" && (value.includes(".EnumType.") || value.includes(".Program."));
  const catalogue = allowed && allowed.length > 0 ? undefined : catalogValues(key, value);
  if (isEnumString || (allowed && allowed.length > 0) || catalogue !== undefined) {
    const base = allowed && allowed.length > 0 ? allowed : [...(catalogue ?? [])];
    const seenValues = [...(item.seen ?? [])];
    if (typeof value === "string" && value.length > 0 && !base.includes(value) && !seenValues.includes(value)) {
      seenValues.push(value);
    }
    const full = [...base, ...seenValues.filter(v => !base.includes(v))];
    // A value list (program lists, enum settings) gets list-unique short values
    // (see shortEnumIn), unique within the WHOLE list the dropdown shows. Options
    // stay on the plain tail: their union across programs can hold the same
    // option of two appliance families under one id, and those mean the same
    // thing — one short value each (the write path picks the family).
    const inList = stateIdForKey(item.key).channel !== "options" ? full : undefined;
    const shortOf = (v: string): string => (inList ? shortEnumIn(v, inList) : shortEnum(v));
    // No value in, no value out: an absent value stays absent here too — "" is
    // the idle program only when the item says "" (a key-only enum setting wrote
    // an empty string over the reading).
    const short = typeof value === "string" ? (value.length > 0 ? shortOf(value) : "") : undefined;
    const common: ioBroker.StateCommon = { name, desc, type: "string", role: "text", read: true, write: writable };
    const lang = item.lang ?? DEFAULT_LABEL_LANGUAGE;
    const display = item.constraints?.displayvalues;
    const cloudLabels = allowed && display && display.length === allowed.length ? display : undefined;
    const states: Record<string, string> = {};
    if (PROGRAM_ITEM_NAMES[key]) {
      // The idle program is a value of its own ("" = no program), and it reads as one.
      states[""] = noProgramLabel(lang);
    }
    for (const v of full) {
      const i = allowed ? allowed.indexOf(v) : -1;
      states[shortOf(v)] = valueLabel(v, lang, i >= 0 ? cloudLabels?.[i] : undefined, key);
    }
    if (full.length > 0) {
      common.states = states;
    }
    // The cloud's list is kept on the object whenever it comes (it is the list a
    // later answer WITHOUT constraints falls back to — the catalogue never
    // replaces what the cloud said). A writable enum without one resolves a write
    // against the catalogue's list, else the value itself. A value only SEEN (a
    // program chosen at the appliance that the cloud does not offer) is in the
    // list, but not a write candidate — the cloud would refuse it.
    const bshValues =
      allowed && allowed.length > 0
        ? allowed
        : writable
          ? catalogue && catalogue.length > 0
            ? [...catalogue]
            : short !== undefined && short.length > 0
              ? [value as string]
              : undefined
          : undefined;
    return {
      common,
      nameSource,
      value: short,
      bshValues,
      ...(seenValues.length > 0 ? { seenValues } : {}),
    };
  }

  // Fallback: keep the raw value as a string, so nothing is lost. An absent value
  // stays absent — `JSON.stringify` turned a key-only item into `undefined` (which
  // then overwrote a good reading) and a real `null` into the TEXT "null".
  // A colour the user picks ("#rrggbb") is a colour, not a text (Home Assistant: the ambient light's own colour).
  const role = COLOR_KEYS.has(key) && writable ? "level.color.rgb" : "text";
  return {
    common: { name, desc, type: "string", role, read: true, write: writable },
    nameSource,
    value:
      typeof value === "string" ? value : value === undefined || value === null ? undefined : JSON.stringify(value),
  };
}

/**
 * A number `common` in the unit a user reads: the unit, bounds and step of the appliance, converted where the
 * datapoint shows another unit (value-units.ts), the cloud's unit word in ioBroker's spelling otherwise.
 *
 * @param name the state name
 * @param desc the explanation
 * @param writable whether the state is writable
 * @param key the fully-qualified BSH key
 * @param unit the unit the appliance sent
 * @param constraints the appliance's bounds and step
 * @returns the number common fragment
 */
function numberCommon(
  name: ioBroker.StringOrTranslated,
  desc: ioBroker.StringOrTranslated | undefined,
  writable: boolean,
  key: string,
  unit: string | undefined,
  constraints: ParsedConstraints | undefined,
): ioBroker.StateCommon {
  const common: ioBroker.StateCommon = {
    name,
    desc,
    type: "number",
    role: writable ? "level" : "value",
    read: true,
    write: writable,
  };
  const p = presentationFor(key, unit);
  const shown = shownUnit(key, unit);
  if (shown) {
    common.unit = shown;
  }
  if (typeof constraints?.min === "number") {
    common.min = p ? boundShown(constraints.min, p, "min") : constraints.min;
  }
  if (typeof constraints?.max === "number") {
    common.max = p ? boundShown(constraints.max, p, "max") : constraints.max;
  }
  if (typeof constraints?.stepsize === "number") {
    common.step = p ? boundShown(constraints.stepsize, p, "step") : constraints.stepsize;
  }
  return common;
}

/**
 * A boolean `common` with the given role and writability.
 *
 * @param name the state name (a translation object for the adapter's own states)
 * @param role the ioBroker role
 * @param writable whether the state is writable
 * @returns the boolean common fragment
 */
function booleanCommon(name: ioBroker.StringOrTranslated, role: string, writable: boolean): ioBroker.StateCommon {
  return { name, type: "boolean", role, read: true, write: writable, def: false };
}
