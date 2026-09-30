import { join } from "node:path";
import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { HomeConnectAuth, extractRefreshToken, type StoredToken } from "./lib/oauth";
import { getJson, postForm, putJson, deleteJson, rateLimitText, type JsonResult } from "./lib/http";
import { ApplianceSync, type AdapterPort } from "./lib/appliance-sync";
import { AuthController, type AuthPort } from "./lib/auth-controller";
import { moveAllWithEnums } from "./lib/enum-carry";
import type { WriteRequest } from "./lib/command-dispatch";
import { EventStream } from "./lib/event-stream";
import { errMessage, isRecord } from "./lib/pure-helpers";
import { looksLikeClientId } from "./lib/sign-in-help";
import { migrateNativeKeys } from "./lib/native-key-migration";
import { SETTINGS_MIGRATIONS } from "./lib/settings-migrations";
import { LogDedup, categorize } from "./lib/log-dedup";
import { ObjectMirror, StateMirror } from "./lib/object-mirror";
import type { I18nKey } from "./lib/i18n";

/** Production API host (global EU/US region; China would be api.home-connect.cn). */
const DEFAULT_BASE_URL = "https://api.home-connect.com";
/** Pause REST this long after a 429 that carries no Retry-After header. */
const RATE_PAUSE_FALLBACK_MS = 60_000;
/**
 * Minimum spacing between two REST requests. Home Connect allows 10 requests
 * per second (leaky bucket, 20 burst) and answers a breach with a 429 that
 * carries NO Retry-After — the adapter then pauses REST for a whole minute.
 * Decision 27 keeps the single-setting reads strictly sequential, but
 * "sequential" only stays under 10/s while the cloud answers slower than
 * 100 ms; this makes the limit mechanically true on every path.
 */
const MIN_REQUEST_GAP_MS = 100;
/**
 * Home Connect allows 50 requests per minute per application and account and blocks further ones for a minute
 * (api-docs → Rate Limiting). A first read with empty definition caches — the update from 1.x — asks dozens of
 * requests per appliance; the transport holds every request to this budget, the event stream's connect included.
 */
const REQUESTS_PER_MINUTE = 50;
/**
 * The budget in force: {@link REQUESTS_PER_MINUTE}, widened only by `HOMECONNECT_REQUESTS_PER_MINUTE` — which the
 * inventory run's fixture server sets (`test/inventory-fetch-hook.cjs`): it answers at once and lists every program of
 * every model, over a thousand requests. The variable can only widen the budget, never narrow it.
 *
 * @returns requests allowed in any minute
 */
function requestsPerMinute(): number {
  const widened = Number(process.env.HOMECONNECT_REQUESTS_PER_MINUTE);
  return Number.isInteger(widened) && widened > REQUESTS_PER_MINUTE ? widened : REQUESTS_PER_MINUTE;
}
/**
 * Home Connect blocks for ten minutes after ten successive requests that end in an error. Definition reads are
 * optional (a selected program fetches its own later), so they stop two short of the limit.
 */
const ERROR_STREAK_LIMIT = 8;
/**
 * An event-stream outage at least this long makes the appliances worth re-reading.
 * Home Connect guarantees NO snapshot after a (re)connect (API research §4.5), so
 * everything that changed while the stream was down is simply missing — the tree
 * would keep showing pre-outage values while the instance reports itself green.
 *
 * Below this, only a clean transport drop after a healthy connection fits: the
 * stream's backoff starts at 5 s with no failures behind it, and practically
 * nothing is lost in that time. An outage the keep-alive watchdog notices is
 * measured from the last traffic, so it counts 130 s at least.
 */
const STREAM_OUTAGE_RESYNC_MS = 60_000;
/**
 * At most one re-read per this window. A re-read costs one request per appliance
 * resource (≈16 for three appliances); the stream's own backoff settles a
 * permanently flapping connection at one reconnect per 5 minutes = 288/day, which
 * unthrottled would be 4608 requests/day against a quota of 1000. An hour keeps
 * the worst case at ~384/day; a due re-read inside the window is DEFERRED to the
 * end of it, never dropped.
 */
const RECONNECT_SYNC_COOLDOWN_MS = 60 * 60_000;
/** ioBroker system language → Home Connect locale for the Accept-Language header. */
const SYSTEM_TO_BSH_LOCALE: Partial<Record<string, string>> = {
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
  "zh-cn": "zh-CN",
};

/** Notification scope + category (declared in io-package.json `notifications`). */
const NOTIFY_SCOPE = "homeconnect";
const NOTIFY_CATEGORY = "userActionRequired";

/**
 * BSH answers that are normal appliance states, not failures. The API ships
 * them as HTTP errors; treating them through the failure path turned every
 * adapter start next to an idle dishwasher into a warning.
 *
 * Two kinds, and `apiGet` must tell them apart: an idle appliance has no
 * active/selected program — that is an ANSWER ("there is none"), and of the ten
 * GET paths the adapter builds only `/programs/selected` and `/programs/active`
 * can give it (Home Connect swagger, 404). A busy appliance refuses the program
 * list ("wrong operation state", 409 on `/programs/available`) — that is NOT an
 * answer, the definition cache covers it and nothing may be concluded from it.
 * `ProgramNotAvailable` belongs to the busy kind: the swagger names it for the
 * single-program path only, but a washer-dryer running a program the API does
 * not know refuses the LIST with it (measured live 2026-09-16 and 2026-09-20).
 */
const NO_PROGRAM_ANSWERS = new Set(["SDK.Error.NoProgramActive", "SDK.Error.NoProgramSelected"]);
const BUSY_ANSWERS = new Set(["SDK.Error.WrongOperationState", "SDK.Error.ProgramNotAvailable"]);
/**
 * A program chosen at the appliance that the API does not offer: Home Connect
 * refuses to describe it (`…/programs/available/{key}`). A permanent property of
 * the appliance, not a failure — and nothing is known about the program, so it
 * stays `undefined`; the sync remembers it for the run.
 */
const UNSUPPORTED_ANSWERS = new Set(["SDK.Error.UnsupportedProgram"]);
/**
 * An appliance just switched on sends CONNECTED before it can answer; until
 * then every read says its connection is still initializing (measured live
 * 2026-09-18/20/23). A state, not a failure — and no proof the endpoint works
 * either, so it neither arms nor clears the failure dedup. The sync stops the
 * pass and reads the appliance again on its own.
 */
