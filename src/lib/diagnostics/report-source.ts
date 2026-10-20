// homeconnect's side of the fleet master `ReportJobs` (fleet standard "Diagnosebericht", krobi 2026-10-06; for homeconnect
// krobi 2026-10-19 21:35): its appliances, the live read of a connected one and the report body. The live read asks a fixed
// set of six resources through the adapter's own request budget and writes nothing — not the tree, not a cache, not the
// sync's bookkeeping (DB-02); its first unanswered request ends it, so a silent cloud costs one timeout, not six. The
// recorded traffic is taken BEFORE the live read, so the read never pushes the history out of the rings it stands beside.
// Privacy (DB-04/DB-05): secrets are blanked first, then every appliance's haId and serial and every name a user gave —
// of ALL appliances, since the account traffic and the log name the others too — become placeholders.

import type { LogLine, LogRing } from "./log-ring";
import { Placeholders } from "./placeholders";
import type { ReportBody, ReportContent, ReportSource, ReportSourceDevice } from "./report-jobs";
import type { AccountTrail, ApplianceTrail, TrafficRecorder } from "./traffic-recorder";
import { PROGRAMLESS_TYPES } from "../device-catalog";
import { pieceNumber } from "../device-id";

/** The resources the live read asks, in this order: a success between the two that answer 404 while idle. */
export const LIVE_PATHS = ["", "/status", "/programs/selected", "/settings", "/programs/active", "/programs/available"];

/** A serial shorter than this is no serial of its own (it would replace every such number in the report). */
const MIN_SERIAL_LENGTH = 8;

/** What stands in a blanked secret. */
export const SECRET_MARK = "<secret>";

/** One appliance as the adapter knows it. */
export interface ReportAppliance {
  /** The device id (folder id). */
  id: string;
  /** Home Connect's id of the appliance — it carries the serial. */
  haId: string;
  /** The name the user gave it in the app. */
  name?: string;
  /** Whether it is reachable right now and the adapter is connected to Home Connect. */
  connected: boolean;
}

/** One answer of the live read. */
export interface LiveAnswer {
  /** The resource, below the appliance. */
  path: string;
  /** The HTTP status; 0 when no answer came. */
  status: number;
  /** The unwrapped body. */
  data?: unknown;
  /** The BSH error key or transport error. */
  error?: string;
  /** Home Connect's error description. */
  description?: string;
}

/** What the report source reads of the running adapter. */
export interface ReportHost {
  /** The instance, e.g. `homeconnect.0`. */
  readonly namespace: string;
  /** The adapter version. */
  readonly version: string;
  /** The host this instance runs on. */
  readonly hostName: string;
  /** The system language. */
  readonly systemLanguage?: string;
  /** When this run started (ms). */
  readonly startedAt: number;
  /** The adapter's recent log lines. */
  readonly logRing: LogRing;
  /** The recorded traffic. */
  readonly recorder: TrafficRecorder;
  /** The adapter log — read when a report is made (a logger taken in the constructor was undefined, yamaha 2026-10-06). */
  readonly log: { info(message: string): void; warn(message: string): void };
  /** The appliances this instance runs. */
  appliances(): ReportAppliance[];
  /** The instance settings, without a value that is the user's own. */
  config(): Record<string, unknown>;
  /** The adapter's state: sign-in, stream, rate pause, request budget. */
  adapterState(): Record<string, unknown>;
  /** What the sync knows of one appliance beyond its tree. */
  applianceState(id: string): Record<string, unknown>;
  /** Every secret the adapter holds right now (tokens, client id and secret, sign-in code and link). */
  secrets(): string[];
  /** Why no request may go out right now (rate pause, error budget, not signed in), or undefined. */
  liveReadBlocked(): string | undefined;
  /** GET one resource through the adapter's budget, without any side effect on the sync. */
  readRaw(path: string): Promise<LiveAnswer>;
  /** Read one object. */
  getForeignObjectAsync(id: string): Promise<ioBroker.Object | null | undefined>;
  /** Read every state a pattern names. */
  getForeignStatesAsync(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>>;
  /** Read a range of objects. */
  getObjectViewAsync(
    design: "system",
    search: "state",
    params: { startkey: string; endkey: string },
  ): Promise<{ rows: Array<{ id: string; value: ioBroker.Object | null }> } | null | undefined>;
}

/** One datapoint of the appliance's tree as the report shows it. */
export interface TreeEntry {
  /** The id below the appliance. */
  id: string;
  /** `common.type`. */
  type?: string;
  /** `common.role`. */
  role?: string;
  /** `common.unit`. */
  unit?: string;
  /** `common.write`. */
  write?: boolean;
  /** `common.min`. */
  min?: number;
  /** `common.max`. */
  max?: number;
  /** `common.step`. */
  step?: number;
  /** `common.states` — the value list. */
  states?: unknown;
  /** The value. */
  val?: unknown;
  /** Whether the value is confirmed. */
  ack?: boolean;
  /** When the value was written (ISO time). */
  ts?: string;
}

/** The report body before the privacy pass. */
export interface HomeConnectReportContent extends ReportContent {
  /** The installation: js-controller, language, settings. */
  environment: Record<string, unknown>;
  /** Sign-in, stream, rate pause, request budget. */
  adapterState: Record<string, unknown>;
  /** The appliance: ids, name, its object's native, what the sync knows. */
  appliance: Record<string, unknown>;
  /**
   * The live read's answers, or why it failed. Absent when the appliance was not connected — the frame says so
   * (`connected`, `liveRead`), and a fixed sentence in every report says nothing (DB-14, krobi 2026-10-20).
   */
  live?: { answers: LiveAnswer[] } | { error: string };
  /** The appliance's recorded traffic. */
  traffic: ApplianceTrail;
  /** The account's recorded traffic. */
  account: AccountTrail;
  /** The appliance's datapoints. */
  objectTree: TreeEntry[];
  /** The log lines about the appliance. */
  logs: LogLine[];
}

/** homeconnect's report source. */
export class HomeConnectReportSource implements ReportSource<LiveAnswer[]> {
  public readonly adapter = "homeconnect";
  /** The recorded traffic per appliance, taken at the start of its live read and used by its body. */
  private readonly trails = new Map<string, ApplianceTrail>();

