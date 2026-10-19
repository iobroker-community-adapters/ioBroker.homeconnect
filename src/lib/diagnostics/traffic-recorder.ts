// What homeconnect records for its diagnostics report (fleet standard "Diagnosebericht", krobi 2026-10-06; for
// homeconnect krobi 2026-10-19 21:35): every answer Home Connect gave, per appliance and for the account, in memory only
// (DB-01). Each source has its own ring (R2), what recurs is counted (R1) — a value the stream sends every minute keeps its
// last form and a count, and never pushes the rest out. The connection history is a list, not a ring: "was it offline,
// and when?" needs the order. Request headers, and with them the token, are never recorded; the token endpoint only by
// its status and OAuth code (its body carries the tokens).

import { ByteRing, type RingEntry } from "./byte-ring";
import type { SseEvent } from "../sse-parser";

/** One answer of the REST API, as the report shows it. */
export interface RestRecord {
  /** `GET`, `PUT`, `DELETE`. */
  method: string;
  /** The path, as requested. */
  path: string;
  /** The HTTP status; 0 when no answer came (timeout, network). */
  status: number;
  /** The unwrapped answer body. */
  data?: unknown;
  /** The BSH error key, or the transport error. */
  error?: string;
  /** Home Connect's error description. */
  description?: string;
  /** What a write sent. */
  body?: unknown;
}

/** One stream event, as the report shows it. */
export interface StreamRecord {
  /** The event type (`STATUS`, `NOTIFY`, `EVENT`, `CONNECTED` …). */
  event: string;
  /** The event data — parsed JSON, or the text as it came. */
  data: unknown;
}

/** One change of an appliance's connection, as the stream reported it. */
export interface ConnectionChange {
  /** When (ISO time). */
  at: string;
  /** `CONNECTED`, `PAIRED`, `DISCONNECTED`. */
  event: string;
}

/** What the report shows of one appliance's traffic. */
export interface ApplianceTrail {
  /** Every GET answer, by path and status. */
  rest: Array<RingEntry<RestRecord>>;
  /** Every write and its answer. */
  writes: Array<RingEntry<RestRecord>>;
  /** Every stream event, by type and item keys. */
  stream: Array<RingEntry<StreamRecord>>;
  /** The connection changes, oldest first. */
  connection: ConnectionChange[];
}

/** What the report shows of the account's traffic (no appliance in the path). */
export interface AccountTrail {
  /** The account's REST answers (the appliance list, the token endpoint). */
  rest: Array<RingEntry<RestRecord>>;
  /** The event stream's own events (opened, lost) and events that name no appliance. */
  stream: Array<RingEntry<StreamRecord>>;
}

/** Byte limits per ring (R2) and per entry (R3): a whole program list fits, a minute of stream values does too. */
export const RING_LIMITS = {
  rest: { ring: 256 * 1024, entry: 64 * 1024 },
  writes: { ring: 32 * 1024, entry: 8 * 1024 },
  stream: { ring: 128 * 1024, entry: 16 * 1024 },
  account: { ring: 32 * 1024, entry: 8 * 1024 },
} as const;

/** Connection changes kept per appliance. */
export const CONNECTION_HISTORY = 50;

/** The stream events that change an appliance's connection (DEPAIRED drops the appliance's rings instead). */
const CONNECTION_EVENTS = new Set(["CONNECTED", "PAIRED", "DISCONNECTED"]);

/** The rings of one appliance. */
interface ApplianceRings {
  rest: ByteRing<RestRecord>;
  writes: ByteRing<RestRecord>;
  stream: ByteRing<StreamRecord>;
  connection: ConnectionChange[];
}

/**
 * The appliance a REST path is about: `/api/homeappliances/<haId>/…`.
 *
 * @param path the request path
 * @returns the haId, or undefined for an account path
 */
export function haIdOfPath(path: string): string | undefined {
  const match = /^\/api\/homeappliances\/([^/?]+)/.exec(path);
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * A stream event's data as the report shows it: parsed when it is JSON, else the text.
 *
 * @param data the event's data text
 * @returns the data
 */
function parsedData(data: string): unknown {
  if (data.length === 0) {
    return "";
  }
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return data;
  }
}

/**
 * The item keys of a stream event — two events with the same keys are the same entry (R1), their last values stand.
 *
 * @param data the parsed data
 * @returns the keys, comma-joined
 */
function itemKeys(data: unknown): string {
  const items = typeof data === "object" && data !== null ? (data as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) {
    return "";
  }
  return items
    .map(item => (typeof item === "object" && item !== null ? (item as { key?: unknown }).key : undefined))
    .filter((key): key is string => typeof key === "string")
    .join(",");
}

