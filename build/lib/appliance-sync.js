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
var appliance_sync_exports = {};
__export(appliance_sync_exports, {
  ApplianceSync: () => ApplianceSync,
  parseAppliancePath: () => parseAppliancePath
});
module.exports = __toCommonJS(appliance_sync_exports);
var import_value_transformer = require("./value-transformer");
var import_device_catalog = require("./device-catalog");
var import_device_icons = require("./device-icons");
var import_command_dispatch = require("./command-dispatch");
var import_pure_helpers = require("./pure-helpers");
var import_device_id = require("./device-id");
var import_device_move = require("./device-move");
var import_legacy_cleanup = require("./legacy-cleanup");
var import_i18n = require("./i18n");
var import_state_texts = require("./state-texts");
const FAILED_DEF_RETRY_MS = 6 * 60 * 6e4;
const PROGRAM_DEF_GENERATION = 3;
function familyOf(values, key) {
  if (!values || values.length === 0 || !key) {
    return values;
  }
  const cut = key.indexOf(".Option.");
  if (cut < 0) {
    return values;
  }
  const domain = key.slice(0, cut + 1);
  const own = values.filter((v) => v.startsWith(domain));
  return own.length > 0 ? own : values;
}
function confirmedValue(channel, stateId, req, bshValues, written) {
  var _a, _b;
  if (!bshValues || bshValues.length === 0) {
    return written;
  }
  if (channel === "programs" && stateId === "selectedProgram") {
    return typeof ((_a = req.body) == null ? void 0 : _a.key) === "string" ? (0, import_value_transformer.shortEnumIn)(req.body.key, bshValues) : written;
  }
  const sent = (_b = req.body) == null ? void 0 : _b.value;
  if (typeof sent !== "string") {
    return written;
  }
  return channel === "options" ? (0, import_value_transformer.shortEnum)(sent) : (0, import_value_transformer.shortEnumIn)(sent, bshValues);
}
const NOT_READY_RETRY_MS = [3e4, 6e4, 12e4];
const SELECTED_PROGRAM_KEY = "BSH.Common.Root.SelectedProgram";
const ACTIVE_PROGRAM_KEY = "BSH.Common.Root.ActiveProgram";
const CHANNEL_KEYS = {
  info: "channelInfo",
  status: "channelStatus",
  settings: "channelSettings",
  events: "channelEvents",
  programs: "channelPrograms",
  options: "channelOptions",
  commands: "channelCommands"
};
function channelName(channel) {
  const key = CHANNEL_KEYS[channel];
  return key ? (0, import_i18n.tName)(key) : (0, import_pure_helpers.humanizeId)(channel);
}
function sameName(a, b) {
  return a === b || a !== void 0 && b !== void 0 && JSON.stringify(a) === JSON.stringify(b);
}
function storedNameSource(native) {
  const source = native.nameSource;
  return source === "api" || source === "derived" || source === "i18n" ? source : void 0;
}
function stringOrUndef(v) {
  return typeof v === "string" ? v : void 0;
}
function hasRecording(obj) {
  var _a;
  const custom = (_a = obj.common) == null ? void 0 : _a.custom;
  return (0, import_pure_helpers.isRecord)(custom) && Object.keys(custom).length > 0;
}
const OWNED_COMMON_KEYS = ["type", "role", "read", "write", "unit", "min", "max", "step", "states", "def"];
function metaSignature(common, native) {
  const c = common;
  const picked = {};
  for (const key of OWNED_COMMON_KEYS) {
    const v = key === "states" && c[key] !== null && typeof c[key] === "object" ? sortedRecord(c[key]) : c[key];
    if (v !== void 0) {
      picked[key] = v;
    }
  }
  return JSON.stringify({ c: picked, k: native.bshKey, v: native.bshValues });
}
function sortedRecord(v) {
  const rec = v;
  return Object.fromEntries(
    Object.keys(rec).sort().map((k) => [k, rec[k]])
  );
}
function appliancePath(haId, subpath = "") {
  return `/api/homeappliances/${encodeURIComponent(haId)}${subpath}`;
}
function parseAppliancePath(path) {
  const match = /^\/api\/homeappliances\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) {
    return void 0;
  }
  const [, rawHaId, subpath = ""] = match;
  try {
    return { haId: decodeURIComponent(rawHaId), subpath };
  } catch {
    return void 0;
  }
}
function fallbackName(a) {
  for (const field of [a.enumber, a.vib]) {
    if (typeof field === "string" && field.trim().length > 0) {
      return field;
    }
  }
  return void 0;
}
class ApplianceSync {
  /**
   * @param port the injected adapter capabilities
   */
  constructor(port) {
    this.port = port;
  }
  port;
  /** haId → device id (model + number, see device-id.ts), for routing stream events. */
  deviceIdByHaId = /* @__PURE__ */ new Map();
  /** device id → haId, for routing writes back to the appliance. */
  haIdByDeviceId = /* @__PURE__ */ new Map();
  /** Namespace-relative state id → its BSH key + candidate values; also gates object creation. */
  knownStates = /* @__PURE__ */ new Map();
  /** device id → the option ids from the selected program's definition (writable, sent on start). */
  optionKeys = /* @__PURE__ */ new Map();
  /** device ids with an in-flight data sync — serialises concurrent CONNECTED/re-sync events. */
  syncing = /* @__PURE__ */ new Set();
  /**
   * device ids that reconnected WHILE their pass was running: that pass may have
   * read the appliance before the reconnect, so one more pass follows it. A
   * CONNECTED dropped by the serialisation left the appliance unread until its
   * next reconnect or the hourly outage re-read.
   */
  resyncPending = /* @__PURE__ */ new Set();
  /** device id → epoch-ms the running (or last) data pass started. */
  passStartedAt = /* @__PURE__ */ new Map();
  /**
   * `deviceId|bshKey` → epoch-ms the stream last delivered that key. A REST read
   * issued before the stream's newer value must not overwrite it.
   */
  lastStreamAt = /* @__PURE__ */ new Map();
  /** device id → its last written reachable value, the single source for the instance summary. */
  reachableByDeviceId = /* @__PURE__ */ new Map();
  /** device id → its appliance type ("WasherDryer", …) — drives the catalog (events, door form, programs). */
  typeByDeviceId = /* @__PURE__ */ new Map();
  /** device id → the appliance's display name (from the app) — for readable log lines. */
  nameByDeviceId = /* @__PURE__ */ new Map();
  /**
   * device id → program key → its option state ids. The definition cache: each
   * program definition is fetched ONCE, then remembered here and persisted in the
   * device object's native (an internal attribute, not a datapoint) — so a program
   * change or re-sync costs no definition request at all, which keeps the daily
   * request budget untouched and sidesteps the "wrong operation state" refusal
   * while a program runs.
   */
  programDefs = /* @__PURE__ */ new Map();
  /**
   * haId → program keys Home Connect refuses to describe (`UnsupportedProgram`):
   * programs chosen at the appliance that the API does not offer. Remembered for
   * this run only — every turn of the dial to one of them cost a definition
   * request (measured live 2026-09-16 → 2026-09-22), and a firmware update may
   * make one supported, so a restart asks once more.
   */
  unsupportedPrograms = /* @__PURE__ */ new Map();
  /** device ids whose running pass met "connection still initializing" — the pass stops there. */
  notReady = /* @__PURE__ */ new Set();
  /** Request paths the transport just reported as refused for good (a 4xx that is no appliance state). */
  refusedPaths = /* @__PURE__ */ new Set();
  /**
   * `deviceId|definition key` → epoch-ms a definition read was REFUSED for good.
   * Without it such a definition cost one request on every CONNECTED, with no
   * end. A transient failure (5xx, network, rate limit) is not booked: it is
   * asked again next time, or a short outage would leave a program's options
   * unwritable for hours.
   */
  failedDefs = /* @__PURE__ */ new Map();
  /** device id → the armed re-read after "not ready" (at most one per appliance). */
  retryTimers = /* @__PURE__ */ new Map();
  /** device id → how many "not ready" re-reads were armed since the last full read. */
  retryAttempts = /* @__PURE__ */ new Map();
  /**
   * device id → setting key → its static definition, persisted in the device
   * object's native. Fetched once per setting per appliance; every later start
   * and re-sync costs nothing. No generation counter: this cache is new, so it
   * cannot hold anything written by an older version — one gets added if a future
   * transform change ever needs a forced refresh, with the reason.
   */
  settingDefs = /* @__PURE__ */ new Map();
  /** Appliances whose setting cache has unsaved entries — persisted once per sync, not per setting. */
  settingDefsDirty = /* @__PURE__ */ new Set();
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
  rollupBatched = false;
  /**
   * Set by {@link stop}: the adapter is shutting down. A sync pass that is in
   * flight when onUnload runs used to keep going — it marked appliances online
   * and created objects AFTER `markAllUnreachable` had run, so a stopped
   * adapter left half its appliances green (measured 2026-09-15: two of four).
   */
  stopped = false;
  /**
   * device id → signature of the device object as it stands in the database.
   * Primed from the stored object, so a start that changes nothing writes nothing
   * (decision 18: after the one-off repair no start writes an object any more).
   */
  deviceObjSig = /* @__PURE__ */ new Map();
  /**
   * device id → the full program key the write gate is currently armed for. The
   * gate itself only holds option ids, which cannot say WHICH program they came
   * from — so a selection arriving over the stream had no way to notice that the
   * gate belongs to a different program. Keeping the key here makes
   * {@link activateProgramOptions} idempotent (a repeated NOTIFY with the same
   * program costs nothing) and lets a genuine change re-arm it.
   */
  armedProgramByDeviceId = /* @__PURE__ */ new Map();
  /**
   * device ids decided under the current rule ({@link ID_SCHEME}) — their device object carries the
   * mark. A tree without it still has an older id; the sync must not stamp one on it.
   */
  idDecided = /* @__PURE__ */ new Set();
  /**
   * Roots of the previous adapter generation (community 1.6.x) that wait for their appliance: they
   * are adopted — recordings, rooms, functions and aliases carried to the new datapoints — once the
   * appliance list has created the new tree ({@link adoptLegacyTrees}). No tree pass touches them.
   */
  pendingLegacyRoots = /* @__PURE__ */ new Set();
  /**
   * Stop all further tree work: no appliance is marked online, no item is
   * applied, no stream event is routed from now on. Called by onUnload BEFORE
   * `markAllUnreachable` — the offline stamp itself (`setReachable(false)`) stays
   * allowed, it is the shutdown write of decision 9.
   */
  stop() {
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
  noteNotReady(path) {
    const parsed = parseAppliancePath(path);
    const deviceId = parsed ? this.deviceIdByHaId.get(parsed.haId) : void 0;
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
  noteRefused(path) {
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
  mayFetchDef(deviceId, key) {
    const failedAt = this.failedDefs.get(`${deviceId}|${key}`);
    return failedAt === void 0 || Date.now() - failedAt >= FAILED_DEF_RETRY_MS;
  }
  /**
   * Book a definition read that brought nothing: only a refusal for good waits
   * {@link FAILED_DEF_RETRY_MS}; everything else is asked again next time.
   *
   * @param deviceId the id-safe device path segment
   * @param key the setting or program key
   * @param path the request path
   */
  noteDefMiss(deviceId, key, path) {
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
  noteUnsupportedProgram(path) {
    const parsed = parseAppliancePath(path);
    const prefix = "/programs/available/";
    if (!(parsed == null ? void 0 : parsed.subpath.startsWith(prefix))) {
      return;
    }
    let programKey;
    try {
      programKey = decodeURIComponent(parsed.subpath.slice(prefix.length));
    } catch {
      return;
    }
    let refused = this.unsupportedPrograms.get(parsed.haId);
    if (!refused) {
      refused = /* @__PURE__ */ new Set();
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
  relId(fullId) {
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
  label(deviceId) {
    var _a, _b;
    const name = (_b = (_a = this.nameByDeviceId.get(deviceId)) == null ? void 0 : _a.trim()) != null ? _b : "";
    return name.length > 0 && name !== deviceId ? `${name} (${deviceId})` : deviceId;
  }
  /**
   * Prime the in-memory maps from the objects already in the DB, so writes work
   * for an appliance that is offline at start (its objects exist from a previous
   * run but no REST re-sync populated the maps this run). Covers all four write
   * readers: knownStates + optionKeys + the deviceId↔haId maps.
   */
  async primeFromObjects() {
    var _a, _b, _c, _d, _e, _f, _g;
    try {
      const devices = await this.port.getForeignObjects(`${this.port.namespace}.*`, "device");
      const haIdOf = (obj) => {
        var _a2;
        return (_a2 = obj == null ? void 0 : obj.native) == null ? void 0 : _a2.haId;
      };
      for (const [fullId, obj] of Object.entries(devices)) {
        const deviceId = this.relId(fullId);
        const native = (_a = obj.native) != null ? _a : {};
        const moving = typeof native.movingTo === "string" && haIdOf(devices[`${this.port.namespace}.${native.movingTo}`]) === native.haId;
        if (deviceId.length > 0 && !deviceId.includes(".") && typeof native.haId === "string" && !moving) {
          this.deviceIdByHaId.set(native.haId, deviceId);
          this.haIdByDeviceId.set(deviceId, native.haId);
          const idScheme = native.idScheme === import_device_id.ID_SCHEME ? import_device_id.ID_SCHEME : void 0;
          if (idScheme) {
            this.idDecided.add(deviceId);
          }
          if (typeof native.type === "string") {
            this.typeByDeviceId.set(deviceId, native.type);
          }
          if (typeof ((_b = obj.common) == null ? void 0 : _b.name) === "string") {
            this.nameByDeviceId.set(deviceId, obj.common.name);
            this.deviceObjSig.set(
              deviceId,
              JSON.stringify(
                this.deviceObject(
                  deviceId,
                  obj.common.name,
                  {
                    haId: native.haId,
                    type: stringOrUndef(native.type),
                    brand: stringOrUndef(native.brand),
                    vib: stringOrUndef(native.vib),
                    enumber: stringOrUndef(native.enumber),
                    idScheme
                  },
                  // The icon AS STORED, not the one the map would give: an object
                  // written before the adapter had pictograms carries none, and
                  // that difference is exactly what makes the sync write it once.
                  stringOrUndef(obj.common.icon)
                )
              )
            );
          }
          if ((0, import_pure_helpers.isRecord)(native.programOptions)) {
            const defs = {};
            for (const [program, entry] of Object.entries(native.programOptions)) {
              const ids = Array.isArray(entry) ? entry : (0, import_pure_helpers.isRecord)(entry) && Array.isArray(entry.ids) ? entry.ids : void 0;
              if (ids) {
                const v = (0, import_pure_helpers.isRecord)(entry) && typeof entry.v === "number" ? entry.v : 1;
                const keys = (0, import_pure_helpers.isRecord)(entry) && (0, import_pure_helpers.isRecord)(entry.keys) ? Object.fromEntries(
                  Object.entries(entry.keys).filter((kv) => typeof kv[1] === "string")
                ) : void 0;
                defs[program] = {
                  ids: ids.filter((id) => typeof id === "string"),
                  v,
                  ...keys ? { keys } : {}
                };
              }
            }
            this.programDefs.set(deviceId, defs);
          }
          if ((0, import_pure_helpers.isRecord)(native.settingDefs)) {
            const defs = {};
            for (const [key, entry] of Object.entries(native.settingDefs)) {
              if ((0, import_pure_helpers.isRecord)(entry)) {
                defs[key] = {
                  constraints: (0, import_pure_helpers.isRecord)(entry.constraints) ? entry.constraints : void 0,
                  type: typeof entry.type === "string" ? entry.type : void 0
                };
              }
            }
            this.settingDefs.set(deviceId, defs);
          }
        }
      }
    } catch (e) {
      this.port.log.debug(`priming devices from objects failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
    try {
      const objects = await this.port.getForeignObjects(`${this.port.namespace}.*`, "state");
      for (const [fullId, obj] of Object.entries(objects)) {
        const rel = this.relId(fullId);
        if (!this.haIdByDeviceId.has((_c = rel.split(".")[0]) != null ? _c : "")) {
          continue;
        }
        const native = (_d = obj.native) != null ? _d : {};
        const bshKey = typeof native.bshKey === "string" ? native.bshKey : void 0;
        const bshValues = Array.isArray(native.bshValues) ? native.bshValues.filter((v) => typeof v === "string") : void 0;
        const common = (_e = obj.common) != null ? _e : {};
        this.knownStates.set(rel, {
          bshKey,
          bshValues,
          metaSig: metaSignature(common, { bshKey, bshValues }),
          type: common.type,
          name: common.name,
          desc: common.desc,
          hasStates: common.states !== void 0,
          hasValues: bshValues !== void 0,
          nameSource: storedNameSource(native)
        });
        const parts = rel.split(".");
        if (parts.length === 3 && parts[1] === "options" && ((_f = obj.common) == null ? void 0 : _f.write) === true) {
          const deviceId = parts[0];
          const set = (_g = this.optionKeys.get(deviceId)) != null ? _g : /* @__PURE__ */ new Set();
          set.add(parts[2]);
          this.optionKeys.set(deviceId, set);
        }
      }
    } catch (e) {
      this.port.log.debug(`priming known states from objects failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
    await this.refreshLegacyLabels();
    await this.refreshChannelNames();
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
  async refreshLegacyLabels() {
    for (const [rel, known] of this.knownStates) {
      if (known.bshKey === void 0) {
        continue;
      }
      const t = this.expandedLabelFor(rel, known.bshKey);
      if (!t) {
        continue;
      }
      const stored = known.name;
      if (known.nameSource !== void 0) {
        await this.refreshLabel(rel, known, t.common, t.nameSource);
        continue;
      }
      const fromCloud = t.nameSource !== "i18n" && typeof stored === "string" && stored !== rel.slice(rel.lastIndexOf(".") + 1);
      await this.refreshLabel(
        rel,
        known,
        fromCloud ? { ...t.common, name: stored } : t.common,
        fromCloud ? "api" : t.nameSource
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
  expandedLabelFor(rel, bshKey) {
    var _a, _b;
    const parts = rel.split(".");
    if (parts.length < 3) {
      return void 0;
    }
    const lockableDoor = import_device_catalog.LOCKABLE_DOOR_TYPES.has((_b = this.typeByDeviceId.get((_a = parts[0]) != null ? _a : "")) != null ? _b : "");
    const within = parts.slice(1).join(".");
    return (0, import_value_transformer.expandBshItem)({ key: bshKey, value: void 0 }, lockableDoor).find((t) => `${t.channel}.${t.id}` === within);
  }
  /**
   * Give the appliance channels their translated names — the channels of a tree
   * built by an older version still carry the bare id ("events", "status"), and
   * nothing else ever revisits a channel object that exists.
   */
  async refreshChannelNames() {
    var _a, _b;
    try {
      const channels = await this.port.getForeignObjects(`${this.port.namespace}.*`, "channel");
      for (const [fullId, obj] of Object.entries(channels)) {
        const rel = this.relId(fullId);
        const parts = rel.split(".");
        if (parts.length !== 2 || !this.haIdByDeviceId.has((_a = parts[0]) != null ? _a : "")) {
          continue;
        }
        const fresh = channelName(parts[1]);
        if (sameName((_b = obj.common) == null ? void 0 : _b.name, fresh)) {
          continue;
        }
        await this.port.extendObject(rel, { type: "channel", common: { name: fresh }, native: {} });
      }
    } catch (e) {
      this.port.log.debug(`refreshing the channel names failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /**
   * Sort out the trees the previous adapter generation (community 1.6.x) left behind — an update
   * cleans up after itself, the user never deletes objects by hand. A tree nobody attached anything
   * to goes right away. A tree with a recording, a room or function assignment or an alias pointing
   * into it waits for its appliance: once the appliance list has created the new tree and the
   * appliance has been read in full, {@link adoptLegacyTree} carries those over and deletes the old
   * tree. Runs first at start, so no tree pass ever sees a legacy state.
   */
  async sortOutLegacyTrees() {
    try {
      const all = await this.port.getAdapterObjects();
      const relative = {};
      for (const [id, obj] of Object.entries(all)) {
        const rel = this.relId(id);
        if (rel !== id && obj) {
          relative[rel] = { type: obj.type, native: obj.native };
        }
      }
      const roots = (0, import_legacy_cleanup.planLegacyCleanup)(relative);
      if (roots.length === 0) {
        return;
      }
      const attached = await this.attachedIds();
      let removed = 0;
      for (const root of roots) {
        const rootFull = `${this.port.namespace}.${root}`;
        const holds = Object.entries(all).some(
          ([id, obj]) => (id === rootFull || id.startsWith(`${rootFull}.`)) && (attached.has(id) || (obj == null ? void 0 : obj.type) === "state" && hasRecording(obj))
        );
        if (holds) {
          this.pendingLegacyRoots.add(root);
          continue;
        }
        try {
          await this.port.delObjectRecursive(root);
          removed++;
        } catch (e) {
          this.port.log.debug(`legacy cleanup: could not delete ${root}: ${(0, import_pure_helpers.errMessage)(e)}`);
        }
      }
      if (removed > 0) {
        this.port.log.info(
          `Removed ${removed} object tree(s) of the previous adapter generation \u2014 the new device tree replaces them; your sign-in is kept.`
        );
      }
      if (this.pendingLegacyRoots.size > 0) {
        this.port.log.info(
          `${this.pendingLegacyRoots.size} object tree(s) of the previous adapter generation carry recordings, rooms or aliases \u2014 they move to the new datapoints once the appliance has been read.`
        );
      }
    } catch (e) {
      this.port.log.warn(`sorting out the previous adapter generation's trees failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /**
   * The full ids that a room, a function or an alias points at.
   *
   * @returns the ids
   */
  async attachedIds() {
    var _a, _b, _c;
    const ids = /* @__PURE__ */ new Set();
    for (const obj of Object.values(await this.port.getEnums())) {
      const members = (_a = obj == null ? void 0 : obj.common) == null ? void 0 : _a.members;
      if (Array.isArray(members)) {
        for (const member of members) {
          if (typeof member === "string") {
            ids.add(member);
          }
        }
      }
    }
    for (const obj of Object.values(await this.port.getAliases())) {
      const target = (_c = (_b = obj == null ? void 0 : obj.common) == null ? void 0 : _b.alias) == null ? void 0 : _c.id;
      for (const id of typeof target === "string" ? [target] : Object.values((0, import_pure_helpers.isRecord)(target) ? target : {})) {
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
  legacyTargets(rel, deviceId) {
    var _a, _b;
    const parts = rel.split(".");
    const leaf = (_a = parts.at(-1)) != null ? _a : "";
    if (parts.length === 3 && parts[1] === "general" && leaf === "connected") {
      return [`${deviceId}.info.reachable`];
    }
    if (!import_legacy_cleanup.LEGACY_LEAF.test(leaf)) {
      return [];
    }
    const lockable = import_device_catalog.LOCKABLE_DOOR_TYPES.has((_b = this.typeByDeviceId.get(deviceId)) != null ? _b : "");
    return (0, import_value_transformer.expandBshItem)({ key: leaf.replace(/_/g, "."), value: void 0 }, lockable).map(
      (t) => `${deviceId}.${t.channel}.${t.id}`
    );
  }
  /**
   * Hand a legacy tree over to its appliance's new tree and delete it: every recording moves to the
   * datapoint that takes its place — continuing its series under the old id (`aliasId`) where the
   * value type stays the same, as a new series where it changed (a door text became yes/no) — the
   * room and function assignments and the aliases follow. A legacy datapoint without a counterpart
   * goes with the tree; the log line says how many of them carried something.
   *
   * @param deviceId the appliance's new device id
   * @param haId its haId
   */
  async adoptLegacyTree(deviceId, haId) {
    var _a;
    const root = (0, import_device_id.legacyRootOf)(haId);
    if (!this.pendingLegacyRoots.delete(root)) {
      return;
    }
    const ns = this.port.namespace;
    const rootFull = `${ns}.${root}`;
    try {
      const all = await this.port.getAdapterObjects();
      const attached = await this.attachedIds();
      const carry = /* @__PURE__ */ new Map();
      let recordings = 0;
      let lost = 0;
      for (const [id, obj] of Object.entries(all)) {
        if (!obj || obj.type !== "state" || !id.startsWith(`${rootFull}.`)) {
          continue;
        }
        const targets = this.legacyTargets(this.relId(id), deviceId).map((rel) => `${ns}.${rel}`).filter((full) => {
          var _a2;
          return ((_a2 = all[full]) == null ? void 0 : _a2.type) === "state";
        });
        const recorded = hasRecording(obj);
        if (targets.length === 0) {
          if (recorded || attached.has(id)) {
            lost++;
          }
          continue;
        }
        carry.set(id, targets);
        if (!recorded) {
          continue;
        }
        for (const target of targets) {
          const existing = (_a = all[target]) == null ? void 0 : _a.common;
          if ((0, import_pure_helpers.isRecord)(existing == null ? void 0 : existing.custom) && Object.keys(existing.custom).length > 0) {
            continue;
          }
          const custom = JSON.parse(JSON.stringify(obj.common.custom));
          if ((existing == null ? void 0 : existing.type) === obj.common.type) {
            (0, import_device_move.keepHistoryUnder)(custom, id);
          }
          await this.port.extendForeignObject(target, { common: { custom } });
        }
        recordings++;
      }
      const aliases = await (0, import_device_move.retargetAliases)(
        await this.port.getAliases(),
        (id) => {
          var _a2;
          return (_a2 = carry.get(id)) == null ? void 0 : _a2[0];
        },
        (id, obj) => this.port.setForeignObject(id, obj)
      );
      const enums = await this.port.deleteTreeCarryingEnums(root, carry);
      const carried = [
        ...recordings > 0 ? [`${recordings} recording(s)`] : [],
        ...enums > 0 ? [`${enums} room/function entr${enums === 1 ? "y" : "ies"}`] : [],
        ...aliases > 0 ? [`${aliases} alias(es)`] : []
      ];
      this.port.log.info(
        `${this.label(deviceId)}: took over the object tree ${root} of the previous adapter generation${carried.length > 0 ? ` \u2014 ${carried.join(", ")} carried to the new datapoints` : ""}${lost > 0 ? `; ${lost} datapoint(s) with a recording, room or alias have no counterpart and are gone` : ""}.`
      );
    } catch (e) {
      this.pendingLegacyRoots.add(root);
      this.port.log.warn(`${this.label(deviceId)}: taking over the old object tree ${root} failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /**
   * Delete the waiting legacy trees whose appliance is no longer on the account — nothing will ever
   * take them over. Only after a list that named appliances (see {@link syncAppliances}).
   *
   * @param listed the haIds the account listed
   */
  async dropOrphanLegacyTrees(listed) {
    const wanted = new Set([...listed].map(import_device_id.legacyRootOf));
    for (const root of [...this.pendingLegacyRoots]) {
      if (wanted.has(root)) {
        continue;
      }
      this.pendingLegacyRoots.delete(root);
      try {
        await this.port.delObjectRecursive(root);
        this.port.log.info(
          `Removed the object tree ${root} of the previous adapter generation \u2014 its appliance is not on the Home Connect account.`
        );
      } catch (e) {
        this.port.log.debug(`legacy cleanup: could not delete ${root}: ${(0, import_pure_helpers.errMessage)(e)}`);
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
  async migrateDeviceIds() {
    var _a, _b, _c, _d, _e, _f;
    try {
      const devices = await this.port.getForeignObjects(`${this.port.namespace}.*`, "device");
      const byHaId = /* @__PURE__ */ new Map();
      const taken = /* @__PURE__ */ new Set();
      for (const [fullId, obj] of Object.entries(devices)) {
        const id = this.relId(fullId);
        const native = (_a = obj.native) != null ? _a : {};
        if (id.length === 0 || id.includes(".") || typeof native.haId !== "string") {
          continue;
        }
        taken.add(id);
        const name = typeof ((_b = obj.common) == null ? void 0 : _b.name) === "string" && obj.common.name.length > 0 ? obj.common.name : id;
        const trees = (_c = byHaId.get(native.haId)) != null ? _c : [];
        trees.push({ id, name, native });
        byHaId.set(native.haId, trees);
      }
      const moves = [];
      for (const haId of [...byHaId.keys()].sort()) {
        const trees = byHaId.get(haId);
        const journalTargets = new Set(trees.map((t) => t.native.movingTo).filter((v) => typeof v === "string"));
        const eNumberId = (t) => {
          const plate = typeof t.native.enumber === "string" ? (0, import_pure_helpers.slugOf)(t.native.enumber) : "";
          return plate.length > 0 && (t.id === plate || t.id.startsWith(`${plate}-`));
        };
        const kept = (_f = (_e = (_d = trees.find((t) => t.native.idScheme === import_device_id.ID_SCHEME)) != null ? _d : trees.find((t) => journalTargets.has(t.id))) != null ? _e : trees.length > 1 ? trees.find(eNumberId) : void 0) != null ? _f : [...trees].sort((a, b) => a.id.localeCompare(b.id))[0];
        let target;
        const journal = kept.native.movingTo;
        if (kept.native.idScheme === import_device_id.ID_SCHEME) {
          target = kept.id;
        } else if (typeof journal === "string" && journal.length > 0 && !journal.includes(".") && journal !== kept.id) {
          target = journal;
          taken.add(journal);
        } else if ([kept.native.vib, kept.native.enumber].some((v) => typeof v === "string" && v.trim().length > 0)) {
          const own = new Set(trees.map((t) => t.id));
          target = (0, import_device_id.deviceIdFor)(
            { haId, vib: kept.native.vib, enumber: kept.native.enumber, type: kept.native.type },
            new Set([...taken].filter((other) => !own.has(other)))
          );
          taken.add(target);
        }
        if (target === void 0) {
          continue;
        }
        if (target === kept.id) {
          if (kept.native.idScheme !== import_device_id.ID_SCHEME) {
            await this.port.extendObject(kept.id, { native: { idScheme: import_device_id.ID_SCHEME } });
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
      this.port.log.warn(`migrating device ids failed: ${(0, import_pure_helpers.errMessage)(e)} \u2014 the appliances run under their current ids`);
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
  async moveDeviceTree(from, to, name, fillOnly) {
    const ns = this.port.namespace;
    try {
      await this.port.extendObject(from, { native: { movingTo: to } });
      const report = await (0, import_device_move.copyDeviceTree)(this.moveDeps(), from, to, fillOnly);
      const objects = await this.port.getAdapterObjects();
      const carry = /* @__PURE__ */ new Map();
      for (const id of Object.keys(objects)) {
        const next = (0, import_device_move.movedId)(id, `${ns}.${from}`, `${ns}.${to}`);
        if (next) {
          carry.set(id, [next]);
        }
      }
      report.enums = await this.port.deleteTreeCarryingEnums(from, carry);
      const carried = [
        ...report.enums > 0 ? [`${report.enums} room/function entr${report.enums === 1 ? "y" : "ies"}`] : [],
        ...report.aliases > 0 ? [`${report.aliases} alias(es)`] : []
      ];
      this.port.log.info(
        `${fillOnly ? `Appliance "${name}": finished the interrupted move of ${from} to ${to} \u2014 moved ${report.datapoints} more datapoint(s)` : `Appliance "${name}": device id is now ${to} (was ${from}) \u2014 moved ${report.datapoints} datapoint(s)`}${carried.length > 0 ? ` with ${carried.join(", ")}` : ""}${report.history > 0 ? `; ${report.history} recording(s) keep their history` : ""}`
      );
    } catch (e) {
      this.port.log.warn(
        `Appliance "${name}": could not move ${from} to ${to} (${(0, import_pure_helpers.errMessage)(e)}) \u2014 tried again on the next start`
      );
    }
  }
  /**
   * The object and state calls a tree move needs, over the port.
   *
   * @returns the move's dependencies
   */
  moveDeps() {
    return {
      namespace: this.port.namespace,
      objects: () => this.port.getAdapterObjects(),
      states: (pattern) => this.port.getForeignStates(pattern),
      setObject: (id, obj) => this.port.setForeignObject(id, obj),
      extendObject: (id, patch) => this.port.extendForeignObject(id, patch),
      setState: (id, state) => this.port.setForeignState(id, state),
      aliases: () => this.port.getAliases()
    };
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
  async migrateRenamedStates() {
    var _a, _b, _c, _d, _e, _f, _g, _h;
    try {
      const devices = await this.port.getForeignObjects(`${this.port.namespace}.*`, "device");
      const typeByDevice = /* @__PURE__ */ new Map();
      for (const [fullId, obj] of Object.entries(devices)) {
        const deviceId = this.relId(fullId);
        const type = (_a = obj.native) == null ? void 0 : _a.type;
        if (!deviceId.includes(".") && typeof type === "string") {
          typeByDevice.set(deviceId, type);
        }
      }
      const states = await this.port.getForeignObjects(`${this.port.namespace}.*`, "state");
      const remaining = /* @__PURE__ */ new Map();
      for (const fullId of Object.keys(states)) {
        const parts = this.relId(fullId).split(".");
        if (parts.length >= 3) {
          const channelPath = `${parts[0]}.${parts[1]}`;
          remaining.set(channelPath, ((_b = remaining.get(channelPath)) != null ? _b : 0) + 1);
        }
      }
      const drainedCandidates = /* @__PURE__ */ new Set();
      const moved = /* @__PURE__ */ new Map();
      let migrated = 0;
      let history = 0;
      for (const [fullId, obj] of Object.entries(states)) {
        const rel = this.relId(fullId);
        const parts = rel.split(".");
        if (parts.length < 3) {
          continue;
        }
        const deviceId = (_c = parts[0]) != null ? _c : "";
        const channelPath = `${deviceId}.${parts[1]}`;
        const type = typeByDevice.get(deviceId);
        if (type && import_device_catalog.PROGRAMLESS_TYPES.has(type) && parts[1] === "programs") {
          await this.deleteMigratedState(rel, [], channelPath, remaining, drainedCandidates);
          migrated++;
          continue;
        }
        const native = (_d = obj.native) != null ? _d : {};
        if (typeof native.bshKey !== "string") {
          continue;
        }
        const lockable = import_device_catalog.LOCKABLE_DOOR_TYPES.has(type != null ? type : "");
        const current = parts.slice(1).join(".");
        if ((0, import_value_transformer.expandBshItem)({ key: native.bshKey, value: void 0 }, lockable).some(
          (t) => `${t.channel}.${t.id}` === current
        )) {
          continue;
        }
        const oldValue = (_e = await this.port.getState(rel)) == null ? void 0 : _e.val;
        const value = (0, import_value_transformer.isDoorStatusKey)(native.bshKey) && typeof oldValue === "string" ? `BSH.Common.EnumType.DoorState.${oldValue.charAt(0).toUpperCase()}${oldValue.slice(1)}` : oldValue;
        const expanded = (0, import_value_transformer.expandBshItem)({ key: native.bshKey, value }, lockable);
        const oneToOne = expanded.length === 1;
        for (const t of expanded) {
          const newRel = `${deviceId}.${t.channel}.${t.id}`;
          const common = { ...t.common };
          const oldCommon = (_f = obj.common) != null ? _f : {};
          if (oneToOne && t.common.type === oldCommon.type) {
            Object.assign(common, oldCommon);
            if (oldCommon.custom) {
              const custom = JSON.parse(JSON.stringify(oldCommon.custom));
              history += (0, import_device_move.keepHistoryUnder)(custom, fullId);
              common.custom = custom;
            }
            if (t.channel === "settings") {
              common.write = true;
            }
          }
          common.name = t.common.name;
          common.desc = t.common.desc;
          await this.port.extendObject(`${deviceId}.${t.channel}`, {
            type: "channel",
            common: { name: channelName(t.channel) },
            native: {}
          });
          await this.port.extendObject(newRel, {
            type: "state",
            common,
            native: { bshKey: native.bshKey, bshValues: t.bshValues, nameSource: t.nameSource }
          });
          const targetChannel = `${deviceId}.${t.channel}`;
          remaining.set(targetChannel, ((_g = remaining.get(targetChannel)) != null ? _g : 0) + 1);
          const newValue = oneToOne && t.common.type === oldCommon.type ? oldValue : t.value;
          if (newValue !== null && newValue !== void 0) {
            await this.port.setState(newRel, { val: newValue, ack: true });
          }
          this.port.log.debug(`migrated ${rel} \u2192 ${newRel}`);
        }
        const targets = expanded.map((t) => `${this.port.namespace}.${deviceId}.${t.channel}.${t.id}`);
        moved.set(fullId, targets);
        await this.deleteMigratedState(rel, targets, channelPath, remaining, drainedCandidates);
        migrated++;
      }
      const aliases = moved.size > 0 ? await (0, import_device_move.retargetAliases)(
        await this.port.getAliases(),
        (id) => {
          var _a2;
          return (_a2 = moved.get(id)) == null ? void 0 : _a2[0];
        },
        (id, obj) => this.port.setForeignObject(id, obj)
      ) : 0;
      for (const channelPath of drainedCandidates) {
        if (((_h = remaining.get(channelPath)) != null ? _h : 0) === 0) {
          await this.port.delObject(channelPath).catch(() => void 0);
        }
      }
      if (migrated > 0) {
        this.port.log.info(
          `Migrated ${migrated} datapoint(s) to the corrected tree layout${aliases > 0 ? ` with ${aliases} alias(es)` : ""}${history > 0 ? `; ${history} recording(s) keep their history` : ""}.`
        );
      }
    } catch (e) {
      this.port.log.warn(`migrating renamed datapoints failed: ${(0, import_pure_helpers.errMessage)(e)}`);
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
  async deleteMigratedState(rel, targets, channelPath, remaining, drained) {
    var _a;
    try {
      await this.port.deleteTreeCarryingEnums(rel, /* @__PURE__ */ new Map([[`${this.port.namespace}.${rel}`, [...targets]]]));
    } catch (e) {
      this.port.log.debug(`removing ${rel} failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
    remaining.set(channelPath, ((_a = remaining.get(channelPath)) != null ? _a : 1) - 1);
    drained.add(channelPath);
  }
  /**
   * Route a stream event to its device's states.
   *
   * @param event the parsed SSE event
   */
  handleStreamEvent(event) {
    if (this.stopped) {
      return;
    }
    try {
      let parsed;
      try {
        parsed = event.data.length > 0 ? JSON.parse(event.data) : {};
      } catch {
        parsed = {};
      }
      const payload = (0, import_pure_helpers.isRecord)(parsed) ? parsed : {};
      const payloadHaId = typeof payload.haId === "string" && payload.haId.length > 0 ? payload.haId : void 0;
      const haId = payloadHaId != null ? payloadHaId : event.id || void 0;
      if (!haId) {
        return;
      }
      const deviceId = this.deviceIdByHaId.get(haId);
      if (event.event === "CONNECTED" || event.event === "PAIRED") {
        if (deviceId) {
          this.cancelNotReadyRetry(deviceId);
          if (this.syncing.has(deviceId)) {
            this.resyncPending.add(deviceId);
          }
          void this.guarded(async () => {
            await this.setReachable(deviceId, true);
            await this.syncApplianceData(deviceId, haId);
          });
        } else if (event.event === "PAIRED") {
          void this.guarded(() => this.syncAppliances());
        } else {
          void this.guarded(() => this.syncSingleAppliance(haId));
        }
        return;
      }
      if (!deviceId) {
        return;
      }
      if (event.event === "DISCONNECTED") {
        this.cancelNotReadyRetry(deviceId);
        void this.guarded(() => this.setReachable(deviceId, false));
        return;
      }
      if (event.event === "DEPAIRED") {
        this.port.log.info(
          `Appliance ${this.label(deviceId)} was removed from the Home Connect account \u2014 removing its objects.`
        );
        void this.guarded(() => this.removeAppliance(deviceId, haId));
        return;
      }
      const items = Array.isArray(payload.items) ? payload.items : [];
      const now = Date.now();
      for (const raw of items) {
        if ((0, import_pure_helpers.isRecord)(raw)) {
          if (typeof raw.key === "string") {
            this.lastStreamAt.set(`${deviceId}|${raw.key}`, now);
          }
          void this.guarded(() => this.applyBshItem(deviceId, raw, "values"));
        }
      }
    } catch (e) {
      this.port.log.warn(`handling stream event failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /**
   * Run a fire-and-forget async unit with a top-level catch (no unhandled rejection).
   *
   * @param fn the async unit to run
   */
  async guarded(fn) {
    try {
      await fn();
    } catch (e) {
      this.port.log.warn(`appliance sync task failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /** Fetch the paired appliances and build/update their object tree. */
  async syncAppliances() {
    const data = await this.port.apiGet("/api/homeappliances");
    if (!(0, import_pure_helpers.isRecord)(data) || !Array.isArray(data.homeappliances)) {
      this.port.log.debug("appliance list not available \u2014 keeping the current tree.");
      return false;
    }
    const list = data.homeappliances;
    this.port.log.info(`Setting up ${list.length} appliance(s) from the Home Connect account...`);
    const seen = /* @__PURE__ */ new Set();
    this.rollupBatched = true;
    try {
      for (const raw of list) {
        if (this.stopped) {
          break;
        }
        if ((0, import_pure_helpers.isRecord)(raw)) {
          if (typeof raw.haId === "string") {
            seen.add(raw.haId);
          }
          try {
            await this.syncAppliance(raw);
          } catch (e) {
            if (this.stopped) {
              break;
            }
            const who = typeof raw.haId === "string" ? raw.haId : "an appliance";
            this.port.log.warn(`Could not set up ${who}: ${(0, import_pure_helpers.errMessage)(e)} \u2014 the other appliances go on.`);
          }
        }
      }
    } finally {
      this.rollupBatched = false;
    }
    if (this.stopped) {
      return false;
    }
    await this.writeDeviceRollup();
    if (list.length === 0) {
      if (this.deviceIdByHaId.size > 0) {
        this.port.log.warn(
          `Home Connect listed no appliances at all while ${this.deviceIdByHaId.size} are known \u2014 keeping their objects. An appliance removed from the account is dropped on its removal event.`
        );
      }
      return true;
    }
    await this.dropOrphanLegacyTrees(seen);
    for (const [haId, deviceId] of [...this.deviceIdByHaId]) {
      if (!seen.has(haId)) {
        this.port.log.info(
          `Appliance ${this.label(deviceId)} is no longer on the Home Connect account \u2014 removing its objects.`
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
  async syncSingleAppliance(haId) {
    const data = await this.port.apiGet(appliancePath(haId));
    if ((0, import_pure_helpers.isRecord)(data)) {
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
  deviceObject(deviceId, name, native, icon) {
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
        idScheme: native.idScheme
      }
    };
  }
  /**
   * Build the object tree for one appliance under its device id and sync its data
   * (only when currently connected).
   *
   * @param a the appliance record from /api/homeappliances
   */
  async syncAppliance(a) {
    var _a, _b;
    const haId = typeof a.haId === "string" ? a.haId : void 0;
    if (!haId) {
      return;
    }
    const name = (0, import_pure_helpers.cleanLabel)(a.name, (_a = fallbackName(a)) != null ? _a : haId);
    const deviceId = (_b = this.deviceIdByHaId.get(haId)) != null ? _b : this.assignDeviceId(a, haId, name);
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
        idScheme: this.idDecided.has(deviceId) ? import_device_id.ID_SCHEME : void 0
      },
      (0, import_device_icons.deviceIcon)(stringOrUndef(a.type))
    );
    const sig = JSON.stringify(deviceObj);
    if (this.deviceObjSig.get(deviceId) !== sig) {
      await this.port.extendObject(deviceId, deviceObj);
      this.deviceObjSig.set(deviceId, sig);
    }
    if (typeof a.type === "string") {
      this.typeByDeviceId.set(deviceId, a.type);
    }
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
  async ensureEventStates(deviceId) {
    for (const key of (0, import_device_catalog.eventKeysForType)(this.typeByDeviceId.get(deviceId))) {
      const t = (0, import_value_transformer.transformItem)({ key, value: void 0 });
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
   * @returns the namespace-relative state id
   */
  async createState(deviceId, channel, id, common, native, nameSource) {
    const fullId = `${deviceId}.${channel}.${id}`;
    if (this.stopped) {
      return fullId;
    }
    await this.port.extendObject(`${deviceId}.${channel}`, {
      type: "channel",
      common: { name: channelName(channel) },
      native: {}
    });
    await this.port.extendObject(fullId, {
      type: "state",
      common,
      native: { ...native, nameSource }
    });
    this.knownStates.set(fullId, {
      bshKey: native.bshKey,
      bshValues: native.bshValues,
      metaSig: metaSignature(common, native),
      type: common.type,
      name: common.name,
      nameSource,
      desc: common.desc,
      hasStates: common.states !== void 0,
      hasValues: native.bshValues !== void 0
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
  async refreshLabel(fullId, known, common, nameSource) {
    const fresh = common.name;
    const previousName = known.name;
    const previousDesc = known.desc;
    const previousSource = known.nameSource;
    const nameWins = !(nameSource === "derived" && known.nameSource === "api");
    const patch = {};
    if (nameWins && !sameName(known.name, fresh)) {
      patch.common = { name: fresh };
      known.name = fresh;
    }
    if (common.desc !== void 0 && !sameName(known.desc, common.desc)) {
      patch.common = { ...patch.common, desc: common.desc };
      known.desc = common.desc;
    } else if (common.desc === void 0 && known.desc !== void 0) {
      patch.common = { ...patch.common, desc: null };
      known.desc = void 0;
    }
    if (nameWins && known.nameSource !== nameSource) {
      patch.native = { nameSource };
      known.nameSource = nameSource;
    }
    if (patch.common || patch.native) {
      try {
        await this.port.extendObject(fullId, patch);
      } catch (e) {
        known.name = previousName;
        known.desc = previousDesc;
        known.nameSource = previousSource;
        this.port.log.debug(`updating the label of ${fullId} failed: ${(0, import_pure_helpers.errMessage)(e)}`);
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
  async setReachable(deviceId, reachable) {
    if (reachable && this.stopped) {
      return;
    }
    const fullId = `${deviceId}.info.reachable`;
    const common = {
      name: (0, import_i18n.tName)("reachable"),
      desc: (0, import_i18n.tName)("reachableDesc"),
      type: "boolean",
      role: "indicator.reachable",
      read: true,
      write: false,
      def: false
    };
    const known = this.knownStates.get(fullId);
    if (known) {
      await this.refreshLabel(fullId, known, common, "i18n");
    } else {
      await this.createState(deviceId, "info", "reachable", common, {}, "i18n");
    }
    const previous = this.reachableByDeviceId.get(deviceId);
    if (previous !== void 0 && previous !== reachable) {
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
  async writeDeviceRollup() {
    const values = [...this.reachableByDeviceId.values()];
    const online = values.filter(Boolean).length;
    await this.port.setStateChanged("info.devicesTotal", { val: values.length, ack: true });
    await this.port.setStateChanged("info.devicesOnline", { val: online, ack: true });
    await this.port.setStateChanged("info.devicesAllOnline", {
      val: values.length > 0 && online === values.length,
      ack: true
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
  async markAllUnreachable() {
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
  async removeAppliance(deviceId, haId) {
    try {
      await this.port.delObjectRecursive(deviceId);
    } catch (e) {
      this.port.log.debug(`removing the object tree of ${deviceId} failed: ${(0, import_pure_helpers.errMessage)(e)}`);
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
  assignDeviceId(a, haId, name) {
    const deviceId = (0, import_device_id.deviceIdFor)({ haId, vib: a.vib, enumber: a.enumber, type: a.type }, this.takenDeviceIds());
    this.deviceIdByHaId.set(haId, deviceId);
    this.haIdByDeviceId.set(deviceId, haId);
    this.nameByDeviceId.set(deviceId, name);
    this.idDecided.add(deviceId);
    this.port.log.info(`New appliance ${this.label(deviceId)} \u2014 creating its tree.`);
    return deviceId;
  }
  /**
   * Every device id that is in use or reserved: the appliances known to this run, and the trees of
   * the previous adapter generation that still wait for their appliance.
   *
   * @returns the ids a new appliance must not take
   */
  takenDeviceIds() {
    return /* @__PURE__ */ new Set([...this.haIdByDeviceId.keys(), ...this.pendingLegacyRoots]);
  }
  /**
   * Sync a connected appliance's full data tree. Serialised per device so
   * overlapping CONNECTED / re-sync events don't double-fetch or race the maps.
   *
   * @param deviceId the id-safe device path segment
   * @param haId the appliance's haId
   */
  async syncApplianceData(deviceId, haId) {
    if (this.syncing.has(deviceId)) {
      return;
    }
    this.syncing.add(deviceId);
    this.notReady.delete(deviceId);
    this.passStartedAt.set(deviceId, Date.now());
    try {
      const steps = [
        () => this.syncItems(deviceId, haId, "/status", "status"),
        () => this.syncItems(deviceId, haId, "/settings", "settings"),
        () => this.syncPrograms(deviceId, haId),
        () => this.ensureCommands(deviceId, haId)
      ];
      for (const step of steps) {
        if (this.stopped || this.haIdByDeviceId.get(deviceId) !== haId) {
          return;
        }
        await step();
        if (this.notReady.has(deviceId)) {
          this.scheduleNotReadyRetry(deviceId, haId);
          return;
        }
      }
      this.cancelNotReadyRetry(deviceId);
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
  scheduleNotReadyRetry(deviceId, haId) {
    var _a;
    if (this.stopped || this.retryTimers.has(deviceId)) {
      return;
    }
    if (this.reachableByDeviceId.get(deviceId) === false) {
      this.retryAttempts.delete(deviceId);
      return;
    }
    const attempt = (_a = this.retryAttempts.get(deviceId)) != null ? _a : 0;
    if (attempt >= NOT_READY_RETRY_MS.length) {
      this.retryAttempts.delete(deviceId);
      this.port.log.debug(
        `${this.label(deviceId)} did not finish connecting \u2014 its data is read on its next reconnect.`
      );
      return;
    }
    const delay = NOT_READY_RETRY_MS[attempt];
    this.retryAttempts.set(deviceId, attempt + 1);
    this.port.log.debug(`${this.label(deviceId)} is still initializing \u2014 reading it again in ${delay / 1e3} s.`);
    this.retryTimers.set(
      deviceId,
      this.port.setTimer(() => {
        this.retryTimers.delete(deviceId);
        if (this.reachableByDeviceId.get(deviceId) === false) {
          this.retryAttempts.delete(deviceId);
          return;
        }
        void this.guarded(() => this.syncApplianceData(deviceId, haId));
      }, delay)
    );
  }
  /**
   * Drop an appliance's pending "not ready" re-read and its back-off.
   *
   * @param deviceId the id-safe device path segment
   */
  cancelNotReadyRetry(deviceId) {
    const handle = this.retryTimers.get(deviceId);
    if (handle !== void 0) {
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
  async syncItems(deviceId, haId, subpath, arrayKey) {
    const data = await this.port.apiGet(appliancePath(haId, subpath));
    if (!(0, import_pure_helpers.isRecord)(data) || !Array.isArray(data[arrayKey])) {
      return;
    }
    const isSettings = arrayKey === "settings";
    for (const raw of data[arrayKey]) {
      if (this.notReady.has(deviceId)) {
        break;
      }
      if ((0, import_pure_helpers.isRecord)(raw)) {
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
  async withSettingDef(deviceId, haId, raw) {
    var _a;
    if (typeof raw.key !== "string") {
      return raw;
    }
    const cached = (_a = this.settingDefs.get(deviceId)) != null ? _a : {};
    this.settingDefs.set(deviceId, cached);
    let def = cached[raw.key];
    if (!def) {
      if (!this.mayFetchDef(deviceId, raw.key)) {
        return raw;
      }
      const path = appliancePath(haId, `/settings/${encodeURIComponent(raw.key)}`);
      const single = await this.port.apiGet(path);
      if (!(0, import_pure_helpers.isRecord)(single)) {
        this.noteDefMiss(deviceId, raw.key, path);
        return raw;
      }
      def = {
        constraints: (0, import_pure_helpers.isRecord)(single.constraints) ? single.constraints : void 0,
        type: typeof single.type === "string" ? single.type : void 0
      };
      cached[raw.key] = def;
      this.settingDefsDirty.add(deviceId);
    }
    return { ...raw, ...def.type === void 0 ? {} : { type: def.type }, constraints: def.constraints };
  }
  /**
   * Persist the setting definitions of one appliance — once per sync, not per
   * setting, and only when something was actually fetched.
   *
   * @param deviceId the id-safe device path segment
   */
  async persistSettingDefs(deviceId) {
    var _a;
    if (this.stopped || !this.settingDefsDirty.delete(deviceId)) {
      return;
    }
    try {
      await this.port.extendObject(deviceId, { native: { settingDefs: (_a = this.settingDefs.get(deviceId)) != null ? _a : {} } });
    } catch (e) {
      this.settingDefsDirty.add(deviceId);
      this.port.log.debug(`persisting the setting definition cache of ${deviceId} failed: ${(0, import_pure_helpers.errMessage)(e)}`);
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
  async applyBshItem(deviceId, raw, source) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (this.stopped || typeof raw.key !== "string") {
      return;
    }
    const value = (raw.key === SELECTED_PROGRAM_KEY || raw.key === ACTIVE_PROGRAM_KEY) && raw.value === null ? "" : raw.value;
    const lockableDoor = import_device_catalog.LOCKABLE_DOOR_TYPES.has((_a = this.typeByDeviceId.get(deviceId)) != null ? _a : "");
    const staleRead = source === "sync" && ((_b = this.lastStreamAt.get(`${deviceId}|${raw.key}`)) != null ? _b : -1) >= ((_c = this.passStartedAt.get(deviceId)) != null ? _c : Infinity);
    const states = (0, import_value_transformer.expandBshItem)(
      {
        key: raw.key,
        name: typeof raw.name === "string" ? raw.name : void 0,
        value,
        unit: typeof raw.unit === "string" ? raw.unit : void 0,
        constraints: (0, import_value_transformer.parseConstraints)(raw.constraints)
      },
      lockableDoor
    );
    for (const t of states) {
      if (staleRead) {
        t.value = void 0;
      }
      if (t.channel !== "options" && typeof value === "string" && t.value === (0, import_value_transformer.shortEnum)(value) && value.includes(".")) {
        const candidates = (_g = (_e = (_d = this.knownStates.get(`${deviceId}.${t.channel}.${t.id}`)) == null ? void 0 : _d.bshValues) != null ? _e : t.bshValues) != null ? _g : raw.key === ACTIVE_PROGRAM_KEY ? (_f = this.knownStates.get(`${deviceId}.programs.selectedProgram`)) == null ? void 0 : _f.bshValues : void 0;
        if (candidates) {
          t.value = (0, import_value_transformer.shortEnumIn)(value, candidates);
        }
      }
      const valueless = value === void 0 || value === null;
      await this.applyTransformedState(deviceId, raw.key, t, valueless && !staleRead ? "values" : source);
    }
    if (raw.key === SELECTED_PROGRAM_KEY && typeof value === "string" && !staleRead) {
      if (value.length === 0) {
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
   * Create/refresh one transformed state and set its value (the per-state half
   * of {@link applyBshItem}).
   *
   * @param deviceId the id-safe device path segment
   * @param bshKey the source BSH key (shared by all states of an expanded item)
   * @param t the transformed state
   * @param source "sync" (owns metadata) or "values" (value-only)
   */
  async applyTransformedState(deviceId, bshKey, t, source) {
    const fullId = `${deviceId}.${t.channel}.${t.id}`;
    const known = this.knownStates.get(fullId);
    if (!known) {
      await this.createState(deviceId, t.channel, t.id, t.common, { bshKey, bshValues: t.bshValues }, t.nameSource);
    } else {
      if (source === "sync") {
        const sig = metaSignature(t.common, { bshKey, bshValues: t.bshValues });
        if (known.metaSig !== sig && await this.refreshStateObject(fullId, t.common, { bshKey, bshValues: t.bshValues }, known, t.nameSource)) {
          known.bshKey = bshKey;
          known.bshValues = t.bshValues;
          known.metaSig = sig;
          known.type = t.common.type;
        }
      }
      await this.refreshLabel(fullId, known, t.common, t.nameSource);
    }
    if (t.value === void 0) {
      return;
    }
    await this.port.setStateChanged(fullId, { val: t.value, ack: true });
  }
  /**
   * Refresh a state object whose owned metadata changed — by MERGING, never by
   * deleting and re-creating it (the shelly adapter's model, krobi 2026-09-02:
   * „wir halten uns an den Shelly Adapter"). A merge cannot lose anything the
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
  async refreshStateObject(fullId, common, native, known, nameSource) {
    const fresh = { ...common };
    let clearedStates = false;
    let clearedValues = false;
    try {
      if (nameSource === "derived" && known.nameSource === "api" && known.name !== void 0) {
        fresh.name = known.name;
        nameSource = "api";
      }
      const clearCommon = known.hasStates === true && fresh.states !== void 0;
      const clearNative = known.hasValues === true && native.bshValues !== void 0;
      if (clearCommon || clearNative) {
        await this.port.extendObject(fullId, {
          ...clearCommon ? { common: { states: null } } : {},
          ...clearNative ? { native: { bshValues: null } } : {}
        });
        clearedStates = clearCommon;
        clearedValues = clearNative;
      }
      await this.port.extendObject(fullId, { type: "state", common: fresh, native: { ...native, nameSource } });
      known.name = fresh.name;
      known.nameSource = nameSource;
      known.desc = fresh.desc;
      known.hasStates = fresh.states !== void 0 || known.hasStates === true;
      known.hasValues = native.bshValues !== void 0 || known.hasValues === true;
      this.port.log.debug(`refreshed object metadata of ${fullId}`);
      return true;
    } catch (e) {
      this.port.log.warn(`refreshing object metadata of ${fullId} failed: ${(0, import_pure_helpers.errMessage)(e)}`);
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
  async applySelectedProgram(deviceId, selected, knownKeys) {
    const selectedKey = (0, import_pure_helpers.isRecord)(selected) && typeof selected.key === "string" ? selected.key : "";
    if (selectedKey.length > 0 || knownKeys.length > 0 || this.knownStates.has(`${deviceId}.programs.selectedProgram`)) {
      await this.applyBshItem(
        deviceId,
        {
          key: SELECTED_PROGRAM_KEY,
          value: selectedKey,
          ...knownKeys.length > 0 ? { constraints: { allowedvalues: knownKeys } } : {}
        },
        knownKeys.length > 0 ? "sync" : "values"
      );
    }
    if ((0, import_pure_helpers.isRecord)(selected)) {
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
  async syncPrograms(deviceId, haId) {
    var _a, _b, _c;
    if (import_device_catalog.PROGRAMLESS_TYPES.has((_a = this.typeByDeviceId.get(deviceId)) != null ? _a : "")) {
      return;
    }
    const avail = await this.port.apiGet(appliancePath(haId, "/programs/available"));
    const fetchedKeys = (0, import_pure_helpers.isRecord)(avail) && Array.isArray(avail.programs) ? avail.programs.filter(import_pure_helpers.isRecord).map((p) => p.key).filter((k) => typeof k === "string") : void 0;
    if (fetchedKeys) {
      await this.syncProgramDefs(deviceId, haId, fetchedKeys);
    }
    if (this.notReady.has(deviceId)) {
      return;
    }
    const liveKeys = fetchedKeys && fetchedKeys.length > 0 ? fetchedKeys : [];
    const knownKeys = liveKeys.length > 0 ? liveKeys : Object.keys((_b = this.programDefs.get(deviceId)) != null ? _b : {});
    const hasList = ((_c = this.knownStates.get(`${deviceId}.programs.selectedProgram`)) == null ? void 0 : _c.hasStates) === true;
    const listKeys = liveKeys.length > 0 ? liveKeys : hasList ? [] : knownKeys;
    const selected = await this.port.apiGet(appliancePath(haId, "/programs/selected"));
    if (selected !== void 0) {
      await this.applySelectedProgram(deviceId, selected, listKeys);
    }
    const active = await this.port.apiGet(appliancePath(haId, "/programs/active"));
    if (active !== void 0) {
      const activeKey = (0, import_pure_helpers.isRecord)(active) && typeof active.key === "string" ? active.key : "";
      if (activeKey.length > 0 || knownKeys.length > 0 || this.knownStates.has(`${deviceId}.programs.activeProgram`)) {
        await this.applyBshItem(deviceId, { key: ACTIVE_PROGRAM_KEY, value: activeKey }, "sync");
      }
      if ((0, import_pure_helpers.isRecord)(active)) {
        await this.applyProgramOptions(deviceId, active.options);
      }
    }
    if (knownKeys.length > 0) {
      await this.ensureButton(
        deviceId,
        "programs",
        "start",
        (0, import_i18n.tName)("startProgram"),
        "i18n",
        void 0,
        (0, import_i18n.tName)("startProgramDesc")
      );
      await this.ensureButton(
        deviceId,
        "programs",
        "stop",
        (0, import_i18n.tName)("stopProgram"),
        "i18n",
        void 0,
        (0, import_i18n.tName)("stopProgramDesc")
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
  async applyProgramOptions(deviceId, options) {
    if (!Array.isArray(options)) {
      return;
    }
    for (const raw of options) {
      if ((0, import_pure_helpers.isRecord)(raw)) {
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
  async syncProgramDefs(deviceId, haId, programKeys) {
    var _a, _b;
    const cached = (_a = this.programDefs.get(deviceId)) != null ? _a : {};
    this.programDefs.set(deviceId, cached);
    let changed = false;
    const refused = this.unsupportedPrograms.get(haId);
    for (const programKey of programKeys) {
      if (this.notReady.has(deviceId)) {
        break;
      }
      const entry = cached[programKey];
      if (entry && entry.v >= PROGRAM_DEF_GENERATION || (refused == null ? void 0 : refused.has(programKey))) {
        continue;
      }
      if (!this.mayFetchDef(deviceId, programKey)) {
        continue;
      }
      const defPath = appliancePath(haId, `/programs/available/${encodeURIComponent(programKey)}`);
      const def = await this.port.apiGet(defPath);
      if (!(0, import_pure_helpers.isRecord)(def) || !Array.isArray(def.options) && typeof def.key !== "string") {
        if (!((_b = this.unsupportedPrograms.get(haId)) == null ? void 0 : _b.has(programKey))) {
          this.noteDefMiss(deviceId, programKey, defPath);
        }
        continue;
      }
      const options = Array.isArray(def.options) ? def.options : [];
      const ids = [];
      const keys = {};
      for (const raw of options) {
        if ((0, import_pure_helpers.isRecord)(raw)) {
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
        await this.port.extendObject(deviceId, { native: { programOptions: cached } });
      } catch (e) {
        this.port.log.debug(`persisting the program definition cache of ${deviceId} failed: ${(0, import_pure_helpers.errMessage)(e)}`);
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
  async activateProgramOptions(deviceId, haId, programKey) {
    var _a, _b, _c, _d, _e, _f, _g;
    if (this.armedProgramByDeviceId.get(deviceId) === programKey && ((_c = (_b = (_a = this.programDefs.get(deviceId)) == null ? void 0 : _a[programKey]) == null ? void 0 : _b.v) != null ? _c : 0) >= PROGRAM_DEF_GENERATION) {
      return;
    }
    let cached = this.programDefs.get(deviceId);
    if (((_e = (_d = cached == null ? void 0 : cached[programKey]) == null ? void 0 : _d.v) != null ? _e : 0) < PROGRAM_DEF_GENERATION) {
      await this.syncProgramDefs(deviceId, haId, [programKey]);
      cached = this.programDefs.get(deviceId);
    }
    this.optionKeys.set(deviceId, new Set((_g = (_f = cached == null ? void 0 : cached[programKey]) == null ? void 0 : _f.ids) != null ? _g : []));
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
  async applyOptionDefinition(deviceId, raw) {
    if (this.stopped || typeof raw.key !== "string") {
      return void 0;
    }
    const opt = {
      key: raw.key,
      name: typeof raw.name === "string" ? raw.name : void 0,
      type: typeof raw.type === "string" ? raw.type : void 0,
      unit: typeof raw.unit === "string" ? raw.unit : void 0,
      constraints: (0, import_value_transformer.parseConstraints)(raw.constraints)
    };
    const t = (0, import_value_transformer.transformOptionDefinition)(opt);
    const fullId = `${deviceId}.options.${t.id}`;
    const known = this.knownStates.get(fullId);
    if (!known) {
      await this.createState(
        deviceId,
        "options",
        t.id,
        t.common,
        { bshKey: opt.key, bshValues: t.bshValues },
        t.nameSource
      );
      if (t.value !== void 0) {
        await this.port.setStateChanged(fullId, { val: t.value, ack: true });
      }
      return t.id;
    }
    const merged = await this.mergeOptionDefinition(fullId, known, t);
    const sig = metaSignature(merged.common, { bshKey: opt.key, bshValues: merged.bshValues });
    const refreshed = known.metaSig === sig || await this.refreshStateObject(
      fullId,
      merged.common,
      { bshKey: opt.key, bshValues: merged.bshValues },
      known,
      t.nameSource
    );
    if (refreshed) {
      known.bshKey = opt.key;
      known.bshValues = merged.bshValues;
      known.metaSig = sig;
      known.type = merged.common.type;
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
   * @returns the merged common + allowed values
   */
  async mergeOptionDefinition(fullId, known, t) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j;
    const common = { ...t.common };
    let exCommon = {};
    try {
      exCommon = (_b = (_a = await this.port.getObject(fullId)) == null ? void 0 : _a.common) != null ? _b : {};
    } catch (e) {
      this.port.log.debug(`reading ${fullId} for the definition merge failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
    let bshValues = t.bshValues;
    if (((_d = (_c = known.bshValues) == null ? void 0 : _c.length) != null ? _d : 0) > 0 || ((_f = (_e = t.bshValues) == null ? void 0 : _e.length) != null ? _f : 0) > 0) {
      const union = [...(_g = known.bshValues) != null ? _g : []];
      for (const v of (_h = t.bshValues) != null ? _h : []) {
        if (!union.includes(v)) {
          union.push(v);
        }
      }
      bshValues = union;
      const exStates = (0, import_pure_helpers.isRecord)(exCommon.states) ? exCommon.states : {};
      const newStates = (0, import_pure_helpers.isRecord)(common.states) ? common.states : {};
      const states = {};
      for (const v of union) {
        const short = (0, import_value_transformer.shortEnum)(v);
        states[short] = (_j = (_i = exStates[short]) != null ? _i : newStates[short]) != null ? _j : short;
      }
      common.states = states;
    }
    if (typeof exCommon.min === "number") {
      common.min = typeof common.min === "number" ? Math.min(common.min, exCommon.min) : exCommon.min;
    }
    if (typeof exCommon.max === "number") {
      common.max = typeof common.max === "number" ? Math.max(common.max, exCommon.max) : exCommon.max;
    }
    if (common.step === void 0 && typeof exCommon.step === "number") {
      common.step = exCommon.step;
    }
    if (common.unit === void 0 && typeof exCommon.unit === "string") {
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
  async ensureCommands(deviceId, haId) {
    var _a;
    const data = await this.port.apiGet(appliancePath(haId, "/commands"));
    const commands = (0, import_pure_helpers.isRecord)(data) && Array.isArray(data.commands) ? data.commands : [];
    for (const raw of commands) {
      if ((0, import_pure_helpers.isRecord)(raw) && typeof raw.key === "string") {
        const id = (0, import_value_transformer.stateIdForKey)(raw.key).id;
        const texts = (0, import_state_texts.stateText)(raw.key);
        const args = (_a = texts == null ? void 0 : texts.args) != null ? _a : [];
        const desc = (texts == null ? void 0 : texts.desc) ? (0, import_i18n.tName)(texts.desc, ...args) : void 0;
        if (texts == null ? void 0 : texts.name) {
          await this.ensureButton(deviceId, "commands", id, (0, import_i18n.tName)(texts.name, ...args), "i18n", raw.key, desc);
          continue;
        }
        const apiName = (0, import_pure_helpers.cleanLabel)(raw.name);
        if (apiName.length > 0) {
          await this.ensureButton(deviceId, "commands", id, apiName, "api", raw.key, desc);
          continue;
        }
        await this.ensureButton(deviceId, "commands", id, (0, import_pure_helpers.humanizeId)(id), "derived", raw.key, desc);
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
  async ensureButton(deviceId, channel, id, name, nameSource, bshKey, desc) {
    if (this.stopped) {
      return;
    }
    const fullId = `${deviceId}.${channel}.${id}`;
    const common = { name, type: "boolean", role: "button", read: false, write: true };
    if (desc !== void 0) {
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
  async handleWrite(id, value) {
    var _a, _b;
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
      if (channel === "options" && !((_a = this.optionKeys.get(deviceId)) == null ? void 0 : _a.has(stateId))) {
        this.port.log.debug(`Write to ${rel} ignored (not a writable option of the selected program).`);
        return;
      }
      const meta = this.knownStates.get(rel);
      const typed = (0, import_pure_helpers.coerceForType)(value, meta == null ? void 0 : meta.type);
      if (typed === void 0) {
        this.port.log.debug(`Write to ${rel} ignored (${JSON.stringify(value)} is not a ${(_b = meta == null ? void 0 : meta.type) != null ? _b : "value"}).`);
        return;
      }
      value = typed;
      const optionKey = channel === "options" ? this.optionKeyFor(deviceId, stateId, meta == null ? void 0 : meta.bshKey) : void 0;
      const ctx = {
        haId,
        channel,
        id: stateId,
        bshKey: optionKey != null ? optionKey : meta == null ? void 0 : meta.bshKey,
        bshValues: channel === "options" ? familyOf(meta == null ? void 0 : meta.bshValues, optionKey) : meta == null ? void 0 : meta.bshValues,
        collapseEnum: channel === "options",
        value
      };
      if (channel === "programs" && stateId === "start") {
        ctx.selectedProgramKey = await this.resolveSelectedProgramKey(deviceId);
        ctx.selectedOptions = await this.collectSelectedOptions(deviceId);
      }
      const req = (0, import_command_dispatch.resolveWrite)(ctx);
      if (req) {
        const res = await this.port.apiWrite(req);
        await this.postWrite(channel, stateId, deviceId, haId, req, res);
        if (!this.isMomentaryButton(channel, stateId)) {
          if (res == null ? void 0 : res.ok) {
            await this.port.setState(rel, {
              val: confirmedValue(channel, stateId, req, meta == null ? void 0 : meta.bshValues, value),
              ack: true
            });
          } else if (res) {
            await this.readBackAfterRejection(deviceId, haId, channel, stateId, meta == null ? void 0 : meta.bshKey);
          }
        }
      } else {
        const both = (0, import_command_dispatch.ambiguousCandidates)(value, ctx.bshValues);
        if (both.length > 0 && channel !== "options") {
          this.port.log.warn(
            `Write to ${rel} not sent: "${String(value)}" matches ${both.length} programs \u2014 write one of: ${both.map((v) => (0, import_value_transformer.shortEnumIn)(v, ctx.bshValues)).join(", ")}.`
          );
        } else {
          this.port.log.debug(`Write to ${rel} ignored (no matching Home Connect command).`);
        }
      }
      if (this.isMomentaryButton(channel, stateId)) {
        await this.port.setStateChanged(rel, { val: false, ack: true });
      }
    } catch (e) {
      this.port.log.warn(`handling write to ${id} failed: ${(0, import_pure_helpers.errMessage)(e)}`);
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
  optionKeyFor(deviceId, stateId, fallback) {
    var _a, _b, _c;
    const armed = this.armedProgramByDeviceId.get(deviceId);
    const key = armed ? (_c = (_b = (_a = this.programDefs.get(deviceId)) == null ? void 0 : _a[armed]) == null ? void 0 : _b.keys) == null ? void 0 : _c[stateId] : void 0;
    return key != null ? key : fallback;
  }
  /**
   * Whether a state is a momentary button (a press carrying no lasting value).
   *
   * @param channel the state's channel
   * @param stateId the within-channel id
   * @returns whether it is a command / program-start / program-stop button
   */
  isMomentaryButton(channel, stateId) {
    return channel === "commands" || channel === "programs" && (stateId === "start" || stateId === "stop");
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
  async readBackAfterRejection(deviceId, haId, channel, stateId, bshKey) {
    if (channel === "settings" && bshKey !== void 0) {
      const item = await this.port.apiGet(appliancePath(haId, `/settings/${encodeURIComponent(bshKey)}`));
      if ((0, import_pure_helpers.isRecord)(item)) {
        await this.applyBshItem(deviceId, item, "values");
      }
      return;
    }
    if (channel === "options" || channel === "programs" && stateId === "selectedProgram") {
      this.passStartedAt.set(deviceId, Date.now());
      const selected = await this.port.apiGet(appliancePath(haId, "/programs/selected"));
      if (selected !== void 0) {
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
  async resolveSelectedProgramKey(deviceId) {
    var _a;
    const st = await this.port.getState(`${deviceId}.programs.selectedProgram`);
    const short = typeof (st == null ? void 0 : st.val) === "string" ? st.val : "";
    if (short.length === 0) {
      return void 0;
    }
    return (0, import_command_dispatch.resolveEnum)(short, (_a = this.knownStates.get(`${deviceId}.programs.selectedProgram`)) == null ? void 0 : _a.bshValues);
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
  async postWrite(channel, stateId, deviceId, haId, req, res) {
    var _a, _b;
    if (!res) {
      return;
    }
    if (channel === "programs" && stateId === "selectedProgram" && res.ok && ((_a = req.body) == null ? void 0 : _a.key)) {
      await this.activateProgramOptions(deviceId, haId, req.body.key);
      return;
    }
    if (channel === "programs" && stateId === "start" && res.status === 409 && ((_b = req.body) == null ? void 0 : _b.options)) {
      this.port.log.info("Program did not start with the selected options \u2014 retrying with defaults.");
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
  async collectSelectedOptions(deviceId) {
    const result = [];
    const ids = this.optionKeys.get(deviceId);
    if (!ids) {
      return result;
    }
    for (const id of ids) {
      const relId = `${deviceId}.options.${id}`;
      const meta = this.knownStates.get(relId);
      const key = this.optionKeyFor(deviceId, id, meta == null ? void 0 : meta.bshKey);
      if (!key) {
        continue;
      }
      const st = await this.port.getState(relId);
      if (!st || st.val === null || st.val === void 0) {
        continue;
      }
      const values = familyOf(meta == null ? void 0 : meta.bshValues, key);
      const value = values && values.length > 0 ? (0, import_command_dispatch.resolveEnum)(st.val, values, true) : st.val;
      if (value !== void 0 && value !== null) {
        result.push({ key, value });
      }
    }
    return result;
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  ApplianceSync,
  parseAppliancePath
});
//# sourceMappingURL=appliance-sync.js.map