  /**
   * @param host the running adapter
   */
  public constructor(private readonly host: ReportHost) {}

  /** @returns the adapter version */
  public get version(): string {
    return this.host.version;
  }

  /** @returns the adapter log */
  public get log(): { info(message: string): void; warn(message: string): void } {
    return this.host.log;
  }

  /** @returns every appliance, connected or not — a report is wanted exactly when one misbehaves */
  public devices(): ReportSourceDevice[] {
    return this.host.appliances().map(a => ({ id: a.id, label: a.name, connected: a.connected }));
  }

  /**
   * Read one connected appliance live: the fixed resources in order, until the first one nobody answers.
   *
   * @param id the device id
   * @returns the answers
   */
  public async readLive(id: string): Promise<LiveAnswer[]> {
    const appliance = this.appliance(id);
    this.trails.set(id, this.host.recorder.snapshot(appliance.haId));
    const blocked = this.host.liveReadBlocked();
    if (blocked !== undefined) {
      throw new Error(blocked);
    }
    const base = `/api/homeappliances/${encodeURIComponent(appliance.haId)}`;
    // An appliance without programs answers every program path with 409, and every error answer counts towards Home
    // Connect's limit of ten in ten minutes — the sync never asks them either (measured 2026-10-20 on a fridge-freezer).
    const type = this.host.applianceState(id).type;
    const paths =
      typeof type === "string" && PROGRAMLESS_TYPES.has(type)
        ? LIVE_PATHS.filter(path => !path.startsWith("/programs"))
        : LIVE_PATHS;
    const answers: LiveAnswer[] = [];
    for (const path of paths) {
      const answer = await this.host.readRaw(`${base}${path}`);
      answers.push({ ...answer, path: path || "/" });
      if (answer.status === 0) {
        break;
      }
    }
    // A read nobody answered is a failed read, never `read` (DB-02).
    if (!answers.some(answer => answer.status > 0)) {
      throw new Error(`Home Connect answered nothing (${answers[0]?.error ?? "no request went out"})`);
    }
    return answers;
  }

