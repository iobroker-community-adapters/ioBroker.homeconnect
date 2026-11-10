import { join } from "node:path";
import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import {
  HomeConnectAuth,
  extractRefreshToken,
  storedLoginMode,
  type FormPostResult,
  type StoredToken,
  type TokenMode,
} from "./lib/oauth";
import { getJson, postForm, putJson, deleteJson, rateLimitText, spokenDuration, type JsonResult } from "./lib/http";
import { ApplianceSync, type AdapterPort } from "./lib/appliance-sync";
import { AppSignInError, AuthController, type AuthOptions, type AuthPort } from "./lib/auth-controller";
import { APP_CLIENT_ID, NOTHING_PASTED } from "./lib/app-client";
import { moveAllWithEnums } from "./lib/enum-carry";
import type { WriteRequest } from "./lib/command-dispatch";
import { EVENTS_PATH, EventStream, type StreamPlace } from "./lib/event-stream";
import { errText } from "./lib/err-text";
import { isRecord } from "./lib/pure-helpers";
import { looksLikeClientId } from "./lib/sign-in-help";
import { readDataFile, removeDataFile, setAsideDataFile, writeDataFile } from "./lib/data-file";
import { migrateNativeKeys } from "./lib/native-key-migration";
import { SETTINGS_MIGRATIONS } from "./lib/settings-migrations";
import { categorize, restLogKey } from "./lib/log-dedup";
import { LogOnce } from "./lib/log-once";
import { counterparts, countsErrors, countsSeries, fits, limitFor, type LimitedCall } from "./lib/api-limits";
import { heldPlacesOf, RequestBudget, type CountedWindow, type RequestPlace } from "./lib/request-budget";
import { ObjectMirror, StateMirror } from "./lib/object-mirror";
import { tText, type I18nKey } from "./lib/i18n";
import { LogRing } from "./lib/diagnostics/log-ring";
import { ReportJobs } from "./lib/diagnostics/report-jobs";
import { HomeConnectReportSource, type LiveAnswer, type ReportHost } from "./lib/diagnostics/report-source";
import { TrafficRecorder } from "./lib/diagnostics/traffic-recorder";

/** Production API host (global EU/US region; China would be api.home-connect.cn). */
const DEFAULT_BASE_URL = "https://api.home-connect.com";
/** Pause REST this long after a 429 that carries no Retry-After header. */
const RATE_PAUSE_FALLBACK_MS = 60_000;
/** The datapoint that held the stored login up to 2.0.0-alpha — moved into the login file at start, then deleted. */
const SESSION_STATE = "auth.session";
/** The stored login's file in the instance's data folder. */
const LOGIN_FILE = "login.json";
/** The name an unreadable login file is kept under instead of being overwritten by the next sign-in. */
const LOGIN_FILE_ASIDE = "login.unreadable.json";
/** The places of the last day in the instance's data folder (request-budget.ts). */
const REQUEST_TIMES_FILE = "request-times.json";
/** The host every request goes to — the counterparts of src/lib/api-limits.json match it. */
const API_HOST = new URL(DEFAULT_BASE_URL).host;
/**
 * A REST read as the limits see it: the kind of request most of the budget goes to, the one Home Connect's daily quota
 * counts (api-docs → Rate Limiting: "Every HTTPS request to the Home Connect REST API counts toward the daily limit").
 *
 * @param path the request path
 * @returns the call
 */
function restRead(path = "/api/homeappliances"): LimitedCall {
  return { host: API_HOST, method: "GET", path };
}
/**
 * Whether a counterpart counts the reads too — its holds say the minute's line ({@link Homeconnect.noteMinuteBudget}) and
 * the day's ({@link Homeconnect.noteLongHold}); a counterpart of its own (token refresh, program starts and stops, event
 * channels) holds only its kind.
 *
 * @param name the counterpart's name
 * @returns whether a REST read counts in it
 */
function countsReads(name: string): boolean {
  return counterparts().some(c => c.name === name && fits(restRead(), c.match));
}
/** What a held request of a kind is, in the line that names its hold (decision H-14). */
const HELD_WORDS: Readonly<Record<SlotKind, string>> = {
  token: "its sign-in requests",
  write: "commands",
  stream: "the event stream's connect",
  read: "reads",
};
/** The window of Home Connect's 50 per minute, in seconds. */
const MINUTE_SECONDS = 60;
/** The window of Home Connect's 1000 per day, in seconds. */
const DAY_SECONDS = 86_400;
/**
 * Home Connect allows 50 requests per minute per application and account and blocks further ones for a minute
 * (api-docs → Rate Limiting, declared in src/lib/api-limits.json). A first read with empty definition caches — the
 * update from 1.x — asks dozens of requests per appliance; the transport holds every request to this budget, the event
 * stream's connect included. The inventory run's pacing hook widens the declaration as the adapter loads it
 * (`test/inventory-pacing-hook.cjs`, never in the installations its limit tests judge).
 *
 * @returns requests a REST read may make in any minute
 */
function requestsPerMinute(): number {
  return limitFor(restRead(), MINUTE_SECONDS);
}
/**
 * A limit is spent when its next place frees later than this: a command that cannot go out within it is dropped — one
 * that went out minutes or hours later would act at a moment nobody chose —, a read waits for its place (nothing reads
 * again what a dropped read missed), a shorter wait is waited like any other window. Only a window longer than a
 * minute makes such a wait: the REST API's day, the token refresh's day, the ten minutes of a series of errors.
 */
const LONG_HOLD_AFTER_MS = MINUTE_SECONDS * 1000;
/**
 * At most this long after a request ends its place reaches the request file — a kill, a crash or a power cut skips
 * onUnload, and the day's places must still reach the next process (the fleet suite "writes no file for a report"
 * takes a file the process also writes outside a report for its own record, tooling round 171).
 */
const HAND_OVER_EVERY_MS = MINUTE_SECONDS * 1000;
/**
 * A limit in words, as Home Connect names its own ("50 calls in 1 minute", "1000 calls in 1 day").
 *
 * @param window the window that holds
 * @returns the words
 */
function limitWords(window: CountedWindow): string {
  const seconds = window.seconds ?? 0;
  const [count, unit] =
    seconds % DAY_SECONDS === 0
      ? [seconds / DAY_SECONDS, "day"]
      : seconds % 3600 === 0
        ? [seconds / 3600, "hour"]
        : seconds % MINUTE_SECONDS === 0
          ? [seconds / MINUTE_SECONDS, "minute"]
          : [seconds, "second"];
  const what = countsSeries(window.key)
    ? "successive calls answered with an error"
    : countsErrors(window.key)
      ? "calls answered with an error"
      : "calls";
  return `${window.max} ${what} in ${count} ${unit}${count === 1 ? "" : "s"}`;
}
/**
 * What a request waiting for its place is: a sign-in request, a user's command or the connection test (dropped while
 * a spent limit holds it), the event stream's connect and a read (both wait for their place).
 */
type SlotKind = "token" | "write" | "stream" | "read";
/**
 * The queue order: sign-in requests and commands first, then the stream's connect (one request for every live event),
 * then the reads; in arrival order within each.
 *
 * @param kind the request's kind
 * @returns its rank, lower first
 */
function slotRank(kind: SlotKind): number {
  return kind === "read" ? 2 : kind === "stream" ? 1 : 0;
}
/**
 * Home Connect blocks for ten minutes after ten successive requests that end in an error (declared in
 * src/lib/api-limits.json, held by the request budget). Definition reads are optional (a selected program fetches its
 * own later), so they stop this many short of the limit.
 */
const ERROR_RESERVE = 2;
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

/** The settings panel's sign-in commands — both accesses' steps, each answered by {@link Homeconnect.answerSignIn}. */
const SIGN_IN_COMMANDS: ReadonlySet<string> = new Set([
  "requestSignIn",
  "resetLogin",
  "appSignInLink",
  "appSignInComplete",
]);