const NOT_READY_ANSWERS = new Set(["SDK.Error.HomeAppliance.Connection.Initialization.Failed"]);

/**
 * ioBroker.homeconnect — Home Connect / BSH home appliances (Bosch, Siemens,
 * NEFF, Gaggenau) via the Home Connect cloud API. Greenfield TypeScript rewrite:
 * OAuth device flow, a clean device tree (folders named by the model and the
 * appliance's own number, speaking state ids below), a single live event stream, and a
 * write path that turns state changes back into Home Connect commands.
 */
export class Homeconnect extends utils.Adapter {
  // Construction seams for the three collaborators. Production uses the real
  // classes; the orchestration tests swap them for fakes so onReady's wiring, the
  // REST paths and the teardown are testable without a network. Behaviour is
  // unchanged — same constructors, same arguments.
  private makeSync: (port: AdapterPort) => ApplianceSync = port => new ApplianceSync(port);
  private makeAuthController: (auth: HomeConnectAuth, port: AuthPort) => AuthController = (auth, port) =>
    new AuthController(auth, port);
  private makeEventStream: (deps: ConstructorParameters<typeof EventStream>[0]) => EventStream = deps =>
    new EventStream(deps);

  private authCtl: AuthController | undefined;
  private eventStream: EventStream | undefined;
  private sync: ApplianceSync | undefined;
  /** Epoch-ms until which REST calls are paused after a 429 (honours Retry-After). */
  private restBlockedUntil = 0;
  /**
   * The ioBroker system language (`system.config.language`), read once in onReady.
   * `this.language` stays empty for an adapter that does not declare
   * `useFormatDate` (js-controller 7.2.2) — reading it left every value label
   * English and never sent an Accept-Language to the cloud.
   */
  private systemLanguage: string | undefined;
  /**
   * The own objects as the database holds them, read once in onReady: a write that
   * would change nothing is left out (tooling round 61 — `extendObject` always
   * writes and notifies every subscriber).
   */
  private objectMirror = new ObjectMirror("");
  /** The objects without an object type the database held at the start (decision 48). */
  private untypedAtStart: string[] = [];
  /**
   * The own states' last values, read once in onReady: a read-only state is compared
   * here instead of in the database (tooling round 62 — `setStateChangedAsync` reads
   * the state on every call).
   */
  private readonly stateMirror = new StateMirror();
  /** Send times of the requests within the last minute (see {@link REQUESTS_PER_MINUTE}). */
  private sentAt: number[] = [];
  /** Epoch-ms of the last request sent (see {@link MIN_REQUEST_GAP_MS}). */
  private lastSentAt = 0;
  /** Requests waiting for their place; a user's write stands before every waiting read. */
  private readonly slotQueue: Array<{ write: boolean; resolve: (go: boolean) => void }> = [];
  /** Whether {@link pumpSlots} is handing out places right now. */
  private pumping = false;
  /** Whether this run already said that the request budget spreads the reads out. */
  private budgetNoted = false;
  /** Successive requests that ended in an error (see {@link ERROR_STREAK_LIMIT}). */
  private errorStreak = 0;
  /**
   * Set the moment onUnload runs. The sign-in/sync chain is fire-and-forget; on
   * a stop right after start it would otherwise keep syncing past the teardown
   * and even re-open the event stream — whose timer the host then refuses with
   * "setTimeout called, but adapter is shutting down".
   */
  private terminating = false;
  /** warn-once-per-category dedup for REST failures (keyed on the endpoint kind of the call, category from the status band). */
  private readonly restLog = new LogDedup();
  /**
   * The two halves of `info.connection`, owned here so the flag has ONE writer:
   * the sign-in (a usable token) and the live event stream. Either half alone
   * used to write the flag — a routine token refresh flipped it green while the
   * stream was down, and the next reconnect attempt flipped it back.
   */
  private signedIn = false;
  private streamUp = false;
  /** Epoch-ms the event stream went down, while it is down (undefined = up / never dropped). */
  private streamDownSince: number | undefined;
  /** Whether the stream was up at least once this run — the first connect needs no re-read. */
  private streamEverUp = false;
  /** Epoch-ms of the last outage re-read, for the cooldown. */
  private lastReconnectSync = 0;
  /** The deferred outage re-read, while one is waiting out the cooldown. */
  private resyncTimer: ioBroker.Timeout | undefined;

