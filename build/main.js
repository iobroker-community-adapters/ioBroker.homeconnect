"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  Homeconnect: () => Homeconnect
});
module.exports = __toCommonJS(main_exports);
var import_node_path = require("node:path");
var utils = __toESM(require("@iobroker/adapter-core"));
var import_adapter_core = require("@iobroker/adapter-core");
var import_oauth = require("./lib/oauth");
var import_http = require("./lib/http");
var import_appliance_sync = require("./lib/appliance-sync");
var import_auth_controller = require("./lib/auth-controller");
var import_device_move = require("./lib/device-move");
var import_enum_carry = require("./lib/enum-carry");
var import_event_stream = require("./lib/event-stream");
var import_pure_helpers = require("./lib/pure-helpers");
var import_sign_in_help = require("./lib/sign-in-help");
var import_native_key_migration = require("./lib/native-key-migration");
var import_settings_migrations = require("./lib/settings-migrations");
var import_log_dedup = require("./lib/log-dedup");
const DEFAULT_BASE_URL = "https://api.home-connect.com";
const RATE_PAUSE_FALLBACK_MS = 6e4;
const MIN_REQUEST_GAP_MS = 100;
const STREAM_OUTAGE_RESYNC_MS = 6e4;
const RECONNECT_SYNC_COOLDOWN_MS = 60 * 6e4;
const SYSTEM_TO_BSH_LOCALE = {
  de: "de-DE",
  en: "en-GB",
  ru: "ru-RU",
  pt: "pt-PT",
  nl: "nl-NL",
  fr: "fr-FR",
  it: "it-IT",
  es: "es-ES",
  pl: "pl-PL",
  uk: "uk-UA",
  "zh-cn": "zh-CN"
};
const NOTIFY_SCOPE = "homeconnect";
const NOTIFY_CATEGORY = "userActionRequired";
const NO_PROGRAM_ANSWERS = /* @__PURE__ */ new Set(["SDK.Error.NoProgramActive", "SDK.Error.NoProgramSelected"]);
const BUSY_ANSWERS = /* @__PURE__ */ new Set(["SDK.Error.WrongOperationState", "SDK.Error.ProgramNotAvailable"]);
const UNSUPPORTED_ANSWERS = /* @__PURE__ */ new Set(["SDK.Error.UnsupportedProgram"]);
const NOT_READY_ANSWERS = /* @__PURE__ */ new Set(["SDK.Error.HomeAppliance.Connection.Initialization.Failed"]);
class Homeconnect extends utils.Adapter {
  // Construction seams for the three collaborators. Production uses the real
  // classes; the orchestration tests swap them for fakes so onReady's wiring, the
  // REST paths and the teardown are testable without a network. Behaviour is
  // unchanged — same constructors, same arguments.
  makeSync = (port) => new import_appliance_sync.ApplianceSync(port);
  makeAuthController = (auth, port) => new import_auth_controller.AuthController(auth, port);
  makeEventStream = (deps) => new import_event_stream.EventStream(deps);
  authCtl;
  eventStream;
  sync;
  /** Epoch-ms until which REST calls are paused after a 429 (honours Retry-After). */
  restBlockedUntil = 0;
  /**
   * The ioBroker system language (`system.config.language`), read once in onReady.
   * `this.language` stays empty for an adapter that does not declare
   * `useFormatDate` (js-controller 7.2.2) — reading it left every value label
   * English and never sent an Accept-Language to the cloud.
   */
  systemLanguage;
  /** Epoch-ms of the next REST request slot (see {@link MIN_REQUEST_GAP_MS}). */
  nextRequestAt = 0;
  /**
   * Set the moment onUnload runs. The sign-in/sync chain is fire-and-forget; on
   * a stop right after start it would otherwise keep syncing past the teardown
   * and even re-open the event stream — whose timer the host then refuses with
   * "setTimeout called, but adapter is shutting down".
   */
  terminating = false;
  /** warn-once-per-category dedup for REST failures (keyed on call source + status band). */
  restLog = new import_log_dedup.LogDedup();
  /**
   * The two halves of `info.connection`, owned here so the flag has ONE writer:
   * the sign-in (a usable token) and the live event stream. Either half alone
   * used to write the flag — a routine token refresh flipped it green while the
   * stream was down, and the next reconnect attempt flipped it back.
   */
  signedIn = false;
  streamUp = false;
  /** Epoch-ms the event stream went down, while it is down (undefined = up / never dropped). */
  streamDownSince;
  /** Whether the stream was up at least once this run — the first connect needs no re-read. */
  streamEverUp = false;
  /** Epoch-ms of the last outage re-read, for the cooldown. */
  lastReconnectSync = 0;
  /** The deferred outage re-read, while one is waiting out the cooldown. */
  resyncTimer;
  /**
   * @param options adapter options passed through by js-controller
   */
  constructor(options = {}) {
    super({
      ...options,
      name: "homeconnect"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  /** Adapter start. Async body with a top-level try/catch (never a call-site .catch). */
  async onReady() {
    try {
      if (await (0, import_native_key_migration.migrateNativeKeys)(this, import_settings_migrations.SETTINGS_MIGRATIONS, import_pure_helpers.errMessage)) {
        return;
      }
      await this.setStateChangedAsync("info.connection", { val: false, ack: true });
      await this.setStateChangedAsync("auth.signedIn", { val: false, ack: true });
      await this.setStateChangedAsync("auth.lastError", { val: "Unknown", ack: true });
      await import_adapter_core.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
      await this.refreshManifestObjects();
      this.systemLanguage = await this.readSystemLanguage();
      const sync = this.makeSync(this.makePort());
      this.sync = sync;
      const steps = [
        ["legacy cleanup", () => sync.sortOutLegacyTrees()],
        ["device id migration", () => sync.migrateDeviceIds()],
        ["datapoint migration", () => sync.migrateRenamedStates()],
        ["priming", () => sync.primeFromObjects()],
        ["reachable stamp", () => sync.markAllUnreachable()]
      ];
      for (const [name, step] of steps) {
        if (this.terminating) {
          this.log.debug(`start-up stopped before the ${name} \u2014 the adapter is shutting down.`);
          return;
        }
        try {
          await step();
        } catch (e) {
          if (this.terminating) {
            this.log.debug(`start-up chain stopped at the ${name}: ${(0, import_pure_helpers.errMessage)(e)}`);
          } else {
            this.log.error(`Start-up failed at the ${name}: ${(0, import_pure_helpers.errMessage)(e)}`);
          }
          return;
        }
      }
      const clientId = typeof this.config.clientID === "string" ? this.config.clientID.trim() : "";
      const clientSecret = typeof this.config.clientSecret === "string" ? this.config.clientSecret.trim() : "";
      if (!clientId) {
        this.log.warn(
          "No Home Connect Client ID configured \u2014 open the adapter settings and enter the Client ID of your developer application."
        );
        return;
      }
      if (!(0, import_sign_in_help.looksLikeClientId)(clientId)) {
        this.log.warn(
          `The Client ID does not look like one of Home Connect (64 hexadecimal characters, this one has ${clientId.length} characters) \u2014 copy it again from the developer portal.`
        );
      }
      const auth = new import_oauth.HomeConnectAuth(
        { clientId, clientSecret, baseUrl: DEFAULT_BASE_URL },
        (path, form) => (0, import_http.postForm)(DEFAULT_BASE_URL, path, form)
      );
      this.authCtl = this.makeAuthController(auth, this.makeAuthPort());
      await this.authCtl.start();
    } catch (e) {
      this.log.error(`onReady failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /**
   * Give the instance's own objects (the manifest's `instanceObjects`) their
   * current name and explanation on EVERY start.
   *
   * js-controller does apply the manifest at each start, but with
   * `preserve: { common: ["name"] }` — so a renamed datapoint reaches new
   * installations only, while an existing tree keeps whatever the version that
   * first created it wrote. Neither the manifest, nor a test, nor a gate shows
   * that; only the real tree of an updated installation does. The adapter owns
   * its datapoints, so it writes them itself.
   *
   * The ids stand at the call, spelled out, instead of in a loop over a table:
   * that is what makes the connection to the manifest greppable — and it is what
   * the fleet's consistency gate reads to prove every manifest object is
   * actually reached.
   *
   * Texts come from `admin/i18n`, the same source the manifest is generated
   * from, so the two can never drift apart. The two channels have nothing to
   * explain and get no description.
   */
  async refreshManifestObjects() {
    const t = (key) => import_adapter_core.I18n.getTranslatedObject(key);
    try {
      await this.extendObject("auth", { common: { name: t("authChannel") } });
      await this.extendObject("auth.session", { common: { name: t("session"), desc: t("sessionDesc") } });
      await this.extendObject("auth.verificationUrl", {
        common: { name: t("verificationUrl"), desc: t("verificationUrlDesc") }
      });
      await this.extendObject("auth.signedIn", { common: { name: t("signedIn"), desc: t("signedInDesc") } });
      await this.extendObject("auth.lastError", { common: { name: t("lastError"), desc: t("lastErrorDesc") } });
      await this.extendObject("info", { common: { name: t("channelInfo") } });
      await this.extendObject("info.connection", { common: { name: t("connection"), desc: t("connectionDesc") } });
      await this.extendObject("info.devicesTotal", {
        common: { name: t("devicesTotal"), desc: t("devicesTotalDesc") }
      });
      await this.extendObject("info.devicesOnline", {
        common: { name: t("devicesOnline"), desc: t("devicesOnlineDesc") }
      });
      await this.extendObject("info.devicesAllOnline", {
        common: { name: t("devicesAllOnline"), desc: t("devicesAllOnlineDesc") }
      });
    } catch (e) {
      this.log.debug(`Could not refresh the manifest object names: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /** Build the port ApplianceSync talks to the adapter through. */
  makePort() {
    return {
      namespace: this.namespace,
      log: this.log,
      language: this.systemLanguage,
      extendObject: (id, obj) => this.extendObject(id, obj),
      setState: (id, state) => this.setState(id, state),
      setStateChanged: (id, state) => this.setStateChangedAsync(id, state),
      getState: (id) => this.getStateAsync(id),
      getObject: (id) => this.getObjectAsync(id),
      delObject: (id) => this.delObjectAsync(id),
      delObjectRecursive: (id) => this.delObjectAsync(id, { recursive: true }),
      getForeignObjects: (pattern, type) => this.getForeignObjectsAsync(pattern, type),
      getAdapterObjects: () => this.getAdapterObjectsAsync(),
      getForeignStates: (pattern) => this.getForeignStatesAsync(pattern),
      setForeignObject: (id, obj) => this.setForeignObject(id, obj),
      extendForeignObject: (id, patch) => this.extendForeignObjectAsync(id, patch),
      setForeignState: (id, state) => this.setForeignStateAsync(id, state),
      getAliases: () => this.getForeignObjectsAsync("alias.*", "state"),
      getEnums: async () => {
        var _a;
        return (_a = await this.getForeignObjectsAsync("enum.*", "enum")) != null ? _a : {};
      },
      deleteTreeCarryingEnums: (root, carry) => this.deleteTreeCarryingEnums(root, carry),
      apiGet: (path) => this.apiGet(path),
      apiWrite: (req) => this.apiWrite(req),
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: (handle) => this.clearTimeout(handle)
    };
  }
  /**
   * Delete a whole tree and carry the room and function assignments of its objects to the ids that
   * take their place — through the fleet helper, in its order: the assignments are read first, the
   * tree is deleted, the new ids are written last. The delete removes the old ids from every enum,
   * written back from the adapter's enum cache, and would take away an id written before it.
   *
   * @param root the namespace-relative root that goes away
   * @param carry old full id → the full ids that take its place
   * @returns how many room/function entries now list one of the new ids
   */
  async deleteTreeCarryingEnums(root, carry) {
    var _a;
    const members = (0, import_device_move.enumMembersUnder)(await this.getForeignObjectsAsync("enum.*", "enum"), `${this.namespace}.${root}`);
    const carried = /* @__PURE__ */ new Set();
    let remove = async () => this.delObjectAsync(root, { recursive: true });
    for (const oldId of members) {
      for (const newId of (_a = carry.get(oldId)) != null ? _a : []) {
        const inner = remove;
        remove = async () => {
          for (const enumId of await (0, import_enum_carry.moveWithEnums)(this, oldId, newId, inner, import_pure_helpers.errMessage)) {
            carried.add(`${enumId}|${newId}`);
          }
        };
      }
    }
    await remove();
    return carried.size;
  }
  /** Build the port the AuthController drives the sign-in lifecycle through. */
  makeAuthPort() {
    return {
      log: this.log,
      loadRefreshToken: () => this.loadRefreshToken(),
      saveToken: (token) => this.saveToken(token),
      setVerificationUrl: async (url) => {
        await this.setState("auth.verificationUrl", { val: url, ack: true });
      },
      setConnected: async (connected) => {
        this.signedIn = connected;
        await this.publishConnection();
      },
      setProblem: async (text) => {
        await this.setStateChangedAsync("auth.lastError", { val: text, ack: true });
      },
      clearStoredLogin: async () => {
        await this.setState("auth.session", { val: "", ack: true });
      },
      notify: (message) => this.notifyUser(message),
      onSignedIn: () => this.onAuthenticated(),
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: (handle) => this.clearTimeout(handle),
      setIntervalTimer: (cb, ms) => this.setInterval(cb, ms),
      clearIntervalTimer: (handle) => this.clearInterval(handle)
    };
  }
  /**
   * Read the refresh token out of `auth.session`, handling both our own encrypted
   * format and the previous adapter's cleartext JSON (so a version update keeps the login).
   *
   * @returns the refresh token, or undefined if none is stored
   */
  async loadRefreshToken() {
    const state = await this.getStateAsync("auth.session");
    const raw = typeof (state == null ? void 0 : state.val) === "string" ? state.val : "";
    if (raw.length === 0) {
      return void 0;
    }
    const direct = (0, import_oauth.extractRefreshToken)(raw);
    if (direct) {
      return direct;
    }
    try {
      return (0, import_oauth.extractRefreshToken)(this.decrypt(raw));
    } catch {
      this.log.warn(
        "The stored Home Connect login cannot be read on this system (it was saved by another ioBroker installation) \u2014 a new sign-in is required."
      );
      return void 0;
    }
  }
  /**
   * Persist a freshly obtained token, encrypted.
   *
   * @param token the token to store
   */
  async saveToken(token) {
    await this.setState("auth.session", { val: this.encrypt(JSON.stringify(token)), ack: true });
  }
  /**
   * After a successful sign-in (the first one, and every re-sign-in at runtime):
   * read the appliances, subscribe, open the stream. The local steps (migrations,
   * priming, the unreachable stamp) ran once in onReady.
   *
   * Every step is gated on `terminating`. The chain is fire-and-forget, each of
   * its steps takes a while, and a stop right after start would otherwise let
   * the sync keep WRITING OBJECTS after onUnload already reported done — the
   * class of defect observed live on v1.12.0 (host warning "setTimeout called,
   * but adapter is shutting down", online markers written after the teardown).
   */
  async onAuthenticated() {
    const sync = this.sync;
    let current = "appliance sync";
    try {
      if (this.terminating) {
        return;
      }
      if (sync) {
        try {
          await sync.syncAppliances();
        } catch (e) {
          if (this.terminating) {
            this.log.debug(`start-up chain stopped at the ${current}: ${(0, import_pure_helpers.errMessage)(e)}`);
            return;
          }
          this.log.error(`Setting up the appliances failed: ${(0, import_pure_helpers.errMessage)(e)} \u2014 live updates start anyway.`);
        }
        if (this.terminating) {
          return;
        }
      }
      current = "state subscription";
      await this.subscribeStatesAsync("*");
      this.startEventStream();
    } catch (e) {
      if (this.terminating) {
        this.log.debug(`start-up chain stopped at the ${current}: ${(0, import_pure_helpers.errMessage)(e)}`);
        return;
      }
      this.log.error(`Start-up failed at the ${current}: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /**
   * Open the single persistent event stream (live updates). If it already runs
   * — a re-sign-in at runtime comes through here again — a pending reconnect
   * backoff is cut short instead: the fresh token is what it was waiting for.
   */
  startEventStream() {
    if (this.terminating) {
      return;
    }
    if (this.eventStream) {
      this.eventStream.reconnectNow();
      return;
    }
    this.eventStream = this.makeEventStream({
      baseUrl: DEFAULT_BASE_URL,
      getAccessToken: () => {
        var _a;
        return (_a = this.authCtl) == null ? void 0 : _a.accessToken;
      },
      onEvent: (ev) => {
        var _a;
        return (_a = this.sync) == null ? void 0 : _a.handleStreamEvent(ev);
      },
      onConnected: (connected) => {
        this.streamUp = connected;
        void this.publishConnection();
        this.noteStreamState(connected);
      },
      onUnauthorized: () => {
        var _a, _b;
        return (_b = (_a = this.authCtl) == null ? void 0 : _a.refreshNow()) != null ? _b : Promise.resolve(false);
      },
      // One daily quota for the stream and REST: a 429 on either pauses both.
      onRateLimited: (ms) => this.armRatePause(ms),
      log: (level, msg) => this.log[level](msg),
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: (handle) => this.clearTimeout(handle)
    });
    this.eventStream.start();
  }
  /**
   * Track the event stream's up/down edges and re-read the appliances after an
   * outage that was long enough to have lost something.
   *
   * The stream is the update path, but Home Connect sends no snapshot when it
   * comes back (API research §4.5) — so without this the tree silently keeps its
   * pre-outage values while `info.connection` turns green again, and only a
   * `CONNECTED` event for that very appliance or an adapter restart would ever
   * correct it. An appliance that was online the whole time sends neither.
   *
   * @param connected whether the stream is up now
   */
  noteStreamState(connected) {
    var _a;
    if (!connected) {
      (_a = this.streamDownSince) != null ? _a : this.streamDownSince = Date.now();
      return;
    }
    const downSince = this.streamDownSince;
    this.streamDownSince = void 0;
    if (!this.streamEverUp) {
      this.streamEverUp = true;
      return;
    }
    if (downSince === void 0) {
      return;
    }
    const outageMs = Date.now() - downSince;
    if (outageMs < STREAM_OUTAGE_RESYNC_MS) {
      this.log.debug(`event stream was down for ${Math.round(outageMs / 1e3)} s \u2014 too short to re-read.`);
      return;
    }
    this.scheduleReconnectSync(outageMs);
  }
  /**
   * Run the outage re-read now, or defer it to the end of the cooldown window —
   * the daily request quota is what the cooldown protects, and dropping the
   * re-read instead of deferring it would leave the tree stale exactly when it
   * must not be.
   *
   * @param outageMs how long the stream was down (for the log line)
   */
  scheduleReconnectSync(outageMs) {
    if (this.terminating || this.resyncTimer) {
      return;
    }
    const sinceLast = Date.now() - this.lastReconnectSync;
    if (sinceLast >= RECONNECT_SYNC_COOLDOWN_MS) {
      void this.runReconnectSync(outageMs);
      return;
    }
    const deferBy = RECONNECT_SYNC_COOLDOWN_MS - sinceLast;
    this.log.debug(`re-read after the stream outage deferred by ${Math.round(deferBy / 1e3)} s (request quota).`);
    this.resyncTimer = this.setTimeout(() => {
      this.resyncTimer = void 0;
      void this.runReconnectSync(outageMs, deferBy);
    }, deferBy);
  }
  /**
   * Re-read every appliance after a stream outage (own try/catch — fire-and-forget).
   *
   * @param outageMs how long the stream was down (for the log line)
   * @param heldBackMs how long the cooldown deferred the re-read (0 = ran at once)
   */
  async runReconnectSync(outageMs, heldBackMs = 0) {
    if (this.terminating || !this.sync) {
      return;
    }
    try {
      if (await this.sync.syncAppliances()) {
        this.lastReconnectSync = Date.now();
        const heldBack = heldBackMs <= 0 ? "" : heldBackMs < 6e4 ? ` (held back ${Math.max(1, Math.round(heldBackMs / 1e3))} s to protect the daily request quota)` : ` (held back ${Math.round(heldBackMs / 6e4)} min to protect the daily request quota)`;
        this.log.info(
          `Live updates were interrupted for ${Math.round(outageMs / 1e3)} s \u2014 re-read the appliances${heldBack}.`
        );
      }
    } catch (e) {
      this.log.warn(`re-reading the appliances after the stream outage failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /**
   * Write `info.connection` from its two halves: signed in AND the live stream
   * up. Only then do values actually flow; a valid token with a dead stream is
   * an instance that shows stale data.
   */
  async publishConnection() {
    try {
      await this.setStateChangedAsync("auth.signedIn", { val: this.signedIn, ack: true });
      await this.setStateChangedAsync("info.connection", { val: this.signedIn && this.streamUp, ack: true });
    } catch (e) {
      this.log.debug(`Could not write info.connection: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /**
   * Messages from the admin (the settings panel's "Test connection" button).
   * Async body with a top-level try/catch; every command answers, so the panel
   * never waits on a message that fell through.
   *
   * @param obj the incoming message
   */
  async onMessage(obj) {
    try {
      if (obj.command === "checkConnection") {
        const answer = await this.checkConnection();
        if (obj.callback) {
          this.sendTo(obj.from, obj.command, answer, obj.callback);
        }
        return;
      }
      if (obj.command === "requestSignIn" || obj.command === "resetLogin") {
        const authCtl = this.authCtl;
        const answer = authCtl ? { result: obj.command === "resetLogin" ? await authCtl.resetLogin() : await authCtl.requestSignIn() } : { error: "No Client ID configured \u2014 enter it above and save first." };
        if (obj.callback) {
          this.sendTo(obj.from, obj.command, answer, obj.callback);
        }
        return;
      }
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { error: `Unknown command: ${String(obj.command)}` }, obj.callback);
      }
    } catch (e) {
      this.log.error(`onMessage failed: ${(0, import_pure_helpers.errMessage)(e)}`);
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { error: (0, import_pure_helpers.errMessage)(e) }, obj.callback);
      }
    }
  }
  /**
   * The connection test behind the settings panel's button. Every word of the
   * answer is backed by something actually checked right now: a real request
   * to Home Connect with the current token (refreshed once on a 401), the
   * appliance count from THAT answer, and the live state of the event stream.
   * What cannot be checked is said, not assumed — a rate-limit pause is
   * reported as such instead of spending a call the quota does not have.
   *
   * @returns `{ result }` on success, `{ error }` otherwise (the admin's sendTo contract)
   */
  async checkConnection() {
    var _a, _b, _c, _d, _e, _f;
    if (typeof this.config.clientID !== "string" || this.config.clientID.trim().length === 0) {
      return { error: "No Client ID configured \u2014 enter it above and save first." };
    }
    if (!((_a = this.authCtl) == null ? void 0 : _a.accessToken)) {
      const url = (_b = await this.getStateAsync("auth.verificationUrl")) == null ? void 0 : _b.val;
      return {
        error: typeof url === "string" && url.length > 0 ? "Not signed in yet \u2014 open the sign-in link and confirm the code, then test again." : "Not signed in \u2014 no Home Connect login is stored; the adapter requests a sign-in link at start."
      };
    }
    if (Date.now() < this.restBlockedUntil) {
      const seconds = Math.ceil((this.restBlockedUntil - Date.now()) / 1e3);
      return { error: `Home Connect REST is paused after a rate limit for another ${seconds} s \u2014 try again later.` };
    }
    const sent = this.authCtl.accessToken;
    if (!await this.spaceRequests()) {
      return { error: "The adapter is shutting down." };
    }
    let res = await (0, import_http.getJson)(DEFAULT_BASE_URL, "/api/homeappliances", sent, this.acceptLanguage());
    if (res.status === 401) {
      const fresh = await this.tokenAfter401(sent);
      if (fresh && await this.spaceRequests()) {
        res = await (0, import_http.getJson)(DEFAULT_BASE_URL, "/api/homeappliances", fresh, this.acceptLanguage());
      }
    }
    if (res.status === 429) {
      this.armRatePause((_c = res.retryAfterMs) != null ? _c : RATE_PAUSE_FALLBACK_MS);
    }
    if (res.status === 401 || res.status === 403) {
      return { error: `Home Connect rejected the login (HTTP ${res.status}) \u2014 a new sign-in is required.` };
    }
    if (res.status === 0) {
      return { error: `Home Connect is not reachable: ${(_d = res.error) != null ? _d : "network error"}` };
    }
    if (!res.ok) {
      return { error: `Home Connect answered HTTP ${res.status}: ${(_e = res.error) != null ? _e : "unknown error"}` };
    }
    const list = (0, import_pure_helpers.isRecord)(res.data) && Array.isArray(res.data.homeappliances) ? res.data.homeappliances : void 0;
    if (!list) {
      return {
        error: "Home Connect answered, but not with an appliance list \u2014 the API shape is not what the adapter expects."
      };
    }
    const online = list.filter((a) => (0, import_pure_helpers.isRecord)(a) && a.connected === true).length;
    const stream = this.streamUp ? "Live updates: connected." : `Live updates: NOT connected${((_f = this.eventStream) == null ? void 0 : _f.lastError) ? ` (${this.eventStream.lastError})` : ""} \u2014 the adapter keeps retrying.`;
    return {
      result: `Signed in \u2014 Home Connect listed ${list.length} appliance(s), ${online} of them connected right now. ${stream}`
    };
  }
  /**
   * GET a Home Connect resource with the current access token. Retries once after
   * a 401 (token refreshed), honours a 429 Retry-After pause, and dedups failure
   * logging (first per category → warn, repeats → debug, recovery → info).
   *
   * @param path the endpoint path
   * @returns the unwrapped data; `null` when the appliance answered that there is
   *   none (no program selected / active); `undefined` when nothing is known —
   *   a failure, the rate-limit pause, or a busy appliance
   */
  async apiGet(path) {
    var _a, _b, _c, _d;
    const token = (_a = this.authCtl) == null ? void 0 : _a.accessToken;
    if (this.terminating || !token || this.restPaused(path)) {
      return void 0;
    }
    const source = `GET ${path}`;
    if (!await this.spaceRequests() || this.restPaused(path)) {
      return void 0;
    }
    let res = await (0, import_http.getJson)(DEFAULT_BASE_URL, path, token, this.acceptLanguage());
    if (res.status === 401) {
      const fresh = await this.tokenAfter401(token);
      if (fresh) {
        res = await (0, import_http.getJson)(DEFAULT_BASE_URL, path, fresh, this.acceptLanguage());
      }
    }
    if (!res.ok) {
      const answer = res.error;
      if (answer !== void 0 && NOT_READY_ANSWERS.has(answer)) {
        this.log.debug(`${source}: ${answer} (the appliance is still initializing)`);
        (_b = this.sync) == null ? void 0 : _b.noteNotReady(path);
        return void 0;
      }
      if (answer !== void 0 && (NO_PROGRAM_ANSWERS.has(answer) || BUSY_ANSWERS.has(answer) || UNSUPPORTED_ANSWERS.has(answer))) {
        this.log.debug(`${source}: ${answer} (a normal appliance answer, not an error)`);
        if (this.restLog.recovered(source)) {
          this.log.info(`${source} succeeded again.`);
        }
        if (UNSUPPORTED_ANSWERS.has(answer)) {
          (_c = this.sync) == null ? void 0 : _c.noteUnsupportedProgram(path);
        }
        return NO_PROGRAM_ANSWERS.has(answer) ? null : void 0;
      }
      this.handleRestFailure(source, res);
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
        (_d = this.sync) == null ? void 0 : _d.noteRefused(path);
      }
      return void 0;
    }
    if (this.restLog.recovered(source)) {
      this.log.info(`${source} succeeded again.`);
    }
    return res.data;
  }
  /**
   * Send a resolved write to the Home Connect API (PUT/DELETE), with the same
   * 401-refresh + 429-pause + dedup handling as {@link apiGet}. Unlike the
   * routine sync reads, a write dropped during a rate-limit pause is a lost
   * user action — it gets a visible (deduped) log line.
   *
   * @param req the resolved request
   * @returns the JSON result, or undefined if not signed in / paused
   */
  async apiWrite(req) {
    var _a;
    if (this.terminating) {
      return void 0;
    }
    const source = `${req.method} ${req.path}`;
    const token = (_a = this.authCtl) == null ? void 0 : _a.accessToken;
    if (!token) {
      const level = this.restLog.note(source, "auth");
      this.log[level](`${source} dropped \u2014 not signed in to Home Connect (a new sign-in is pending).`);
      return void 0;
    }
    if (this.dropWhilePaused(source)) {
      return void 0;
    }
    if (!await this.spaceRequests() || this.dropWhilePaused(source)) {
      return void 0;
    }
    let res = await this.sendWrite(req, token);
    if (res.status === 401) {
      const fresh = await this.tokenAfter401(token);
      if (fresh) {
        res = await this.sendWrite(req, fresh);
      }
    }
    if (res.ok) {
      this.log.debug(`${source} ok`);
      if (this.restLog.recovered(source)) {
        this.log.info(`${source} succeeded again.`);
      }
    } else {
      this.handleRestFailure(source, res);
    }
    return res;
  }
  /**
   * Drop a user write while REST is paused after a 429 — visibly (deduped): a
   * dropped write is a lost user action.
   *
   * @param source the call source ("PUT /…")
   * @returns whether the write was dropped
   */
  dropWhilePaused(source) {
    if (Date.now() >= this.restBlockedUntil) {
      return false;
    }
    const seconds = Math.ceil((this.restBlockedUntil - Date.now()) / 1e3);
    const level = this.restLog.note(source, "rate");
    this.log[level](`${source} dropped \u2014 Home Connect REST is paused (rate limit) for another ${seconds} s.`);
    return true;
  }
  /**
   * Pause REST for at least `ms` from now. Never shortens a pause already
   * running: a later 429 without Retry-After (60 s) used to cut a long
   * daily-quota pause down to a minute.
   *
   * @param ms the pause in ms
   */
  armRatePause(ms) {
    this.restBlockedUntil = Math.max(this.restBlockedUntil, Date.now() + ms);
  }
  /**
   * The token to retry with after a 401. If another caller refreshed while this
   * request was on its way, the current token already is the fresh one — a
   * second refresh would only spend the token endpoint's own quota.
   *
   * @param sent the access token the rejected request carried
   * @returns the token to retry with, or undefined when there is none
   */
  async tokenAfter401(sent) {
    var _a, _b, _c;
    const current = (_a = this.authCtl) == null ? void 0 : _a.accessToken;
    if (current && current !== sent) {
      return current;
    }
    return await ((_b = this.authCtl) == null ? void 0 : _b.refreshNow()) ? (_c = this.authCtl) == null ? void 0 : _c.accessToken : void 0;
  }
  /**
   * Perform the actual PUT/DELETE for a resolved request.
   *
   * @param req the resolved request
   * @param token the access token to send with
   * @returns the JSON result
   */
  sendWrite(req, token) {
    return req.method === "DELETE" ? (0, import_http.deleteJson)(DEFAULT_BASE_URL, req.path, token) : (0, import_http.putJson)(DEFAULT_BASE_URL, req.path, token, req.body);
  }
  /**
   * Take the next REST request slot: wait until it is at least
   * {@link MIN_REQUEST_GAP_MS} after the previous one. Callers that overlap
   * (two appliances re-syncing at once) queue up behind each other.
   *
   * @returns false when the adapter started shutting down during the wait —
   *   the request must not go out then
   */
  async spaceRequests() {
    const now = Date.now();
    const untilSlot = this.nextRequestAt - now;
    this.nextRequestAt = Math.max(now, this.nextRequestAt) + MIN_REQUEST_GAP_MS;
    if (untilSlot > 0) {
      await this.delay(untilSlot);
    }
    return !this.terminating;
  }
  /**
   * Whether REST is currently paused after a 429 (with a one-line debug note).
   *
   * @param path the path being attempted (for the log)
   * @returns whether the call should be skipped right now
   */
  restPaused(path) {
    if (Date.now() < this.restBlockedUntil) {
      this.log.debug(`REST paused (rate-limited) \u2014 skipping ${path}`);
      return true;
    }
    return false;
  }
  /**
   * Log a REST failure (deduped) and, on a 429, arm the Retry-After pause —
   * falling back to a fixed pause when the header is missing, so a 429 always
   * pauses.
   *
   * @param source the call source key ("GET /status")
   * @param res the failed result
   */
  handleRestFailure(source, res) {
    var _a, _b;
    if (res.status === 429) {
      this.armRatePause((_a = res.retryAfterMs) != null ? _a : RATE_PAUSE_FALLBACK_MS);
    }
    const level = this.restLog.note(source, (0, import_log_dedup.categorize)(res.status));
    this.log[level](`${source} failed: ${(_b = res.error) != null ? _b : "unknown"}`);
  }
  /**
   * Handle a state change: ignore our own confirmed (ack) updates, else route the
   * user's write to the Home Connect API (ApplianceSync owns the try/catch).
   *
   * @param id the full state id
   * @param state the new state (null on deletion)
   */
  onStateChange(id, state) {
    var _a;
    if (!state || state.ack) {
      return;
    }
    void ((_a = this.sync) == null ? void 0 : _a.handleWrite(id, state.val));
  }
  /**
   * The Accept-Language to request localized names with — the ioBroker system
   * language mapped to a Home Connect locale.
   *
   * @returns a BSH locale like "de-DE", or undefined to let the API default
   */
  acceptLanguage() {
    return this.systemLanguage ? SYSTEM_TO_BSH_LOCALE[this.systemLanguage] : void 0;
  }
  /**
   * The system language from `system.config` — the fleet pattern (CLAUDE_PATTERNS.md,
   * "User-Texte lokalisieren"). Unreadable: none — the labels fall back to English
   * and the cloud picks its language itself.
   *
   * @returns an ioBroker language code, or undefined
   */
  async readSystemLanguage() {
    var _a;
    try {
      const config = await this.getForeignObjectAsync("system.config");
      const language = (_a = config == null ? void 0 : config.common) == null ? void 0 : _a.language;
      return typeof language === "string" && language.length > 0 ? language : void 0;
    } catch (e) {
      this.log.debug(`reading the system language failed: ${(0, import_pure_helpers.errMessage)(e)} \u2014 labels in English`);
      return void 0;
    }
  }
  /**
   * Raise a persistent user-actionable notification (best effort — a missing
   * notification subsystem must never take the adapter down). js-controller has
   * no adapter API to clear a raised notification; a completed sign-in simply
   * stops re-raising it.
   *
   * @param message the user-facing message
   */
  notifyUser(message) {
    this.registerNotification(NOTIFY_SCOPE, NOTIFY_CATEGORY, message).catch(
      (e) => this.log.debug(`Could not raise notification: ${(0, import_pure_helpers.errMessage)(e)}`)
    );
  }
  /**
   * Teardown: stop the collaborators synchronously, then report done only once
   * the final marker writes have landed (the host grants the full stopTimeout;
   * a callback fired before the writes would lose them).
   *
   * @param callback function to invoke once teardown is complete
   */
  onUnload(callback) {
    var _a, _b;
    try {
      this.terminating = true;
      this.signedIn = false;
      this.streamUp = false;
      const authCtl = this.authCtl;
      authCtl == null ? void 0 : authCtl.stop();
      this.authCtl = void 0;
      (_a = this.eventStream) == null ? void 0 : _a.stop();
      this.eventStream = void 0;
      (_b = this.sync) == null ? void 0 : _b.stop();
      if (this.resyncTimer) {
        this.clearTimeout(this.resyncTimer);
        this.resyncTimer = void 0;
      }
      const writes = [
        this.setState("info.connection", { val: false, ack: true }),
        this.setState("auth.signedIn", { val: false, ack: true }),
        // Off: nothing to report (the fleet's reason-text rule) — the next start asks again.
        this.setState("auth.lastError", { val: "Unknown", ack: true })
      ];
      if (authCtl) {
        writes.push(authCtl.settle().then(() => authCtl.persistPendingToken()));
      }
      if (this.sync) {
        writes.push(this.sync.markAllUnreachable());
      }
      void Promise.allSettled(writes).then((results) => {
        for (const r of results) {
          if (r.status === "rejected") {
            this.log.debug(`Final shutdown write failed: ${(0, import_pure_helpers.errMessage)(r.reason)}`);
          }
        }
      }).finally(() => callback());
      return;
    } catch {
      callback();
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new Homeconnect(options);
} else {
  (() => new Homeconnect())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  Homeconnect
});
//# sourceMappingURL=main.js.map