/**
 * ioBroker.homeconnect — Home Connect / BSH home appliances (Bosch, Siemens,
 * NEFF, Gaggenau) via the Home Connect cloud API. Greenfield TypeScript rewrite:
 * OAuth device flow, a clean device tree (folders named by the model and the
 * appliance's own number, speaking state ids below), a single live event stream, and a
 * write path that turns state changes back into Home Connect commands.
 */
class Homeconnect extends utils.Adapter {
  // Construction seams for the three collaborators. Production uses the real
  // classes; the orchestration tests swap them for fakes so onReady's wiring, the
  // REST paths and the teardown are testable without a network. Behaviour is
  // unchanged — same constructors, same arguments.
  private makeSync: (port: AdapterPort) => ApplianceSync = port => new ApplianceSync(port);
  private makeAuthController: (auth: HomeConnectAuth, port: AuthPort, options: AuthOptions) => AuthController = (
    auth,
    port,
    options,
  ) => new AuthController(auth, port, options);
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
  /** The start has read its own objects and states: from here on a marker write compares in memory. */
  private ownStatesRead = false;
  /** The places of the requests that still count in a window of a counterpart of src/lib/api-limits.json. */
  private readonly budget = new RequestBudget(counterparts);
  /**
   * The instance's data folder ("" until onReady knows it): the login file and the places of the last day, which outlive
   * a restart there (request-budget.ts).
   */
  private dataDir = "";
  /** A login the move out of `auth.session` could not write into the file — this run still signs in with it. */
  private unmovedSession: string | undefined;
  /** The hand-over that follows a request's end within {@link HAND_OVER_EVERY_MS}, while one is due. */
  private handOverTimer: ioBroker.Timeout | undefined;
  /** When the next place of a command or a read frees, as the latest long hold measured it ({@link noteLongHold}). */
  private longHoldUntil = 0;
  /** Per window that held a request long ({@link noteLongHold}), when its next place frees as that hold measured it. */
  private readonly holdUntil = new Map<string, number>();
  /**
   * The spent windows — each from its first long hold until it has a minute's requests free again, a window of errors
   * until its series is over — with the kind of request it holds: a window of a day holds either sign-in requests (the
   * token refresh's) or commands and reads.
   */
  private readonly spentWindows = new Map<string, { window: CountedWindow; kind: SlotKind }>();
  /** Requests waiting for their place, in {@link slotRank} order. */
  private readonly slotQueue: Array<{
    kind: SlotKind;
    call: LimitedCall;
    resolve: (place: RequestPlace | undefined) => void;
  }> = [];
  /** Whether {@link pumpSlots} is handing out places right now. */
  private pumping = false;
  /** Ends the queue's current wait early — a request that now stands first is judged at once. */
  private wakePump: (() => void) | undefined;
  /** When the queue's current wait ends (epoch ms). */
  private pumpWakeAt = 0;
  /** Sign-in requests waiting out a pause of Home Connect; the stop ends their wait. */
  private readonly pauseWaits = new Set<() => void>();
  /** Whether this run already said that the request budget spreads the reads out. */
  private budgetNoted = false;
  /**
   * Set the moment onUnload runs. The sign-in/sync chain is fire-and-forget; on
   * a stop right after start it would otherwise keep syncing past the teardown
   * and even re-open the event stream — whose timer the host then refuses with
   * "setTimeout called, but adapter is shutting down".
   */
  private terminating = false;
  /** warn-once-per-category dedup for REST failures (keyed on the endpoint kind of the call, category from the status band). */
  /** REST failures: said once per endpoint kind and category, repeats on debug, the return once on info (fleet master). */
  private readonly restLog = new LogOnce({
    debug: message => this.log.debug(message),
    info: message => this.log.info(message),
    warn: message => this.log.warn(message),
    error: message => this.log.error(message),
  });
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
  /** When this run started — the diagnostics report says it. */
  private readonly startedAt = Date.now();
  /** The adapter's last log lines at every level — what a diagnostics report shows of the past. */
  private readonly logRing = new LogRing();
  /** Every answer Home Connect gave, per appliance and for the account, for the diagnostics report (memory only). */
  private readonly recorder = new TrafficRecorder();
  /** Answers the admin's diagnostics card (list the appliances, read one and hand back its report). */
  private readonly diagnostics = new ReportJobs(new HomeConnectReportSource(this.reportHost()));

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
    this.on("unload", this.onUnload.bind(this));
  }

  /** Adapter start. Async body with a top-level try/catch (never a call-site .catch). */
  private async onReady(): Promise<void> {
    try {
      // Translated texts (object names, connection test answers) come from admin/i18n. First, before anything can
      // translate: js-controller delivers messages before onReady has finished, so the message handler comes after.
      await I18n.init(join(this.adapterDir, "admin"), this);
      // From here on the diagnostics report's log ring hears every line, debug included.
      this.logRing.hook(this.log);
      this.on("message", this.onMessage.bind(this));
      // Obsolete instance keys are nulled once; that write restarts the instance, so this
      // run stops here and the next one starts with the cleaned settings.
      if (await migrateNativeKeys(this, SETTINGS_MIGRATIONS, errText)) {
        return;
      }
      // The own objects and states, read once before anything is written: every later
      // write is compared against them.
      await this.readOwnObjects();
      await this.readOwnStates();
      this.ownStatesRead = true;
      this.dataDir = this.findDataFolder();
      // Before the first request: the day a previous process spent still counts — Home Connect counts per account.
      this.takeOverRequestBudget();
      // Before the sign-in: a login still in the datapoint auth.session moves into its file, once.
      await this.moveSessionToFile();
      // Whatever goes offline at a stop goes offline at the start too: after a
      // crash, a kill or a power cut the teardown never ran, and nothing else
      // would correct a green marker until a sign-in succeeds — which can take
      // days while a device flow waits for the user, and never happens without
      // credentials.
      await this.setStateIfChanged("info.connection", { val: false, ack: true });
      await this.setStateIfChanged("auth.signedIn", { val: false, ack: true });
      // Nothing asked Home Connect yet this run — the fleet's word for "nothing to report".
      await this.setStateIfChanged("auth.lastError", { val: "Unknown", ack: true });

      // Before the credential check, so an instance that is not configured yet still gets its manifest objects named.
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
            this.log.debug(`start-up chain stopped at the ${name}: ${errText(e)}`);
          } else {
            this.log.error(`Start-up failed at the ${name}: ${errText(e)}`);
          }
          return;
        }
      }

      if (this.accessMode() === "app") {
        // The app access (beta): the Home Connect app's public client, no Client ID of the user (H-11).
        this.log.debug("sign-in through the Home Connect app's client (app access, beta)");
        const auth = new HomeConnectAuth(
          { clientId: APP_CLIENT_ID, baseUrl: DEFAULT_BASE_URL, flow: "app" },
          (path, form) => this.sendForm(path, form),
        );
        this.authCtl = this.makeAuthController(auth, this.makeAuthPort(), { mode: "app", baseUrl: DEFAULT_BASE_URL });
        await this.authCtl.start();
        return;
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
        this.sendForm(path, form),
      );
      this.authCtl = this.makeAuthController(auth, this.makeAuthPort(), { mode: "api", baseUrl: DEFAULT_BASE_URL });
      await this.authCtl.start();
    } catch (e) {
      this.log.error(`onReady failed: ${errText(e)}`);
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
      this.log.debug(`Could not refresh the manifest object names: ${errText(e)}`);
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
      this.log.debug(`Could not read the own objects — every object write goes out: ${errText(e)}`);
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
      this.log.debug(`Could not read the own states — every read-only state write goes out: ${errText(e)}`);
    }
  }

  /**
   * One sign-in request (device code, token poll, refresh): it goes to the same host Home Connect counts, so it takes a
   * place in the request budget — ahead of waiting reads, like a user's write — in every counterpart it fits: the
   * host's windows, and for a refresh the token endpoint's own (10 a minute, 100 a day). The REST API's day does not
   * count it (api-docs: "Every HTTPS request to the Home Connect REST API counts toward the daily limit").
   *
   * @param path the OAuth endpoint path
   * @param form the form fields
   * @returns the answer, or a transport failure when the adapter shut down while it waited
   */
  private async sendForm(path: string, form: Record<string, string>): Promise<FormPostResult> {
    // A rate pause of Home Connect holds the whole host — a token renewal waits for it like any request (fleet suite
    // D21: after a 429 with retry-after 60, no call before the minute is up). The stop ends the wait.
    const paused = this.restBlockedUntil - Date.now();
    if (paused > 0 && !this.terminating) {
      await this.waitOutPause(paused);
    }
    const call: LimitedCall = { host: API_HOST, method: "POST", path, body: new URLSearchParams(form).toString() };
    const place = this.terminating ? undefined : await this.spaceRequests("token", call);
    if (!place) {
      return {
        status: 0,
        ok: false,
        body: { error: "network_error", error_description: "the adapter is shutting down" },
      };
    }
    const res = await this.sent(place, postForm(DEFAULT_BASE_URL, path, form));
    // the body carries the tokens — the report gets the status and the OAuth code only
    const code = isRecord(res.body) && typeof res.body.error === "string" ? res.body.error : undefined;
    this.recorder.token(path, res.status, code);
    if (res.status === 429) {
      this.armRatePause(res.retryAfterMs ?? RATE_PAUSE_FALLBACK_MS);
    }
    return res;
  }

  /**
   * The instance's data folder (`common.dataFolder`, so a backup carries it).
   *
   * @returns its absolute path, or "" when it cannot be found
   */
  private findDataFolder(): string {
    try {
      return utils.getAbsoluteInstanceDataDir(this);
    } catch (e) {
      this.log.debug(`Could not find the instance's data folder: ${errText(e)}`);
      return "";
    }
  }

  /**
   * Take over the places of the last day a previous process of this instance left in its data folder.
   */
  private takeOverRequestBudget(): void {
    if (!this.dataDir) {
      return;
    }
    // Nothing there, or a file that cannot be read: the run starts with a full budget, and the next hand-over writes it.
    const read = readDataFile(this.dataDir, REQUEST_TIMES_FILE);
    if (read.error !== undefined) {
      this.log.debug(`Could not read the request budget of the previous run: ${read.error}`);
    }
    const now = Date.now();
    this.budget.restore(heldPlacesOf(read.value, now), now, restRead());
  }

  /**
   * Leave the places that still count for the next process of this instance, per counterpart and window: each counts
   * from its answer, else its send, and a request still on its way from now. While the adapter runs, a request's place
   * reaches the file within {@link HAND_OVER_EVERY_MS} ({@link settlePlace}); the stop hands over at its start, again
   * whenever a request ends after that — Home Connect counts a request at the latest when it answers, and an answer that
   * reaches this process after the stop would otherwise count from the stop, up to its delay too early for the next
   * process — and once more right before it reports done.
   */
  private handOverRequestBudget(): void {
    if (!this.dataDir) {
      return;
    }
    try {
      writeDataFile(this.dataDir, REQUEST_TIMES_FILE, { windows: this.budget.heldPlaces(Date.now()) });
    } catch (e) {
      this.log.debug(`Could not keep the request budget for the next run: ${errText(e)}`);
    }
  }

  /**
   * Read one of the own states: a read-only one from what the start-up read and the adapter's own writes hold (the
   * adapter is its only writer — one bulk read at the start, never one by one), a writable one from the database,
   * where a user's write may stand.
   *
   * @param id the namespace-relative or full own id
   * @returns the state, or null when there is none
   */
  private async readState(id: string): Promise<ioBroker.State | null | undefined> {
    if (this.objectMirror.readOnly(id)) {
      const held = this.stateMirror.held(this.objectMirror.fullId(id));
      if (held !== undefined) {
        return held as ioBroker.State | null;
      }
    }
    return this.getStateAsync(id);
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
      getState: id => this.readState(id),
      getObject: id => this.getObjectAsync(id),
      delObject: async id => {
        await this.delObjectAsync(id);
        this.objectMirror.forget(id);
        this.stateMirror.forget(this.objectMirror.fullId(id), false);
      },
      delState: async id => {
        await this.delStateAsync(id);
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
      errorBudgetLeft: () => this.errorBudgetLeft(Date.now()),
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
      () => this.deleteLeavesFirst(root),
      errText,
    );
    this.objectMirror.forgetTree(root);
    this.stateMirror.forget(this.objectMirror.fullId(root), true);
    return carried.reduce((n, c) => n + c.newIds.length, 0);
  }

  /**
   * Delete a tree from its deepest objects up, the root last. A recursive delete takes the root first
   * (js-controller 7.2.2 `_delForeignObject` → `_deleteObjects`), and the root of a device move carries its
   * journal (`native.movingTo`): a stop in the middle would leave the moved datapoints behind with nothing that
   * says where they belong. Deleting the root last keeps the journal until the tree below it is gone.
   *
   * @param root the namespace-relative root that goes away
   */
  private async deleteLeavesFirst(root: string): Promise<void> {
    const full = `${this.namespace}.${root}`;
    const list = await this.getObjectListAsync({ startkey: `${full}.`, endkey: `${full}.\u9999` });
    const below = list.rows.map(row => row.id).filter(id => id.startsWith(`${full}.`));
    below.sort((a, b) => b.split(".").length - a.split(".").length);
    for (const id of below) {
      await this.delForeignObjectAsync(id);
    }
    if (await this.getObjectAsync(root)) {
      await this.delObjectAsync(root);
    }
  }

  /**
   * The way this instance signs in: only the setting `app` chooses the app access (beta); anything else, also a missing
   * or mistyped value, is the developer access.
   *
   * @returns the access mode
   */
  private accessMode(): TokenMode {
    return this.config.accessMode === "app" ? "app" : "api";
  }

  /** Build the port the AuthController drives the sign-in lifecycle through. */
  private makeAuthPort(): AuthPort {
    return {
      log: this.log,
      loadRefreshToken: () => this.loadRefreshToken(),
      saveToken: token => Promise.resolve().then(() => this.saveToken(token)),
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
      clearStoredLogin: () => this.clearStoredLogin(),
      notify: message => this.notifyUser(message),
      onSignedIn: () => this.onAuthenticated(),
      setTimer: (cb, ms) => this.setTimeout(cb, ms),
      clearTimer: handle => this.clearTimeout(handle as ioBroker.Timeout),
      setIntervalTimer: (cb, ms) => this.setInterval(cb, ms),
      clearIntervalTimer: handle => this.clearInterval(handle as ioBroker.Interval),
    };
  }

  /**
   * The stored login lives as a file in the instance's data folder (fleet standard, Werkbank round 173 R173-13: a
   * secret the adapter creates is never a datapoint; every access goes through the fleet master `data-file.ts`). Up to
   * 2.0.0-alpha it stood in the datapoint `auth.session`: its value moves into the file once — the previous adapter
   * generation's cleartext JSON encrypted on the way — and the datapoint is deleted. A file that already holds a login is
   * newer and stays. When the file cannot be written, the datapoint stays for the next start and this run keeps the login
   * in memory.
   */
  private async moveSessionToFile(): Promise<void> {
    const held = this.stateMirror.held(this.objectMirror.fullId(SESSION_STATE))?.val;
    const session = typeof held === "string" ? held : "";
    if (session.length > 0 && this.storedSession() === undefined) {
      try {
        this.writeSession(extractRefreshToken(session) ? this.encrypt(session) : session);
      } catch (e) {
        this.unmovedSession = session;
        this.log.warn(
          `Could not move the stored Home Connect login into the instance's data folder (${errText(e)}) — it stays where it is until the next start.`,
        );
        return;
      }
    }
    if (this.objectMirror.has(SESSION_STATE)) {
      await this.delObjectAsync(SESSION_STATE);
      this.objectMirror.forget(SESSION_STATE);
      this.stateMirror.forget(this.objectMirror.fullId(SESSION_STATE), false);
    }
  }

  /**
   * The login text in the login file. A file that cannot be read is set aside — kept for a look instead of being
   * overwritten by the next sign-in — and counts as no login, like a file of another form.
   *
   * @returns the stored (encrypted) login text, or undefined
   */
  private storedSession(): string | undefined {
    if (!this.dataDir) {
      return undefined;
    }
    const read = readDataFile(this.dataDir, LOGIN_FILE);
    if (read.error !== undefined) {
      let kept = "";
      try {
        setAsideDataFile(this.dataDir, LOGIN_FILE, LOGIN_FILE_ASIDE);
        kept = ` — the file was kept as ${LOGIN_FILE_ASIDE}`;
      } catch (e) {
        this.log.debug(`Could not set the unreadable login file aside: ${errText(e)}`);
      }
      this.log.warn(
        `The stored Home Connect login could not be read (${read.error})${kept}; a new sign-in is required.`,
      );
      return undefined;
    }
    const session = isRecord(read.value) ? read.value.session : undefined;
    return typeof session === "string" && session.length > 0 ? session : undefined;
  }

  /**
   * Store the encrypted login text in the login file.
   *
   * @param session the encrypted login text
   * @throws {Error} when the data folder is unknown or the file cannot be written
   */
  private writeSession(session: string): void {
    if (!this.dataDir) {
      throw new Error("the instance's data folder is unknown");
    }
    writeDataFile(this.dataDir, LOGIN_FILE, { session });
  }

  /**
   * Read the refresh token out of the login file, handling both our own encrypted
   * format and the previous adapter's cleartext JSON (so a version update keeps the login).
   *
   * @returns the refresh token, or undefined if none is stored
   */
  private async loadRefreshToken(): Promise<string | undefined> {
    const raw = this.storedSession() ?? this.unmovedSession ?? "";
    // Fast exit for the common "never signed in" case. (Both readers below would
    // also return undefined for "", so this is clarity, not a guard.)
    if (raw.length === 0) {
      return undefined;
    }
    // Previous adapter: cleartext JSON — extractRefreshToken reads it directly. Our format: encrypted JSON.
    let plain = raw;
    if (!extractRefreshToken(raw)) {
      try {
        plain = this.decrypt(raw);
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
    const token = extractRefreshToken(plain);
    return token && (await this.ofThisAccess(plain)) ? token : undefined;
  }

  /**
   * Whether a stored login belongs to the access the settings choose. A login of the other access cannot sign in on
   * this one (another client): it is dropped once, and a new sign-in on the chosen way follows.
   *
   * @param plain the stored login text, decrypted
   * @returns true when it may be used
   */
  private async ofThisAccess(plain: string): Promise<boolean> {
    if (storedLoginMode(plain) === this.accessMode()) {
      return true;
    }
    this.log.info(
      "The Home Connect access was changed in the settings — the stored login belongs to the other access, a new sign-in is required.",
    );
    await this.clearStoredLogin();
    return false;
  }

  /**
   * Persist a freshly obtained token, encrypted, in the login file.
   *
   * @param token the token to store
   */
  private saveToken(token: StoredToken): void {
    this.writeSession(this.encrypt(JSON.stringify(token)));
    this.unmovedSession = undefined;
  }

  /**
   * Forget the stored login: the file, and a login the move could not take out of `auth.session` yet.
   */
  private async clearStoredLogin(): Promise<void> {
    if (this.dataDir) {
      removeDataFile(this.dataDir, LOGIN_FILE);
    }
    if (this.unmovedSession !== undefined) {
      this.unmovedSession = undefined;
      await this.setStateRemembered(SESSION_STATE, { val: "", ack: true });
    }
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
      // The event stream opens right after the appliance list, before the appliances
      // are read (krobi 2026-11-05 18:50, "Strom zuerst"): an event cannot be read
      // afterwards, and the first read of four appliances took a minute (tester
      // report 2026-10-23). Without a list it opens after the subscription below.
      let streamOpened = false;
      const openStream = (): void => {
        if (!streamOpened && !this.terminating) {
          streamOpened = true;
          this.startEventStream();
        }
      };
      // The appliance read gets its own catch: a failure there must not cost the
      // write path and the live updates. Before, a single broken response ended
      // the chain right here — the instance stayed signed in, with no event
      // stream and no state subscription, until the next restart.
      if (sync) {
        try {
          await sync.syncAppliances(openStream);
        } catch (e) {
          if (this.terminating) {
            this.log.debug(`start-up chain stopped at the ${current}: ${errText(e)}`);
            return;
          }
          this.log.error(`Setting up the appliances failed: ${errText(e)} — live updates start anyway.`);
        }
        if (this.terminating) {
          return;
        }
      }
      current = "state subscription";
      await this.subscribeStatesAsync("*");
      openStream();
    } catch (e) {
      if (this.terminating) {
        this.log.debug(`start-up chain stopped at the ${current}: ${errText(e)}`);
        return;
      }
      this.log.error(`Start-up failed at the ${current}: ${errText(e)}`);
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
      onEvent: ev => {
        this.recorder.stream(ev);
        this.sync?.handleStreamEvent(ev);
      },
      onConnected: (connected, quietSince) => {
        this.recorder.streamState(connected ? "opened" : "lost", connected ? undefined : this.eventStream?.lastError);
        this.streamUp = connected;
        void this.publishConnection();
        this.noteStreamState(connected, quietSince);
      },
      onUnauthorized: () => this.authCtl?.refreshNow() ?? Promise.resolve(false),
      // One daily quota for the stream and REST: a 429 on the stream pauses REST too.
      onRateLimited: ms => this.armRatePause(ms),
      takeSlot: () =>
        this.spaceRequests("stream", restRead(EVENTS_PATH)).then(place =>
          place ? this.streamPlace(place) : undefined,
        ),
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
        // On debug: an outage and its return are a state (`info.connection`), not a log line (the fleet rule,
        // inventory suite "counterpart gone and back"). A deferred catch-up says so — it came minutes after the
        // stream was back (measured live 2026-09-23: 21 minutes), which the line alone did not tell.
        // The hold-back is the adapter's own one-hour cooldown that PROTECTS the
        // daily quota — not an exhausted quota; below a minute it says seconds.
        const heldBack =
          heldBackMs <= 0
            ? ""
            : heldBackMs < 60_000
              ? ` (held back ${Math.max(1, Math.round(heldBackMs / 1000))} s to protect the daily request quota)`
              : ` (held back ${Math.round(heldBackMs / 60_000)} min to protect the daily request quota)`;
        this.log.debug(
          `Live updates were interrupted for ${Math.round(outageMs / 1000)} s — re-read the appliances${heldBack}.`,
        );
      }
    } catch (e) {
      this.log.warn(`re-reading the appliances after the stream outage failed: ${errText(e)}`);
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
      this.log.debug(`Could not write info.connection: ${errText(e)}`);
    }
  }

  /**
   * Messages from the settings panel: "Test connection" (`checkConnection`),
   * "Request a new sign-in link" (`requestSignIn`), "Reset sign-in" (`resetLogin`) and, in the app access (beta),
   * "Open the sign-in page" (`appSignInLink`) and "Finish the sign-in" (`appSignInComplete` with `{ address }`).
   * Async body with a top-level try/catch; every command answers, so the panel
   * never waits on a message that fell through.
   *
   * @param obj the incoming message
   */
  private async onMessage(obj: ioBroker.Message): Promise<void> {
    try {
      if (obj.command === "diagnostics") {
        const answer = await this.diagnostics.handle(obj.message);
        if (obj.callback) {
          this.sendTo(obj.from, obj.command, answer as Record<string, unknown>, obj.callback);
        }
        return;
      }
      if (obj.command === "checkConnection") {
        const answer = await this.checkConnection();
        if (obj.callback) {
          this.sendTo(obj.from, obj.command, answer, obj.callback);
        }
        return;
      }
      if (SIGN_IN_COMMANDS.has(obj.command)) {
        const answer = await this.answerSignIn(obj.command, obj.message);
        if (obj.callback) {
          this.sendTo(obj.from, obj.command, answer, obj.callback);
        }
        return;
      }
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { error: `Unknown command: ${String(obj.command)}` }, obj.callback);
      }
    } catch (e) {
      this.log.error(`onMessage failed: ${errText(e)}`);
      if (obj.callback) {
        this.sendTo(obj.from, obj.command, { error: errText(e) }, obj.callback);
      }
    }
  }

  /**
   * One sign-in step the settings panel asked for. A step that cannot go on answers with its reason and writes no
   * error line — the panel shows it; the pasted address reaches no log line at all.
   *
   * @param command the panel's command (one of {@link SIGN_IN_COMMANDS})
   * @param message the message body (unchecked)
   * @returns `{ result }` or `{ error }` (the admin's sendTo contract)
   */
  private async answerSignIn(command: string, message: unknown): Promise<{ result: string } | { error: string }> {
    const authCtl = this.authCtl;
    if (!authCtl) {
      if (this.accessMode() === "app") {
        return { error: "The sign-in did not start — look at the adapter's log." };
      }
      return command === "appSignInLink" || command === "appSignInComplete"
        ? { error: "The instance runs with the developer access — save the settings first." }
        : { error: tText("ctNoClientId") };
    }
    try {
      switch (command) {
        case "resetLogin":
          return { result: await authCtl.resetLogin() };
        case "appSignInLink":
          return { result: await authCtl.appSignInLink() };
        case "appSignInComplete": {
          const address = isRecord(message) ? message.address : undefined;
          if (typeof address !== "string") {
            return { error: NOTHING_PASTED };
          }
          return { result: await authCtl.completeAppSignIn(address) };
        }
        default:
          return { result: await authCtl.requestSignIn() };
      }
    } catch (e) {
      if (e instanceof AppSignInError) {
        return { error: errText(e) };
      }
      throw e;
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
    const app = this.accessMode() === "app";
    if (!app && (typeof this.config.clientID !== "string" || this.config.clientID.trim().length === 0)) {
      return { error: tText("ctNoClientId") };
    }
    if (!this.authCtl?.accessToken) {
      const url = (await this.getStateAsync("auth.verificationUrl"))?.val;
      const linkOpen = typeof url === "string" && url.length > 0;
      if (app) {
        return { error: linkOpen ? tText("ctAppNotSignedInLink") : tText("ctAppNotSignedIn") };
      }
      return { error: linkOpen ? tText("ctNotSignedInLink") : tText("ctNotSignedIn") };
    }
    if (Date.now() < this.restBlockedUntil) {
      const seconds = Math.ceil((this.restBlockedUntil - Date.now()) / 1000);
      return { error: tText("ctRatePaused", seconds) };
    }
    const sent = this.authCtl.accessToken;
    // The test request takes a slot like every other request and a 429 pauses REST like on every other path.
    const place = await this.spaceRequests("write", restRead());
    if (!place) {
      // refused while a spent limit holds (pumpSlots) — the wait until its next place frees
      return this.terminating
        ? { error: tText("ctShuttingDown") }
        : { error: tText("ctRatePaused", Math.max(1, Math.ceil((this.longHoldUntil - Date.now()) / 1000))) };
    }
    let res = await this.sent(place, getJson(DEFAULT_BASE_URL, "/api/homeappliances", sent, this.acceptLanguage()));
    if (res.status === 401) {
      const fresh = await this.tokenAfter401(sent);
      const again = fresh ? await this.spaceRequests("write", restRead()) : undefined;
      if (fresh && again) {
        res = await this.sent(again, getJson(DEFAULT_BASE_URL, "/api/homeappliances", fresh, this.acceptLanguage()));
      }
    }
    this.record("GET", "/api/homeappliances", res);
    if (res.status === 429) {
      this.armRatePause(res.retryAfterMs ?? RATE_PAUSE_FALLBACK_MS);
      return { error: tText("ctRateLimited", rateLimitText(res.description, res.retryAfterMs)) };
    }
    if (res.status === 401 || res.status === 403) {
      return { error: tText("ctLoginRejected", res.status) };
    }
    if (res.status === 0) {
      return { error: tText("ctUnreachable", res.error ?? "network error") };
    }
    if (!res.ok) {
      return {
        error: tText(
          "ctHttpError",
          res.status,
          `${res.error ?? "unknown error"}${res.description ? ` (${res.description})` : ""}`,
        ),
      };
    }
    const list = isRecord(res.data) && Array.isArray(res.data.homeappliances) ? res.data.homeappliances : undefined;
    if (!list) {
      return { error: tText("ctNoList") };
    }
    const online = list.filter(a => isRecord(a) && a.connected === true).length;
    const stream = this.streamUp
      ? tText("ctStreamUp")
      : tText("ctStreamDown", this.eventStream?.lastError ? ` (${this.eventStream.lastError})` : "");
    return { result: tText("ctResult", list.length, online, stream) };
  }

  /**
   * Keep one REST answer for the diagnostics report.
   *
   * @param method the HTTP method
   * @param path the request path
   * @param res the answer
   * @param body what a write sent
   */
  private record(method: string, path: string, res: JsonResult, body?: unknown): void {
    this.recorder.rest({
      method,
      path,
      status: res.status,
      ...(res.data !== undefined ? { data: res.data } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
      ...(res.description !== undefined ? { description: res.description } : {}),
      ...(body !== undefined ? { body } : {}),
    });
  }

  /**
   * GET one resource for the diagnostics report's live read: through the request budget, the 401 refresh and the 429
   * pause like every request, but without a word to the sync (no "not ready" re-read, no refused-definition booking)
   * and without a log line of the REST dedup — a report changes nothing in the adapter (DB-02).
   *
   * @param path the request path
   * @returns the answer; status 0 when none came or no request could go out
   */
  private async readRaw(path: string): Promise<LiveAnswer> {
    const token = this.authCtl?.accessToken;
    // Never queued behind a spent limit: a read would wait minutes or hours for its place, the report must not (decision 50).
    const place =
      this.terminating || !token || Date.now() < this.restBlockedUntil || this.limitSpent(Date.now())
        ? undefined
        : await this.spaceRequests("read", restRead(path));
    if (!token || !place) {
      return { path, status: 0, error: "no request went out" };
    }
    let res = await this.sent(place, getJson(DEFAULT_BASE_URL, path, token, this.acceptLanguage()));
    if (res.status === 401) {
      const fresh = await this.tokenAfter401(token);
      const again = fresh ? await this.spaceRequests("read", restRead(path)) : undefined;
      if (fresh && again) {
        res = await this.sent(again, getJson(DEFAULT_BASE_URL, path, fresh, this.acceptLanguage()));
      }
    }
    if (res.status === 429) {
      this.armRatePause(res.retryAfterMs ?? RATE_PAUSE_FALLBACK_MS);
    }
    return {
      path,
      status: res.status,
      ...(res.data !== undefined ? { data: res.data } : {}),
      ...(res.error !== undefined ? { error: res.error } : {}),
      ...(res.description !== undefined ? { description: res.description } : {}),
    };
  }

  /**
   * What the diagnostics report reads of this adapter — live, so a report shows the state of the moment. Built in the
   * constructor, so everything that js-controller gives the adapter later (log, host, version) is read when asked.
   *
   * @returns the host surface
   */
  private reportHost(): ReportHost {
    const adapter = this;
    return {
      get namespace() {
        return adapter.namespace;
      },
      get version() {
        return adapter.version ?? "unknown";
      },
      get hostName() {
        return adapter.host ?? "";
      },
      get systemLanguage() {
        return adapter.systemLanguage;
      },
      get log() {
        return adapter.log;
      },
      startedAt: this.startedAt,
      logRing: this.logRing,
      recorder: this.recorder,
      appliances: () =>
        (this.sync?.reportAppliances() ?? []).map(a => ({
          id: a.id,
          haId: a.haId,
          name: a.name,
          connected: a.reachable && this.signedIn && this.streamUp,
        })),
      config: () => ({
        accessMode: this.accessMode(),
        clientIdSet: typeof this.config.clientID === "string" && this.config.clientID.trim().length > 0,
        clientIdForm: looksLikeClientId(String(this.config.clientID ?? "").trim()),
        clientSecretSet: typeof this.config.clientSecret === "string" && this.config.clientSecret.length > 0,
      }),
      adapterState: () => {
        const now = Date.now();
        return {
          signedIn: this.signedIn,
          streamUp: this.streamUp,
          streamEverUp: this.streamEverUp,
          streamDownSince:
            this.streamDownSince !== undefined ? new Date(this.streamDownSince).toISOString() : undefined,
          streamLastError: this.eventStream?.lastError,
          restPausedForS: this.restBlockedUntil > now ? Math.ceil((this.restBlockedUntil - now) / 1000) : 0,
          requestsLastMinute: this.heldIn(now, MINUTE_SECONDS),
          requestsLastDay: this.heldIn(now, DAY_SECONDS),
          limitSpent: this.limitSpent(now),
          limitPlaceFreesInS: this.longHoldUntil > now ? Math.ceil((this.longHoldUntil - now) / 1000) : 0,
          errorStreak: this.errorSeries(now).held,
          lastReconnectSync: this.lastReconnectSync > 0 ? new Date(this.lastReconnectSync).toISOString() : undefined,
          signInLastError: this.stateMirror.held(this.objectMirror.fullId("auth.lastError"))?.val,
          // kind and times of the token, never a token; how the last pasted address carried its code, never the code
          token: this.authCtl?.tokenInfo(),
          pastedForm: this.authCtl?.lastPastedForm,
        };
      },
      applianceState: id => this.sync?.reportState(id) ?? {},
      secrets: () => {
        // the mirror holds the own states by full id
        const link = this.stateMirror.held(this.objectMirror.fullId("auth.verificationUrl"))?.val;
        const userCode = typeof link === "string" ? /[?&](?:user_)?code=([^&]+)/.exec(link)?.[1] : undefined;
        return [
          this.authCtl?.accessToken ?? "",
          String(this.config.clientID ?? ""),
          String(this.config.clientSecret ?? ""),
          typeof link === "string" ? link : "",
          userCode ?? "",
        ];
      },
      liveReadBlocked: () => {
        const now = Date.now();
        if (this.terminating) {
          return "the adapter is shutting down";
        }
        if (!this.authCtl?.accessToken) {
          return "not signed in to Home Connect";
        }
        if (this.restBlockedUntil > now) {
          return `Home Connect blocks requests for another ${Math.ceil((this.restBlockedUntil - now) / 1000)} s`;
        }
        if (this.limitSpent(now)) {
          return `a request limit is spent (${this.spentLimitWords()}) — reads wait for their place`;
        }
        if (!this.errorBudgetLeft(now)) {
          const { held, window } = this.errorSeries(now);
          return `${held} error answers in a row — requests wait (Home Connect blocks after ${window?.max ?? held})`;
        }
        return undefined;
      },
      readRaw: path => this.readRaw(path),
      getForeignObjectAsync: id => this.getForeignObjectAsync(id),
      getForeignStatesAsync: pattern => this.getForeignStatesAsync(pattern),
      getObjectViewAsync: (design, search, params) => this.getObjectViewAsync(design, search, params),
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
    const place = await this.spaceRequests("read", restRead(path));
    if (!place || this.restPaused(path)) {
      this.giveBack(place);
      return undefined;
    }
    let res = await this.sent(place, getJson(DEFAULT_BASE_URL, path, token, this.acceptLanguage()));
    if (res.status === 401) {
      // The retry is a request of its own: it takes a place like every other one.
      const fresh = await this.tokenAfter401(token);
      const again = fresh ? await this.spaceRequests("read", restRead(path)) : undefined;
      if (fresh && again) {
        res = await this.sent(again, getJson(DEFAULT_BASE_URL, path, fresh, this.acceptLanguage()));
      }
    }
    this.record("GET", path, res);
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
        // one line: the answer proves the endpoint kind healthy (info after a reported failure, debug otherwise)
        this.restLog.recovered(restLogKey(source), `${source} succeeded: ${answer} (a normal appliance answer).`);
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
    this.restLog.recovered(restLogKey(source), `${source} succeeded.`);
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
      this.restLog.report(
        restLogKey(source),
        `${source} dropped — not signed in to Home Connect (a new sign-in is pending).`,
        { kind: "auth" },
      );
      return undefined;
    }
    if (this.dropWhilePaused(source)) {
      return undefined;
    }
    const call = this.writeCall(req);
    const place = await this.spaceRequests("write", call);
    if (!place) {
      // Refused while a spent limit holds it (pumpSlots): its one warn line covers every command it drops (H-14).
      if (!this.terminating) {
        this.log.debug(`${source} dropped — the request quota is spent (${this.spentLimitWords()}).`);
      }
      return undefined;
    }
    // Re-checked after the wait: a 429 that arrived while this write queued for
    // its slot pauses it too.
    if (this.dropWhilePaused(source)) {
      this.giveBack(place);
      return undefined;
    }
    let res = await this.sent(place, this.sendWrite(req, token));
    if (res.status === 401) {
      // The retry is a request of its own: it takes a place like every other one.
      const fresh = await this.tokenAfter401(token);
      const again = fresh ? await this.spaceRequests("write", call) : undefined;
      if (fresh && again) {
        res = await this.sent(again, this.sendWrite(req, fresh));
      }
    }
    this.record(req.method, req.path, res, req.body);
    if (res.ok) {
      this.restLog.recovered(restLogKey(source), `${source} succeeded.`);
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
    this.restLog.report(
      restLogKey(source),
      `${source} dropped — Home Connect REST is paused (rate limit) for another ${seconds} s.`,
      { kind: "rate" },
    );
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
   * A write as the limits see it — with the body {@link sendWrite} sends: a PUT on `…/programs/active` is a program
   * start, a DELETE there a program stop (5 a minute each, src/lib/api-limits.json).
   *
   * @param req the resolved request
   * @returns the call
   */
  private writeCall(req: WriteRequest): LimitedCall {
    return {
      host: API_HOST,
      method: req.method,
      path: req.path,
      ...(req.method === "DELETE" ? {} : { body: JSON.stringify({ data: req.body }) }),
    };
  }

  /**
   * Take a place for one request: within each window of each counterpart of src/lib/api-limits.json the call fits, at
   * least the gap of the shortest window after the previous request. Callers queue up in {@link slotRank} order, so a
   * button does not wait behind the first read of all appliances.
   *
   * @param kind what the request is (see {@link SlotKind})
   * @param call the request as the limits see it
   * @returns the request's place, or undefined when the adapter started shutting down or — for a command — a window of
   *   a day holds it: the request must not go out then
   */
  private spaceRequests(kind: SlotKind, call: LimitedCall): Promise<RequestPlace | undefined> {
    if (this.terminating) {
      return Promise.resolve(undefined);
    }
    return new Promise<RequestPlace | undefined>(resolve => {
      const behind = this.slotQueue.findIndex(entry => slotRank(entry.kind) > slotRank(kind));
      const at = behind === -1 ? this.slotQueue.length : behind;
      this.slotQueue.splice(at, 0, { kind, call, resolve });
      // a wait the queue began for the requests before it says nothing about this one when it may go sooner — a request
      // of another counterpart, or one that now stands first — nor about a command a spent window holds longer than a
      // minute: the queue drops that one at once instead of leaving it to the end of its own wait
      const now = Date.now();
      const ms = this.budget.waitMs(now, call).ms;
      const dropNow = kind === "write" && ms !== undefined && ms > LONG_HOLD_AFTER_MS;
      if (this.wakePump && (dropNow || (ms ?? Infinity) < this.pumpWakeAt - now)) {
        this.wakePump();
      }
      void this.pumpSlots();
    });
  }

  /**
   * Stamp a request that just went out and follow it to its end: called with the transport call as its argument, so
   * the call has started — and reached fetch, which every transport calls before its first await — when the send stamp
   * is taken, in the same synchronous step (tooling round 140). The place holds until the call settles; with an answer
   * (`answeredAt`, taken by the transport as the headers came) it frees a window's length after it, without one a
   * window's length after this stamp (tooling round 170). Every stamp then lies at or after the network's own, and
   * every declared window holds without a reserve.
   *
   * @param place the request's place
   * @param call the transport call that was just started
   * @returns the same call
   */
  private sent<T extends { answeredAt?: number; answeredStatus?: number; status: number }>(
    place: RequestPlace,
    call: Promise<T>,
  ): Promise<T> {
    this.budget.sent(place, Date.now());
    void call.then(
      // the status the headers carried: a body that broke off after them still was Home Connect's answer
      res => this.settlePlace(place, res.answeredAt, res.answeredStatus ?? res.status),
      () => this.settlePlace(place, undefined, 0),
    );
    return call;
  }

  /**
   * The request of a place is over: the place now frees on its own, so the queue looks again. During the stop the
   * next process gets the place anew, counted from this answer; while the adapter runs it reaches the request file
   * within {@link HAND_OVER_EVERY_MS}, so a kill or a crash costs the next process at most that much of the day.
   *
   * @param place the request's place
   * @param answeredAt when Home Connect answered, undefined when no answer came
   * @param status the answer's HTTP status (0 = none)
   */
  private settlePlace(place: RequestPlace, answeredAt: number | undefined, status: number): void {
    this.placeChanged(this.budget.settle(place, answeredAt, status));
  }

  /**
   * A place changed (an answer, an end): the request file follows — at once during the stop, within
   * {@link HAND_OVER_EVERY_MS} while the adapter runs — and the queue looks again; while it sleeps for another request's
   * wait only when the answer ended a series of errors: that frees its places at once, every other change frees none
   * earlier than the queue's own wait.
   *
   * @param freed whether the answer ended a series of errors ({@link RequestBudget.answer})
   */
  private placeChanged(freed = false): void {
    if (this.terminating) {
      this.handOverRequestBudget();
    } else if (this.dataDir && this.handOverTimer === undefined) {
      this.handOverTimer = this.setTimeout(() => {
        this.handOverTimer = undefined;
        this.handOverRequestBudget();
      }, HAND_OVER_EVERY_MS);
    }
    if (freed) {
      this.wakePump?.();
    }
    void this.pumpSlots();
  }

  /**
   * Give back a place whose request did not go out (a rate pause came while it waited).
   *
   * @param place the place, if one was handed out
   */
  private giveBack(place: RequestPlace | undefined): void {
    if (place) {
      this.budget.drop(place);
      void this.pumpSlots();
    }
  }

  /**
   * The event stream's view of a place: it stamps the connect's send and answer itself ({@link sent} for a transport
   * that calls fetch on its own). The stream stays open as one of Home Connect's event monitoring channels until it
   * ends.
   *
   * @param place the connect's place
   * @returns the handle the stream reports to
   */
  private streamPlace(place: RequestPlace): StreamPlace {
    let went = false;
    return {
      sent: () => {
        went = true;
        this.budget.sent(place, Date.now());
      },
      answered: status => {
        this.placeChanged(this.budget.answer(place, Date.now(), status));
      },
      ended: () => {
        if (!went) {
          this.giveBack(place);
          return;
        }
        this.budget.close(place);
        this.placeChanged();
      },
    };
  }

  /**
   * The places that hold now in the strictest window of `seconds` a REST read counts in — for the report.
   *
   * @param now the current time (epoch ms)
   * @param seconds the window
   * @returns the number of places
   */
  private heldIn(now: number, seconds: number): number {
    const window = this.budget.strictestWindow(restRead(), seconds);
    return window ? this.budget.held(now, window.name, window.key) : 0;
  }

  /**
   * Hand out the places in queue order, waiting out the gap and every window between them. A place holds while its
   * request is on its way; when only such places fill a window, nothing can be timed — the queue rests until a request
   * settles ({@link settlePlace}) and looks again. The first request in queue order whose windows all have room goes:
   * one held in a window of its own (five program starts a minute) holds back no request of another counterpart. A
   * request held longer than {@link LONG_HOLD_AFTER_MS} — only a window of a day or of a series of errors does that — is
   * a spent window: a command is dropped, a read and a sign-in request wait ({@link noteLongHold}).
   */
  private async pumpSlots(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.slotQueue.length > 0 && !this.terminating) {
        const now = Date.now();
        this.limitSpent(now);
        // requests of the same kind wait alike: judged once per scan (a start queues hundreds of reads)
        const judged = new Map<string, ReturnType<RequestBudget["waitMs"]>>();
        let soonest: number | undefined;
        let next = -1;
        for (let k = 0; k < this.slotQueue.length; k++) {
          const entry = this.slotQueue[k];
          const sort = this.budget.sortOf(entry.call);
          const wait = judged.get(sort) ?? this.budget.waitMs(now, entry.call);
          judged.set(sort, wait);
          if (wait.ms === 0) {
            next = k;
            break;
          }
          if (wait.ms !== undefined && wait.ms > LONG_HOLD_AFTER_MS && wait.window) {
            this.noteLongHold(now, wait.ms, wait.window, entry.kind);
            if (entry.kind === "write") {
              // a command that went out hours later would act at a moment nobody chose
              this.slotQueue.splice(k, 1)[0].resolve(undefined);
              k--;
              continue;
            }
          } else if (wait.ms !== undefined && wait.ms > 0 && wait.window && !countsReads(wait.window.name)) {
            this.noteOwnHold(now, wait.ms, wait.window, entry.kind);
          }
          if (wait.ms !== undefined) {
            soonest = Math.min(soonest ?? wait.ms, wait.ms);
          }
        }
        if (next >= 0) {
          const [entry] = this.slotQueue.splice(next, 1);
          entry.resolve(this.budget.take(now, entry.call));
          continue;
        }
        this.noteMinuteBudget(now);
        if (soonest === undefined) {
          return;
        }
        await this.sleepPump(soonest);
      }
      this.refuseWaiting();
    } catch (e) {
      // The wait itself failed (the adapter's timer refused during shutdown): nothing that waits may go out.
      this.log.debug(`request queue stopped: ${errText(e)}`);
      this.refuseWaiting();
    } finally {
      this.pumping = false;
    }
  }

  /**
   * Say once per run that the minute's budget spreads the reads out.
   *
   * @param now the current time (epoch ms)
   */
  private noteMinuteBudget(now: number): void {
    if (this.budgetNoted || this.heldIn(now, MINUTE_SECONDS) < requestsPerMinute()) {
      return;
    }
    this.budgetNoted = true;
    this.log.info(
      `Home Connect allows ${requestsPerMinute()} requests per minute — reading the appliances is spread over the next minutes; the datapoints fill in as they arrive.`,
    );
  }

  /**
   * The queue's wait for the next place. Unlike `delay` it can end early — a request that comes into the queue is
   * judged at once ({@link wakePump}), and the stop ends it ({@link refuseWaiting}).
   *
   * @param ms the wait
   * @returns a promise that settles when the wait is over; rejected when the adapter's timer refuses (shutdown)
   */
  private sleepPump(ms: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.pumpWakeAt = Date.now() + ms;
      const timer = this.setTimeout(() => {
        this.wakePump = undefined;
        resolve();
      }, ms);
      if (timer === undefined) {
        reject(new Error("the adapter is shutting down"));
        return;
      }
      this.wakePump = () => {
        this.wakePump = undefined;
        this.clearTimeout(timer);
        resolve();
      };
    });
  }

  /**
   * Whether a limit of commands and reads is spent: a window holds them from its first long hold until it has a
   * minute's requests free again, a window of errors until none of its places holds — its series is over, or every
   * error left the window. A single freed place, taken at once, ends no episode, so a spent window says so once
   * (decision H-14).
   *
   * @param now the current time (epoch ms)
   * @returns whether a window spent for commands and reads holds
   */
  private limitSpent(now: number): boolean {
    for (const [id, spent] of this.spentWindows) {
      const { name, key, max } = spent.window;
      const room = countsErrors(key) ? max : Math.min(requestsPerMinute(), max);
      if (this.budget.held(now, name, key) <= max - room) {
        this.spentWindows.delete(id);
      }
    }
    return [...this.spentWindows.values()].some(spent => spent.kind !== "token");
  }

  /**
   * The limit of the window that holds commands and reads, in words — for the line of a dropped command.
   *
   * @returns "limit: … calls in …"
   */
  private spentLimitWords(): string {
    const spent = [...this.spentWindows.values()].find(s => s.kind !== "token");
    return spent ? `limit: ${limitWords(spent.window)}` : "limit unknown";
  }

  /**
   * A window of a day or of a series of errors holds a request: its next place frees `waitMs` from now. One line names
   * the limit and the wait — on warn at the first hold of a spent window, on debug for every later one until it has room
   * again (decision H-14).
   *
   * @param now the current time (epoch ms)
   * @param waitMs until the window's next place frees
   * @param window the window that holds
   * @param kind the kind of request it holds
   */
  private noteLongHold(now: number, waitMs: number, window: CountedWindow, kind: SlotKind): void {
    const id = `${window.name}\u0000${window.key}`;
    const fresh = now >= (this.holdUntil.get(id) ?? 0);
    this.holdUntil.set(id, now + waitMs);
    if (kind !== "token") {
      this.longHoldUntil = now + waitMs;
    }
    if (!fresh) {
      return;
    }
    const line =
      kind === "token"
        ? `The adapter holds its sign-in requests to Home Connect for ${spokenDuration(Math.ceil(waitMs / 1000))} (limit: ${limitWords(window)}, ${window.name}).`
        : `The adapter holds its requests to Home Connect for ${spokenDuration(Math.ceil(waitMs / 1000))} (limit: ${limitWords(window)}) — commands in that time are dropped, reads wait for their place.`;
    if (this.spentWindows.has(id)) {
      this.log.debug(line);
      return;
    }
    this.spentWindows.set(id, { window, kind });
    this.log.warn(line);
  }

  /**
   * A counterpart of its own (token refresh, program starts and stops) holds a request for up to a minute: one info line
   * names the limit and the wait at the first hold, none while that hold lasts (decision H-14) — the user's command
   * goes out when its place frees.
   *
   * @param now the current time (epoch ms)
   * @param waitMs until the window's next place frees
   * @param window the window that holds
   * @param kind the kind of request it holds
   */
  private noteOwnHold(now: number, waitMs: number, window: CountedWindow, kind: SlotKind): void {
    const id = `${window.name}\u0000${window.key}`;
    const fresh = now >= (this.holdUntil.get(id) ?? 0);
    this.holdUntil.set(id, Math.max(this.holdUntil.get(id) ?? 0, now + waitMs));
    if (fresh) {
      this.log.info(
        `The adapter holds ${HELD_WORDS[kind]} to Home Connect for ${spokenDuration(Math.ceil(waitMs / 1000))} (limit: ${limitWords(window)}, ${window.name}).`,
      );
    }
  }

  /** Answer every request still waiting for its place with "no" — the adapter is shutting down. */
  private refuseWaiting(): void {
    for (const entry of this.slotQueue.splice(0)) {
      entry.resolve(undefined);
    }
    this.wakePump?.();
  }

  /**
   * Wait out a pause of Home Connect; the stop ends the wait ({@link releasePauseWaits}) — js-controller resolves no
   * `delay` during a stop, and a token request still waiting would hold `authCtl.settle()` and with it the callback.
   *
   * @param ms the pause left
   * @returns a promise that settles when the pause is over or the adapter stops
   */
  private waitOutPause(ms: number): Promise<void> {
    return new Promise<void>(resolve => {
      const wait: { timer?: ioBroker.Timeout } = {};
      const done = (): void => {
        this.pauseWaits.delete(done);
        this.clearTimeout(wait.timer);
        resolve();
      };
      wait.timer = this.setTimeout(done, ms);
      if (wait.timer === undefined) {
        resolve();
        return;
      }
      this.pauseWaits.add(done);
    });
  }

  /** End every wait for a pause of Home Connect — the adapter is shutting down. */
  private releasePauseWaits(): void {
    for (const done of [...this.pauseWaits]) {
      done();
    }
  }

  /**
   * The series of error answers a REST request counts in now — in the window of errors src/lib/api-limits.json declares,
   * a request still on its way included (it may become one).
   *
   * @param now the current time (epoch ms)
   * @returns the places it holds and the window, while one is declared
   */
  private errorSeries(now: number): { held: number; window?: CountedWindow } {
    const window = this.budget.errorWindow(restRead());
    return window ? { held: this.budget.held(now, window.name, window.key), window } : { held: 0 };
  }

  /**
   * Whether an optional read (a definition) may still go out: the series of error answers stays
   * {@link ERROR_RESERVE} short of its limit.
   *
   * @param now the current time (epoch ms)
   * @returns whether it may go
   */
  private errorBudgetLeft(now: number): boolean {
    const { held, window } = this.errorSeries(now);
    return window === undefined || held < window.max - ERROR_RESERVE;
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
    const why =
      res.status === 429
        ? `${rateLimitText(res.description, res.retryAfterMs)} — the adapter waits and continues by itself`
        : `${res.error ?? "unknown"}${res.description ? ` (${res.description})` : ""}`;
    this.restLog.report(restLogKey(source), `${source} failed: ${why}`, { kind: categorize(res.status) });
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
      this.log.debug(`reading the system language failed: ${errText(e)} — labels in English`);
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
      this.log.debug(`Could not raise notification: ${errText(e)}`),
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
      // No request goes out from here on. The adapter's wait never ends during a stop (js-controller resolves no
      // `delay` then), so the requests waiting for a place hear "no" now and a token request waiting out a pause of
      // Home Connect stops waiting — either would hold `authCtl.settle()` below, and with it the callback. The day
      // spent so far goes to the next process — now, in case the host ends this process before the callback; again for
      // every request that ends after this (`settlePlace`) and once more right before the callback.
      this.refuseWaiting();
      this.releasePauseWaits();
      if (this.handOverTimer !== undefined) {
        this.clearTimeout(this.handOverTimer);
        this.handOverTimer = undefined;
      }
      this.handOverRequestBudget();
      // A report still being made ends after its current step, and no message starts a new one (round 165).
      this.diagnostics.stop();
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
      // A stop before the start read its own states (a host restart in the first moments) set no marker — the start
      // writes them only after that read, and the next start does it again. Writing them here would read each one back
      // from the database, because the mirrors know nothing yet (inventory run 2026-10-20: three single reads).
      const writes: Promise<unknown>[] = this.ownStatesRead
        ? [
            this.setStateIfChanged("info.connection", { val: false, ack: true }),
            this.setStateIfChanged("auth.signedIn", { val: false, ack: true }),
            // Off: nothing to report (the fleet's reason-text rule) — the next start asks again.
            this.setStateIfChanged("auth.lastError", { val: "Unknown", ack: true }),
          ]
        : [];
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
              this.log.debug(`Final shutdown write failed: ${errText(r.reason)}`);
            }
          }
        })
        .finally(() => {
          // a request still on its way counts from now; one that ends later hands over again (`settlePlace`)
          this.handOverRequestBudget();
          callback();
        });
      return;
    } catch {
      callback();
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode; the class rides on the factory for the tests (an `export` keyword next to
  // `module.exports` makes esbuild warn commonjs-variable-in-esm)
  module.exports = Object.assign((options: Partial<utils.AdapterOptions> | undefined) => new Homeconnect(options), {
    Homeconnect,
  });
} else {
  // Start the instance directly
  (() => new Homeconnect())();
}