  /**
   * Build one appliance's report body.
   *
   * @param id the device id
   * @param live what the live read returned (undefined when not connected or it failed)
   * @param liveError why the live read failed
   * @returns the body and the device id as the report shows it
   */
  public async build(id: string, live: LiveAnswer[] | undefined, liveError: string | undefined): Promise<ReportBody> {
    const appliances = this.host.appliances();
    const appliance = this.appliance(id);
    const traffic = this.trails.get(id) ?? this.host.recorder.snapshot(appliance.haId);
    this.trails.delete(id);
    const prefix = `${this.host.namespace}.${id}`;
    const [hostObject, deviceObject, tree] = await Promise.all([
      this.host.getForeignObjectAsync(`system.host.${this.host.hostName}`).catch(() => null),
      this.host.getForeignObjectAsync(prefix).catch(() => null),
      this.tree(prefix),
    ]);
    const others = appliances.filter(a => a.id !== id).flatMap(a => [a.id, a.haId, a.name ?? ""]);
    const content: HomeConnectReportContent = {
      environment: {
        jsController: (hostObject?.common as { installedVersion?: string } | undefined)?.installedVersion,
        systemLanguage: this.host.systemLanguage,
        startedAt: new Date(this.host.startedAt).toISOString(),
        appliances: { total: appliances.length, connected: appliances.filter(a => a.connected).length },
        config: this.host.config(),
      },
      adapterState: this.host.adapterState(),
      appliance: {
        id,
        haId: appliance.haId,
        name: appliance.name,
        connected: appliance.connected,
        native: deviceObject?.native ?? {},
        sync: this.host.applianceState(id),
      },
      live: live ? { answers: live } : liveError !== undefined ? { error: liveError } : undefined,
      traffic,
      account: this.host.recorder.account(),
      objectTree: tree,
      logs: this.host.logRing.about([id, appliance.haId, appliance.name ?? ""], others),
    };
    const places = this.placeholders(appliances, tree);
    const blanked = blankSecrets(content, this.host.secrets());
    return { fileId: places.text(id), content: places.deep(blanked) as ReportContent };
  }

  /**
   * The placeholders of one report: every appliance's haId and serial, every name a user gave (the appliances' names and
   * the favourites' program names in the tree).
   *
   * @param appliances all appliances
   * @param tree the reported appliance's tree
   * @returns the placeholders
   */
  private placeholders(appliances: readonly ReportAppliance[], tree: readonly TreeEntry[]): Placeholders {
    const places = new Placeholders();
    for (const appliance of appliances) {
      places.name(appliance.haId, "serial");
      const piece = pieceNumber(appliance.haId);
      if (piece !== undefined && piece.length >= MIN_SERIAL_LENGTH) {
        places.name(piece, "serial");
      }
      if (appliance.name) {
        places.name(appliance.name);
      }
    }
    for (const entry of tree) {
      if (/(?:^|\.)programName$/.test(entry.id) && typeof entry.val === "string") {
        places.name(entry.val);
      }
    }
    return places;
  }

  /**
   * The appliance's datapoints as they really exist — type, role, unit, limits, value list and value. ONE appliance's
   * subtree, its values in ONE read.
   *
   * @param prefix the appliance's full id
   * @returns one entry per datapoint
   */
  private async tree(prefix: string): Promise<TreeEntry[]> {
    const start = `${prefix}.`;
    const [view, states] = await Promise.all([
      this.host.getObjectViewAsync("system", "state", { startkey: start, endkey: `${start}香` }).catch(() => null),
      this.host.getForeignStatesAsync(`${start}*`).catch(() => null),
    ]);
    return (view?.rows ?? []).map(row => {
      const common = (row.value?.common ?? {}) as Partial<ioBroker.StateCommon>;
      const state = states?.[row.id];
      return {
        id: row.id.slice(start.length),
        type: common.type,
        role: common.role,
        unit: common.unit,
        write: common.write,
        min: common.min,
        max: common.max,
        step: common.step,
        states: common.states,
        val: state?.val,
        ack: state?.ack,
        ts: typeof state?.ts === "number" ? new Date(state.ts).toISOString() : undefined,
      };
    });
  }

  /**
   * One appliance.
   *
   * @param id the device id
   * @returns the appliance
   */
  private appliance(id: string): ReportAppliance {
    const appliance = this.host.appliances().find(a => a.id === id);
    if (!appliance) {
      throw new Error(`unknown device '${id}'`);
    }
    return appliance;
  }
}

/**
 * Replace every secret wherever it stands in a string of the content, keys included — before the placeholders.
 *
 * @param value the content
 * @param secrets the secrets (blank ones are skipped)
 * @returns a copy without them
 */
export function blankSecrets(value: unknown, secrets: readonly string[]): unknown {
  const real = secrets.filter(secret => secret.trim().length > 0).sort((a, b) => b.length - a.length);
  const blank = (text: string): string => real.reduce((out, secret) => out.split(secret).join(SECRET_MARK), text);
  const walk = (item: unknown): unknown => {
    if (typeof item === "string") {
      return blank(item);
    }
    if (Array.isArray(item)) {
      return item.map(walk);
    }
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, inner]) => [blank(key), walk(inner)]));
    }
    return item;
  };
  return walk(value);
}