/** homeconnect's traffic recorder: per appliance and for the account, in memory only. */
export class TrafficRecorder {
  private readonly appliances = new Map<string, ApplianceRings>();
  private readonly accountRest: ByteRing<RestRecord>;
  private readonly accountStream: ByteRing<StreamRecord>;

  /**
   * @param now the clock (injectable for tests)
   */
  public constructor(private readonly now: () => number = Date.now) {
    this.accountRest = new ByteRing(RING_LIMITS.account.ring, RING_LIMITS.account.entry, now);
    this.accountStream = new ByteRing(RING_LIMITS.account.ring, RING_LIMITS.account.entry, now);
  }

  /**
   * Record one REST answer: a GET under its appliance's `rest`, a write under its `writes`, a path without appliance
   * under the account.
   *
   * @param record the answer
   */
  public rest(record: RestRecord): void {
    const haId = haIdOfPath(record.path);
    const key = `${record.method} ${record.path} ${record.status}`;
    if (haId === undefined) {
      this.accountRest.add(key, record);
      return;
    }
    const rings = this.rings(haId);
    (record.method === "GET" ? rings.rest : rings.writes).add(key, record);
  }

  /**
   * Record a sign-in endpoint's answer (device authorization, token) — its status and OAuth code only, never its body.
   *
   * @param path the endpoint path
   * @param status the HTTP status
   * @param code the OAuth error code, when it refused
   */
  public token(path: string, status: number, code?: string): void {
    this.accountRest.add(`POST ${path} ${status} ${code ?? ""}`, {
      method: "POST",
      path,
      status,
      ...(code !== undefined ? { error: code } : {}),
    });
  }

  /**
   * Record one stream event under its appliance (the event's `id` is its haId) or under the account.
   *
   * @param event the event as the parser gave it
   */
  public stream(event: SseEvent): void {
    const data = parsedData(event.data);
    const fromData =
      typeof data === "object" && data !== null && typeof (data as { haId?: unknown }).haId === "string"
        ? (data as { haId: string }).haId
        : undefined;
    const haId = fromData ?? (event.id !== undefined && event.id.length > 0 ? event.id : undefined);
    const record: StreamRecord = { event: event.event, data };
    if (haId === undefined) {
      this.accountStream.add(event.event, record);
      return;
    }
    if (event.event === "DEPAIRED") {
      // the appliance left the account and its tree goes with it — nothing can ask for its report any more
      this.forget(haId);
      return;
    }
    const rings = this.rings(haId);
    rings.stream.add(`${event.event} ${itemKeys(data)}`, record);
    if (CONNECTION_EVENTS.has(event.event)) {
      rings.connection.push({ at: new Date(this.now()).toISOString(), event: event.event });
      if (rings.connection.length > CONNECTION_HISTORY) {
        rings.connection.splice(0, rings.connection.length - CONNECTION_HISTORY);
      }
    }
  }

  /**
   * Record what the event stream itself did — connected, refused, lost.
   *
   * @param what one word (`opened`, `refused`, `lost`)
   * @param detail the reason, when there is one
   */
  public streamState(what: string, detail?: string): void {
    this.accountStream.add(`stream ${what} ${detail ?? ""}`, { event: `stream ${what}`, data: detail ?? "" });
  }

  /**
   * Forget an appliance that left the account.
   *
   * @param haId the appliance
   */
  public forget(haId: string): void {
    this.appliances.delete(haId);
  }

  /**
   * What the rings hold for one appliance — copies, so the report never changes them.
   *
   * @param haId the appliance
   * @returns its trail (empty when nothing was recorded)
   */
  public snapshot(haId: string): ApplianceTrail {
    const rings = this.appliances.get(haId);
    return {
      rest: rings?.rest.snapshot() ?? [],
      writes: rings?.writes.snapshot() ?? [],
      stream: rings?.stream.snapshot() ?? [],
      connection: rings ? rings.connection.map(change => ({ ...change })) : [],
    };
  }

  /**
   * What the account rings hold.
   *
   * @returns the account trail
   */
  public account(): AccountTrail {
    return { rest: this.accountRest.snapshot(), stream: this.accountStream.snapshot() };
  }

  /**
   * One appliance's rings, made on first use.
   *
   * @param haId the appliance
   * @returns its rings
   */
  private rings(haId: string): ApplianceRings {
    let rings = this.appliances.get(haId);
    if (!rings) {
      rings = {
        rest: new ByteRing(RING_LIMITS.rest.ring, RING_LIMITS.rest.entry, this.now),
        writes: new ByteRing(RING_LIMITS.writes.ring, RING_LIMITS.writes.entry, this.now),
        stream: new ByteRing(RING_LIMITS.stream.ring, RING_LIMITS.stream.entry, this.now),
        connection: [],
      };
      this.appliances.set(haId, rings);
    }
    return rings;
  }
}