  /**
   * @param options adapter options passed through by js-controller
   */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "homeconnect",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /** Adapter start. Async body with a top-level try/catch (never a call-site .catch). */
  private async onReady(): Promise<void> {
    try {
      // Obsolete instance keys are nulled once; that write restarts the instance, so this
      // run stops here and the next one starts with the cleaned settings.
      if (await migrateNativeKeys(this, SETTINGS_MIGRATIONS, errMessage)) {
        return;
      }
      // The own objects and states, read once before anything is written: every later
      // write is compared against them.
      await this.readOwnObjects();
      await this.readOwnStates();
      // Whatever goes offline at a stop goes offline at the start too: after a
      // crash, a kill or a power cut the teardown never ran, and nothing else
      // would correct a green marker until a sign-in succeeds — which can take
      // days while a device flow waits for the user, and never happens without
      // credentials.
      await this.setStateIfChanged("info.connection", { val: false, ack: true });
      await this.setStateIfChanged("auth.signedIn", { val: false, ack: true });
      // Nothing asked Home Connect yet this run — the fleet's word for "nothing to report".
      await this.setStateIfChanged("auth.lastError", { val: "Unknown", ack: true });

      // Translated object names (channels, markers, buttons) come from admin/i18n.
      // Initialised before the credential check, so an instance that is not
      // configured yet still gets its manifest objects named.
      await I18n.init(join(this.adapterDir, "admin"), this);
      await this.refreshManifestObjects();

      // The local start-up steps run ONCE per run, here — none of them talks to
      // the cloud. In the sign-in callback they ran again on every runtime
      // re-sign-in: priming added every writable option back into the armed
      // option gate (writes to other programs' options went out), and the
      // reachable stamp flipped every online appliance to offline. The previous
      // adapter generation's trees are sorted out first (removed, or held for
      // their appliance when something is attached to them), then device trees
      // move to the current id rule, then renamed datapoints WITHIN a device,
      // then the history runs and the untyped leftovers (decision 48) —
      // all BEFORE priming, so the in-memory maps only ever see current ids; the
      // unreachable stamp comes last: the previous run's values survive in the
      // database, and nothing else corrects a stale "reachable".
      this.systemLanguage = await this.readSystemLanguage();
      const sync = this.makeSync(this.makePort());
      this.sync = sync;
      const steps: Array<[string, () => Promise<unknown>]> = [
        ["legacy cleanup", () => sync.sortOutLegacyTrees()],
        ["device id migration", () => sync.migrateDeviceIds()],
        ["datapoint migration", () => sync.migrateRenamedStates()],
        ["history migration", () => sync.migrateHistoryRuns()],
        ["leftover cleanup", () => this.dropUntypedObjects()],
        ["priming", () => sync.primeFromObjects()],
        ["reachable stamp", () => sync.markAllUnreachable()],
      ];
      for (const [name, step] of steps) {
        if (this.terminating) {
          this.log.debug(`start-up stopped before the ${name} — the adapter is shutting down.`);
          return;
        }
        try {
          await step();
        } catch (e) {
          if (this.terminating) {
            this.log.debug(`start-up chain stopped at the ${name}: ${errMessage(e)}`);
          } else {
            this.log.error(`Start-up failed at the ${name}: ${errMessage(e)}`);
          }
          return;
        }
      }

      // Pasted from the portal, a Client ID often carries a space or a line break at an end.
      const clientId = typeof this.config.clientID === "string" ? this.config.clientID.trim() : "";
      const clientSecret = typeof this.config.clientSecret === "string" ? this.config.clientSecret.trim() : "";
      if (!clientId) {
        this.log.warn(
          "No Home Connect Client ID configured — open the adapter settings and enter the Client ID of your developer application.",
        );
        return;
      }
      if (!looksLikeClientId(clientId)) {
        // Only a warning: Home Connect decides, and says so if it does not know the id.
        this.log.warn(
          `The Client ID does not look like one of Home Connect (64 hexadecimal characters, this one has ${clientId.length} characters) — copy it again from the developer portal.`,
        );
      }

      const auth = new HomeConnectAuth({ clientId, clientSecret, baseUrl: DEFAULT_BASE_URL }, (path, form) =>
        postForm(DEFAULT_BASE_URL, path, form),
      );
      this.authCtl = this.makeAuthController(auth, this.makeAuthPort());
      await this.authCtl.start();
    } catch (e) {
      this.log.error(`onReady failed: ${errMessage(e)}`);
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
  private async refreshManifestObjects(): Promise<void> {
    const t = (key: I18nKey): ioBroker.StringOrTranslated => I18n.getTranslatedObject(key);
    const text = (name: I18nKey, desc?: I18nKey): ioBroker.PartialObject => ({
      common: desc === undefined ? { name: t(name) } : { name: t(name), desc: t(desc) },
    });
    // js-controller extends every manifest object itself before onReady; a refresh
    // that matches what it left is not written again.
    const own = this.objectMirror;
    try {
      let patch = text("authChannel");
      if (!own.covers("auth", patch)) {
        await this.extendObject("auth", patch);
        own.wrote("auth", patch);
      }
      patch = text("session", "sessionDesc");
      if (!own.covers("auth.session", patch)) {
        await this.extendObject("auth.session", patch);
        own.wrote("auth.session", patch);
      }
      patch = text("verificationUrl", "verificationUrlDesc");
      if (!own.covers("auth.verificationUrl", patch)) {
        await this.extendObject("auth.verificationUrl", patch);
        own.wrote("auth.verificationUrl", patch);
      }
      patch = text("signedIn", "signedInDesc");
      if (!own.covers("auth.signedIn", patch)) {
        await this.extendObject("auth.signedIn", patch);
        own.wrote("auth.signedIn", patch);
      }
      patch = text("lastError", "lastErrorDesc");
      if (!own.covers("auth.lastError", patch)) {
        await this.extendObject("auth.lastError", patch);
        own.wrote("auth.lastError", patch);
      }
      patch = text("channelInfo");
      if (!own.covers("info", patch)) {
        await this.extendObject("info", patch);
        own.wrote("info", patch);
      }
      patch = text("connection", "connectionDesc");
      if (!own.covers("info.connection", patch)) {
        await this.extendObject("info.connection", patch);
        own.wrote("info.connection", patch);
      }
      patch = text("devicesTotal", "devicesTotalDesc");
      if (!own.covers("info.devicesTotal", patch)) {
        await this.extendObject("info.devicesTotal", patch);
        own.wrote("info.devicesTotal", patch);
      }
      patch = text("devicesOnline", "devicesOnlineDesc");
      if (!own.covers("info.devicesOnline", patch)) {
        await this.extendObject("info.devicesOnline", patch);
        own.wrote("info.devicesOnline", patch);
      }
      patch = text("devicesAllOnline", "devicesAllOnlineDesc");
      if (!own.covers("info.devicesAllOnline", patch)) {
        await this.extendObject("info.devicesAllOnline", patch);
        own.wrote("info.devicesAllOnline", patch);
      }
    } catch (e) {
      // Naming is not worth failing a start over — the adapter works either way.
      this.log.debug(`Could not refresh the manifest object names: ${errMessage(e)}`);
    }
  }

  /**
   * Read the own tree once — one list call, not a read per object — so every later
   * write can be compared first. Unread (an error), every write goes out as before.
   */
  private async readOwnObjects(): Promise<void> {
    this.objectMirror = new ObjectMirror(this.namespace);
    try {
      const list = await this.getObjectListAsync({
        startkey: `${this.namespace}.`,
        endkey: `${this.namespace}.\u9999`,
      });
      this.objectMirror.load(list.rows);
      this.untypedAtStart = this.objectMirror.untyped();
    } catch (e) {
      this.log.debug(`Could not read the own objects — every object write goes out: ${errMessage(e)}`);
    }
  }

  /**
   * Delete the objects without an object type in the own namespace (decision 48). The adapter never writes
   * one; they are leftovers another writer created by extending an id that did not exist — e.g. under the
   * device id an appliance had before 1.24.0. The object is only deleted, nothing on it is read.
   */
  private async dropUntypedObjects(): Promise<void> {
    let dropped = 0;
    for (const id of this.untypedAtStart) {
      await this.delObjectAsync(id);
      this.objectMirror.forget(id);
      dropped++;
    }
    if (dropped > 0) {
      this.log.info(`Removed ${dropped} leftover object(s) without an object type.`);
    }
  }

  /** Read the own states once — one bulk call — so a read-only state is never read back to compare it. */
  private async readOwnStates(): Promise<void> {
    try {
      this.stateMirror.load((await this.getStatesAsync("*")) ?? {});
    } catch (e) {
      this.log.debug(`Could not read the own states — every read-only state write goes out: ${errMessage(e)}`);
    }
  }

  /**
   * Write a state only when its value changes. A read-only state is written by the
   * adapter alone and compared in memory; a writable one goes through
   * `setStateChangedAsync`, whose database compare also sees a user's write.
   *
   * @param id the namespace-relative or full own id
   * @param state the state to write
   * @returns what the write returned, or undefined when nothing was written
   */
  private async setStateIfChanged(id: string, state: ioBroker.SettableState): Promise<unknown> {
    const full = this.objectMirror.fullId(id);
    if (!this.objectMirror.readOnly(id)) {
      const result = await this.setStateChangedAsync(id, state);
      this.stateMirror.remember(full, state);
      return result;
    }
    if (!this.stateMirror.differs(full, state)) {
      return undefined;
    }
    const result = await this.setState(id, state);
    this.stateMirror.remember(full, state);
    return result;
  }

  /**
   * Write a state every time (a token, a link, a measured value) and hold what was written.
   *
   * @param id the namespace-relative or full own id
   * @param state the state to write
   * @returns what the write returned
   */
  private async setStateRemembered(id: string, state: ioBroker.SettableState): Promise<unknown> {
    const result = await this.setState(id, state);
    this.stateMirror.remember(this.objectMirror.fullId(id), state);
    return result;
  }

  /**
   * `extendObject` for ApplianceSync: left out when it would change nothing.
   *
   * @param id the namespace-relative id
   * @param patch what to merge into the object
   * @returns what extendObject returned, or undefined when nothing was written
   */
  private async extendChangedObject(id: string, patch: ioBroker.PartialObject): Promise<unknown> {
    if (this.objectMirror.covers(id, patch)) {
      return undefined;
    }
    const result = await this.extendObject(id, patch);
    this.objectMirror.wrote(id, patch);
    return result;
  }

  /** Build the port ApplianceSync talks to the adapter through. */
  private makePort(): AdapterPort {
    return {
      namespace: this.namespace,
      log: this.log,
      language: this.systemLanguage,
      extendObject: (id, obj) => this.extendChangedObject(id, obj),
      setState: (id, state) => this.setStateRemembered(id, state),
      setStateChanged: (id, state) => this.setStateIfChanged(id, state),
      getState: id => this.getStateAsync(id),
      getObject: id => this.getObjectAsync(id),
      delObject: async id => {
        await this.delObjectAsync(id);
        this.objectMirror.forget(id);
        this.stateMirror.forget(this.objectMirror.fullId(id), false);
      },
      delObjectRecursive: async id => {
        await this.delObjectAsync(id, { recursive: true });
        this.objectMirror.forgetTree(id);
        this.stateMirror.forget(this.objectMirror.fullId(id), true);
      },
      getForeignObjects: (pattern, type) => this.getForeignObjectsAsync(pattern, type),
      getAdapterObjects: () => this.getAdapterObjectsAsync(),
      getForeignStates: pattern => this.getForeignStatesAsync(pattern),
      setForeignObject: async (id, obj) => {
        const result = await this.setForeignObject(id, obj);
        // Moved device trees are the adapter's own; retargeted aliases are not held.
        if (id.startsWith(`${this.namespace}.`)) {
          this.objectMirror.replaced(id, obj);
        }
        return result;
      },
      extendForeignObject: async (id, patch) => {
        // Rooms, functions and aliases are not the adapter's objects — only its own are held.
        const own = id.startsWith(`${this.namespace}.`);
        if (own && this.objectMirror.covers(id, patch)) {
          return undefined;
        }
        const result = await this.extendForeignObjectAsync(id, patch);
        if (own) {
          this.objectMirror.wrote(id, patch);
        }
        return result;
      },
      setForeignState: async (id, state) => {
        const result = await this.setForeignStateAsync(id, state);
        this.stateMirror.remember(id, state);
        return result;
      },
      getAliases: () => this.getForeignObjectsAsync("alias.*", "state"),
      getEnums: async () => (await this.getForeignObjectsAsync("enum.*", "enum")) ?? {},
      deleteTreeCarryingEnums: (root, carry) => this.deleteTreeCarryingEnums(root, carry),
      apiGet: path => this.apiGet(path),
      errorBudgetLeft: () => this.errorStreak < ERROR_STREAK_LIMIT,
      apiWrite: req => this.apiWrite(req),
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: handle => this.clearTimeout(handle as ioBroker.Timeout),
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
  private async deleteTreeCarryingEnums(root: string, carry: ReadonlyMap<string, readonly string[]>): Promise<number> {
    // Reads the enums once, deletes the tree once, writes every affected enum once with all its new ids.
    const carried = await moveAllWithEnums(
      this,
      oldId => carry.get(oldId) ?? [],
      () => this.delObjectAsync(root, { recursive: true }),
      errMessage,
    );
    this.objectMirror.forgetTree(root);
    this.stateMirror.forget(this.objectMirror.fullId(root), true);
    return carried.reduce((n, c) => n + c.newIds.length, 0);
  }

  /** Build the port the AuthController drives the sign-in lifecycle through. */
  private makeAuthPort(): AuthPort {
    return {
      log: this.log,
      loadRefreshToken: () => this.loadRefreshToken(),
      saveToken: token => this.saveToken(token),
      setVerificationUrl: async url => {
        await this.setStateRemembered("auth.verificationUrl", { val: url, ack: true });
      },
      setConnected: async connected => {
        this.signedIn = connected;
        await this.publishConnection();
      },
      setProblem: async text => {
        await this.setStateIfChanged("auth.lastError", { val: text, ack: true });
      },
      clearStoredLogin: async () => {
        await this.setStateRemembered("auth.session", { val: "", ack: true });
      },
      notify: message => this.notifyUser(message),
      onSignedIn: () => this.onAuthenticated(),
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: handle => this.clearTimeout(handle as ioBroker.Timeout),
      setIntervalTimer: (cb, ms) => this.setInterval(cb, ms),
      clearIntervalTimer: handle => this.clearInterval(handle as ioBroker.Interval),
    };
  }

  /**
   * Read the refresh token out of `auth.session`, handling both our own encrypted
   * format and the previous adapter's cleartext JSON (so a version update keeps the login).
   *
   * @returns the refresh token, or undefined if none is stored
   */
  private async loadRefreshToken(): Promise<string | undefined> {
    const state = await this.getStateAsync("auth.session");
    const raw = typeof state?.val === "string" ? state.val : "";
    // Fast exit for the common "never signed in" case. (Both readers below would
    // also return undefined for "", so this is clarity, not a guard.)
    if (raw.length === 0) {
      return undefined;
    }
    // Previous adapter: cleartext JSON — extractRefreshToken reads it directly.
    const direct = extractRefreshToken(raw);
    if (direct) {
      return direct;
    }
    // Our format: encrypted JSON.
    try {
      return extractRefreshToken(this.decrypt(raw));
    } catch {
      // Encrypted with another installation's secret — the ioBroker data was moved to a new
      // system, or restored from a backup of another one. Unreadable is not the same as absent:
      // the user is told why a sign-in is asked for again.
      this.log.warn(
        "The stored Home Connect login cannot be read on this system (it was saved by another ioBroker installation) — a new sign-in is required.",
      );
      return undefined;
    }
  }

  /**
   * Persist a freshly obtained token, encrypted.
   *
   * @param token the token to store
   */
  private async saveToken(token: StoredToken): Promise<void> {
    await this.setStateRemembered("auth.session", { val: this.encrypt(JSON.stringify(token)), ack: true });
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
  private async onAuthenticated(): Promise<void> {
    const sync = this.sync;
    // This is the auth controller's sign-in callback. An error thrown out of it
    // lands in the controller's catch, which can only read it as a failed
    // sign-in: at start-up "Stored login could not be refreshed … retrying"
    // (with a token request every retry). The chain reports its own failures.
    let current = "appliance sync";
    try {
      if (this.terminating) {
        return;
      }
      // The appliance read gets its own catch: a failure there must not cost the
      // write path and the live updates. Before, a single broken response ended
      // the chain right here — the instance stayed signed in, with no event
      // stream and no state subscription, until the next restart.
      if (sync) {
        try {
          await sync.syncAppliances();
        } catch (e) {
          if (this.terminating) {
            this.log.debug(`start-up chain stopped at the ${current}: ${errMessage(e)}`);
            return;
          }
          this.log.error(`Setting up the appliances failed: ${errMessage(e)} — live updates start anyway.`);
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
        this.log.debug(`start-up chain stopped at the ${current}: ${errMessage(e)}`);
        return;
      }
      this.log.error(`Start-up failed at the ${current}: ${errMessage(e)}`);
    }
  }

  /**
   * Open the single persistent event stream (live updates). If it already runs
   * — a re-sign-in at runtime comes through here again — a pending reconnect
   * backoff is cut short instead: the fresh token is what it was waiting for.
   */
  private startEventStream(): void {
    if (this.terminating) {
      return;
    }
    if (this.eventStream) {
      this.eventStream.reconnectNow();
      return;
    }
    this.eventStream = this.makeEventStream({
      baseUrl: DEFAULT_BASE_URL,
      getAccessToken: () => this.authCtl?.accessToken,
      onEvent: ev => this.sync?.handleStreamEvent(ev),
      onConnected: (connected, quietSince) => {
        this.streamUp = connected;
        void this.publishConnection();
        this.noteStreamState(connected, quietSince);
      },
      onUnauthorized: () => this.authCtl?.refreshNow() ?? Promise.resolve(false),
      // One daily quota for the stream and REST: a 429 on the stream pauses REST too.
      onRateLimited: ms => this.armRatePause(ms),
      takeSlot: () => this.spaceRequests(),
      log: (level, msg) => this.log[level](msg),
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: handle => this.clearTimeout(handle as ioBroker.Timeout),
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
   * @param quietSince on a down-report after the keep-alive watchdog fired: when the stream went silent
   */
  private noteStreamState(connected: boolean, quietSince?: number): void {
    if (!connected) {
      // Only the first of a run of down-reports starts the clock — the stream
      // reports "down" again before every reconnect attempt. A silent connection
      // was dead from its last traffic on, not only from the watchdog's abort.
      this.streamDownSince ??= quietSince ?? Date.now();
      return;
    }
    const downSince = this.streamDownSince;
    this.streamDownSince = undefined;
    if (!this.streamEverUp) {
      // The first connect of this run: the start-up chain already read everything.
      this.streamEverUp = true;
      return;
    }
    if (downSince === undefined) {
      return;
    }
    const outageMs = Date.now() - downSince;
    if (outageMs < STREAM_OUTAGE_RESYNC_MS) {
      this.log.debug(`event stream was down for ${Math.round(outageMs / 1000)} s — too short to re-read.`);
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
  private scheduleReconnectSync(outageMs: number): void {
    if (this.terminating || this.resyncTimer) {
      return;
    }
    const sinceLast = Date.now() - this.lastReconnectSync;
    if (sinceLast >= RECONNECT_SYNC_COOLDOWN_MS) {
      void this.runReconnectSync(outageMs);
      return;
    }
    const deferBy = RECONNECT_SYNC_COOLDOWN_MS - sinceLast;
    this.log.debug(`re-read after the stream outage deferred by ${Math.round(deferBy / 1000)} s (request quota).`);
    this.resyncTimer = this.setTimeout(() => {
      this.resyncTimer = undefined;
      void this.runReconnectSync(outageMs, deferBy);
    }, deferBy);
  }

  /**
   * Re-read every appliance after a stream outage (own try/catch — fire-and-forget).
   *
   * @param outageMs how long the stream was down (for the log line)
   * @param heldBackMs how long the cooldown deferred the re-read (0 = ran at once)
   */
  private async runReconnectSync(outageMs: number, heldBackMs = 0): Promise<void> {
    if (this.terminating || !this.sync) {
      return;
    }
    try {
      // Stamp and announce only a catch-up that actually reached the cloud. Doing
      // it upfront logged "re-reading the appliances" for a sync that returned on
      // an unreachable appliance list — and started the one-hour cooldown on it,
      // so the tree stayed on its pre-outage state for another 57 minutes.
      if (await this.sync.syncAppliances()) {
        this.lastReconnectSync = Date.now();
        // Worth an info line: the values in the tree jump, and without this the
        // user has no way to tell a live update from a catch-up. A deferred one
        // says so — it came minutes after the stream was back (measured live
        // 2026-09-23: 21 minutes), which the line alone did not tell.
        // The hold-back is the adapter's own one-hour cooldown that PROTECTS the
        // daily quota — not an exhausted quota; below a minute it says seconds.
        const heldBack =
          heldBackMs <= 0
            ? ""
            : heldBackMs < 60_000
              ? ` (held back ${Math.max(1, Math.round(heldBackMs / 1000))} s to protect the daily request quota)`
              : ` (held back ${Math.round(heldBackMs / 60_000)} min to protect the daily request quota)`;
        this.log.info(
          `Live updates were interrupted for ${Math.round(outageMs / 1000)} s — re-read the appliances${heldBack}.`,
        );
      }
    } catch (e) {
      this.log.warn(`re-reading the appliances after the stream outage failed: ${errMessage(e)}`);
    }
  }

  /**
   * Write `info.connection` from its two halves: signed in AND the live stream
   * up. Only then do values actually flow; a valid token with a dead stream is
   * an instance that shows stale data.
   */
  private async publishConnection(): Promise<void> {
    try {
      // The sign-in half on its own, so the settings panel can tell "signed in,
      // live updates down" from "not signed in" — info.connection alone cannot.
      await this.setStateIfChanged("auth.signedIn", { val: this.signedIn, ack: true });
      await this.setStateIfChanged("info.connection", { val: this.signedIn && this.streamUp, ack: true });
    } catch (e) {
      this.log.debug(`Could not write info.connection: ${errMessage(e)}`);
    }
  }

  /**
   * Messages from the settings panel: "Test connection" (`checkConnection`),
   * "Request a new sign-in link" (`requestSignIn`) and "Reset sign-in" (`resetLogin`).
   * Async body with a top-level try/catch; every command answers, so the panel
   * never waits on a message that fell through.
   *
   * @param obj the incoming message
   */
  private async onMessage(obj: ioBroker.Message): Promise<void> {
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
        const answer = authCtl
          ? { result: obj.command === "resetLogin" ? await authCtl.resetLogin() : await authCtl.requestSignIn() }
          : { error: "No Client ID configured — enter it above and save first." };
        if (obj.callback) {
          this.sendTo(obj.from, obj.command, answer, obj.callback);
        }
        return;
      }
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { error: `Unknown command: ${String(obj.command)}` }, obj.callback);
      }
    } catch (e) {
      this.log.error(`onMessage failed: ${errMessage(e)}`);
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { error: errMessage(e) }, obj.callback);
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
  private async checkConnection(): Promise<{ result: string } | { error: string }> {
    if (typeof this.config.clientID !== "string" || this.config.clientID.trim().length === 0) {
      return { error: "No Client ID configured — enter it above and save first." };
    }
    if (!this.authCtl?.accessToken) {
      const url = (await this.getStateAsync("auth.verificationUrl"))?.val;
      return {
        error:
          typeof url === "string" && url.length > 0
            ? "Not signed in yet — open the sign-in link and confirm the code, then test again."
            : "Not signed in — no Home Connect login is stored; the adapter requests a sign-in link at start.",
      };
    }
    if (Date.now() < this.restBlockedUntil) {
      const seconds = Math.ceil((this.restBlockedUntil - Date.now()) / 1000);
      return { error: `Home Connect REST is paused after a rate limit for another ${seconds} s — try again later.` };
    }
    const sent = this.authCtl.accessToken;
    // The test request takes a slot like every other request and a 429 pauses REST like on every other path.
    if (!(await this.spaceRequests(true))) {
      return { error: "The adapter is shutting down." };
    }
    let res = await getJson(DEFAULT_BASE_URL, "/api/homeappliances", sent, this.acceptLanguage());
    if (res.status === 401) {
      const fresh = await this.tokenAfter401(sent);
      if (fresh && (await this.spaceRequests(true))) {
        res = await getJson(DEFAULT_BASE_URL, "/api/homeappliances", fresh, this.acceptLanguage());
      }
    }
    this.countAnswer(res);
    if (res.status === 429) {
      this.armRatePause(res.retryAfterMs ?? RATE_PAUSE_FALLBACK_MS);
      return { error: `${rateLimitText(res.description, res.retryAfterMs)} — try again later.` };
    }
    if (res.status === 401 || res.status === 403) {
      return { error: `Home Connect rejected the login (HTTP ${res.status}) — a new sign-in is required.` };
    }
    if (res.status === 0) {
      return { error: `Home Connect is not reachable: ${res.error ?? "network error"}` };
    }
    if (!res.ok) {
      return {
        error: `Home Connect answered HTTP ${res.status}: ${res.error ?? "unknown error"}${res.description ? ` (${res.description})` : ""}`,
      };
    }
    const list = isRecord(res.data) && Array.isArray(res.data.homeappliances) ? res.data.homeappliances : undefined;
    if (!list) {
      return {
        error: "Home Connect answered, but not with an appliance list — the API shape is not what the adapter expects.",
      };
    }
    const online = list.filter(a => isRecord(a) && a.connected === true).length;
    const stream = this.streamUp
      ? "Live updates: connected."
      : `Live updates: NOT connected${this.eventStream?.lastError ? ` (${this.eventStream.lastError})` : ""} — the adapter keeps retrying.`;
    return {
      result: `Signed in — Home Connect listed ${list.length} appliance(s), ${online} of them connected right now. ${stream}`,
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
  private async apiGet(path: string): Promise<unknown> {
    const token = this.authCtl?.accessToken;
    if (this.terminating || !token || this.restPaused(path)) {
      return undefined;
    }
    const source = `GET ${path}`;
    // Re-checked after the wait: a 429 that arrived while this request queued
    // for its slot pauses it too.
    if (!(await this.spaceRequests()) || this.restPaused(path)) {
      return undefined;
    }
    let res = await getJson(DEFAULT_BASE_URL, path, token, this.acceptLanguage());
    if (res.status === 401) {
      const fresh = await this.tokenAfter401(token);
      if (fresh) {
        res = await getJson(DEFAULT_BASE_URL, path, fresh, this.acceptLanguage());
      }
    }
    this.countAnswer(res);
    if (!res.ok) {
      // An expected answer ("no program active", "busy") is appliance state, not
      // a failure — it never warns. It IS proof that the endpoint answers, so it
      // clears a failing endpoint kind: an idle appliance only ever answers "no
      // program" on the two program paths, and a failure there used to stay armed
      // for days (measured live 2026-09-20 → 2026-09-23) — the recovery line came
      // for another appliance, and every failure of the kind in between was
      // debug-only. The price of the appliance-free key stays: an idle appliance
      // clears the kind while another one keeps failing on it (one warn plus one
      // recovery line per pass).
      // "There is none" is knowledge and comes back as `null`; a failure and a
      // busy appliance are not, and both stay `undefined`: a caller that took
      // `undefined` for "none" wrote an idle program over a running one after a
      // single timeout and disarmed the option gate with it.
      const answer = res.error;
      if (answer !== undefined && NOT_READY_ANSWERS.has(answer)) {
        this.log.debug(`${source}: ${answer} (the appliance is still initializing)`);
        this.sync?.noteNotReady(path);
        return undefined;
      }
      if (
        answer !== undefined &&
        (NO_PROGRAM_ANSWERS.has(answer) || BUSY_ANSWERS.has(answer) || UNSUPPORTED_ANSWERS.has(answer))
      ) {
        this.log.debug(`${source}: ${answer} (a normal appliance answer, not an error)`);
        if (this.restLog.recovered(source)) {
          this.log.info(`${source} succeeded again.`);
        }
        if (UNSUPPORTED_ANSWERS.has(answer)) {
          this.sync?.noteUnsupportedProgram(path);
        }
        return NO_PROGRAM_ANSWERS.has(answer) ? null : undefined;
      }
      this.handleRestFailure(source, res);
      if (res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 429) {
        // Refused for good — the sync books it (a definition that keeps failing
        // otherwise cost one request on every reconnect).
        this.sync?.noteRefused(path);
      }
      return undefined;
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
  private async apiWrite(req: WriteRequest): Promise<JsonResult | undefined> {
    if (this.terminating) {
      return undefined;
    }
    const source = `${req.method} ${req.path}`;
    const token = this.authCtl?.accessToken;
    if (!token) {
      // A user action that cannot go out says so — during a sign-in that waits for
      // the user (possibly days) every write was dropped without a word.
      const level = this.restLog.note(source, "auth");
      this.log[level](`${source} dropped — not signed in to Home Connect (a new sign-in is pending).`);
      return undefined;
    }
    if (this.dropWhilePaused(source)) {
      return undefined;
    }
    // Re-checked after the wait: a 429 that arrived while this write queued for
    // its slot pauses it too.
    if (!(await this.spaceRequests(true)) || this.dropWhilePaused(source)) {
      return undefined;
    }
    let res = await this.sendWrite(req, token);
    if (res.status === 401) {
      const fresh = await this.tokenAfter401(token);
      if (fresh) {
        res = await this.sendWrite(req, fresh);
      }
    }
    this.countAnswer(res);
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
  private dropWhilePaused(source: string): boolean {
    if (Date.now() >= this.restBlockedUntil) {
      return false;
    }
    const seconds = Math.ceil((this.restBlockedUntil - Date.now()) / 1000);
    const level = this.restLog.note(source, "rate");
    this.log[level](`${source} dropped — Home Connect REST is paused (rate limit) for another ${seconds} s.`);
    return true;
  }

  /**
   * Pause REST for at least `ms` from now. Never shortens a pause already
   * running: a later 429 without Retry-After (60 s) used to cut a long
   * daily-quota pause down to a minute.
   *
   * @param ms the pause in ms
   */
  private armRatePause(ms: number): void {
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
  private async tokenAfter401(sent: string): Promise<string | undefined> {
    const current = this.authCtl?.accessToken;
    if (current && current !== sent) {
      return current;
    }
    return (await this.authCtl?.refreshNow()) ? this.authCtl?.accessToken : undefined;
  }

  /**
   * Perform the actual PUT/DELETE for a resolved request.
   *
   * @param req the resolved request
   * @param token the access token to send with
   * @returns the JSON result
   */
  private sendWrite(req: WriteRequest, token: string): Promise<JsonResult> {
    return req.method === "DELETE"
      ? deleteJson(DEFAULT_BASE_URL, req.path, token)
      : putJson(DEFAULT_BASE_URL, req.path, token, req.body);
  }

  /**
   * Take a place for one request: at least {@link MIN_REQUEST_GAP_MS} after the previous one and at most
   * {@link REQUESTS_PER_MINUTE} in any minute. Callers queue up; a user's write goes before every waiting read, so a
   * button does not wait behind the first read of all appliances.
   *
   * @param write whether the request carries a user action (a write or the connection test)
   * @returns false when the adapter started shutting down during the wait — the request must not go out then
   */
  private spaceRequests(write = false): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const firstRead = write ? this.slotQueue.findIndex(entry => !entry.write) : -1;
      this.slotQueue.splice(firstRead === -1 ? this.slotQueue.length : firstRead, 0, { write, resolve });
      void this.pumpSlots();
    });
  }

  /** Hand out the places in queue order, waiting out the gap and the minute budget between them. */
  private async pumpSlots(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.slotQueue.length > 0) {
        const now = Date.now();
        this.sentAt = this.sentAt.filter(at => now - at < 60_000);
        const budgetWait = this.sentAt.length >= requestsPerMinute() ? this.sentAt[0] + 60_000 - now : 0;
        const wait = Math.max(this.lastSentAt + MIN_REQUEST_GAP_MS - now, budgetWait);
        if (budgetWait > 0 && !this.budgetNoted) {
          this.budgetNoted = true;
          this.log.info(
            `Home Connect allows ${REQUESTS_PER_MINUTE} requests per minute — reading the appliances is spread over the next minutes; the datapoints fill in as they arrive.`,
          );
        }
        if (wait > 0 && !this.terminating) {
          await this.delay(wait);
          continue;
        }
        const next = this.slotQueue.shift();
        if (this.terminating) {
          next?.resolve(false);
          continue;
        }
        this.lastSentAt = Date.now();
        this.sentAt.push(this.lastSentAt);
        next?.resolve(true);
      }
    } catch (e) {
      // The wait itself failed (the adapter's timer refused during shutdown): nothing that waits may go out.
      this.log.debug(`request queue stopped: ${errMessage(e)}`);
      for (const entry of this.slotQueue.splice(0)) {
        entry.resolve(false);
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Keep count of successive requests that ended in an error — Home Connect blocks after ten.
   *
   * @param res the answer of a request that went out
   */
  private countAnswer(res: JsonResult): void {
    if (res.status >= 400) {
      this.errorStreak++;
    } else if (res.ok) {
      this.errorStreak = 0;
    }
  }

  /**
   * Whether REST is currently paused after a 429 (with a one-line debug note).
   *
   * @param path the path being attempted (for the log)
   * @returns whether the call should be skipped right now
   */
  private restPaused(path: string): boolean {
    if (Date.now() < this.restBlockedUntil) {
      this.log.debug(`REST paused (rate-limited) — skipping ${path}`);
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
  private handleRestFailure(source: string, res: JsonResult): void {
    if (res.status === 429) {
      this.armRatePause(res.retryAfterMs ?? RATE_PAUSE_FALLBACK_MS);
    }
    const level = this.restLog.note(source, categorize(res.status));
    const why =
      res.status === 429
        ? `${rateLimitText(res.description, res.retryAfterMs)} — the adapter waits and continues by itself`
        : `${res.error ?? "unknown"}${res.description ? ` (${res.description})` : ""}`;
    this.log[level](`${source} failed: ${why}`);
  }

  /**
   * Handle a state change: ignore our own confirmed (ack) updates, else route the
   * user's write to the Home Connect API (ApplianceSync owns the try/catch).
   *
   * @param id the full state id
   * @param state the new state (null on deletion)
   */
  private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
    if (!state || state.ack) {
      return;
    }
    void this.sync?.handleWrite(id, state.val);
  }

  /**
   * The Accept-Language to request localized names with — the ioBroker system
   * language mapped to a Home Connect locale.
   *
   * @returns a BSH locale like "de-DE", or undefined to let the API default
   */
  private acceptLanguage(): string | undefined {
    return this.systemLanguage ? SYSTEM_TO_BSH_LOCALE[this.systemLanguage] : undefined;
  }

  /**
   * The system language from `system.config` — the fleet pattern (CLAUDE_PATTERNS.md,
   * "User-Texte lokalisieren"). Unreadable: none — the labels fall back to English
   * and the cloud picks its language itself.
   *
   * @returns an ioBroker language code, or undefined
   */
  private async readSystemLanguage(): Promise<string | undefined> {
    try {
      const config = await this.getForeignObjectAsync("system.config");
      const language = (config?.common as { language?: unknown } | undefined)?.language;
      return typeof language === "string" && language.length > 0 ? language : undefined;
    } catch (e) {
      this.log.debug(`reading the system language failed: ${errMessage(e)} — labels in English`);
      return undefined;
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
  private notifyUser(message: string): void {
    this.registerNotification(NOTIFY_SCOPE, NOTIFY_CATEGORY, message).catch(e =>
      this.log.debug(`Could not raise notification: ${errMessage(e)}`),
    );
  }

  /**
   * Teardown: stop the collaborators synchronously, then report done only once
   * the final marker writes have landed (the host grants the full stopTimeout;
   * a callback fired before the writes would lose them).
   *
   * @param callback function to invoke once teardown is complete
   */
  private onUnload(callback: () => void): void {
    try {
      this.terminating = true;
      this.signedIn = false;
      this.streamUp = false;
      const authCtl = this.authCtl;
      authCtl?.stop();
      this.authCtl = undefined;
      this.eventStream?.stop();
      this.eventStream = undefined;
      // Before the markers go offline: a sync pass still in flight must not mark
      // an appliance online or create objects after the stamp below has run.
      this.sync?.stop();
      if (this.resyncTimer) {
        this.clearTimeout(this.resyncTimer);
        this.resyncTimer = undefined;
      }
      // Report done only once the last writes have landed. Every appliance carries
      // an online marker behind `statusStates`, and nothing else resets it — the
      // host's own reset of `info.connection` even writes to the wrong id
      // (js-controller#3472). A lost write leaves the whole tree green while the
      // adapter is off. Waiting is safe: the manifest declares no
      // `supportedMessages.stopInstance`, so the host grants the full stopTimeout.
      // BOTH markers, not just the connection: at runtime `auth.signedIn` is written
      // only by `publishConnection`, which never runs during teardown — so it stayed on
      // `true` after every signed-in stop and the sign-in panel reported
      // "signed in" for an instance that was not running. Same rule as the
      // appliance markers: whatever is set at runtime is reset on the way out.
      const writes: Promise<unknown>[] = [
        this.setStateIfChanged("info.connection", { val: false, ack: true }),
        this.setStateIfChanged("auth.signedIn", { val: false, ack: true }),
        // Off: nothing to report (the fleet's reason-text rule) — the next start asks again.
        this.setStateIfChanged("auth.lastError", { val: "Unknown", ack: true }),
      ];
      // A rotated refresh token the object database refused earlier gets its last
      // chance here: Home Connect kills the previous one the moment it hands out
      // a new one, so losing it costs the user a fresh device-flow sign-in.
      // A token request still in flight gets its answer stored first — Home
      // Connect rotated the refresh token the moment it answered, so dropping the
      // answer on the floor costs the user a fresh sign-in at the next start.
      if (authCtl) {
        writes.push(authCtl.settle().then(() => authCtl.persistPendingToken()));
      }
      if (this.sync) {
        writes.push(this.sync.markAllUnreachable());
      }
      // allSettled, not all: `all` gave up at the first rejected write and let the
      // callback fire while the other writes were still on their way.
      void Promise.allSettled(writes)
        .then(results => {
          for (const r of results) {
            if (r.status === "rejected") {
              // The trace explains a stale green tree.
              this.log.debug(`Final shutdown write failed: ${errMessage(r.reason)}`);
            }
          }
        })
        .finally(() => callback());
      return;
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new Homeconnect(options);
} else {
  // Start the instance directly
  (() => new Homeconnect())();
}
