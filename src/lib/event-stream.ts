// Home Connect event stream — one persistent Server-Sent-Events connection that
// replaces the old adapter's per-appliance polling and its leaky `eventsource`
// listeners. Uses Node 22 `fetch` streaming + the pure SseParser; timers are
// injected so the adapter owns them (managed, cleared on unload).

import { SseParser, type SseEvent } from "./sse-parser";
import { errMessage, isRecord } from "./pure-helpers";
import { errorKey, readBodyCapped, retryAfterMs } from "./http";

/** SSE endpoint for all appliances (the "all" stream also carries PAIRED/DEPAIRED). */
const EVENTS_PATH = "/api/homeappliances/events";
/**
 * Consider the connection dead if no traffic (incl. KEEP-ALIVE) arrives within
 * this window. The heartbeat comes every ~55 s; 90 s did not survive a single
 * missed one (the next arrives after ~110 s), and every miss cost a reconnect
 * plus a request. Two heartbeats and a margin — the research's proven "2 min".
 */
const KEEPALIVE_TIMEOUT_MS = 130_000;
/** Pause after a 429 on the stream that carries no Retry-After. */
const RATE_LIMIT_FALLBACK_MS = 60_000;
/** How much of a refused connect's body is read for its error key. */
const REFUSED_BODY_BYTES = 16 * 1024;
/** How long reading a refused connect's body may take — a body that never ends must not stall the stream. */
const REFUSED_BODY_TIMEOUT_MS = 5_000;
/** Reconnect backoff bounds. */
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 5 * 60_000;
/** A connection that stayed up at least this long counts as healthy → reset the backoff. */
const STABLE_CONNECTION_MS = 60_000;
/**
 * Give up on a connect attempt that produced no response headers within this
 * window. The keep-alive watchdog only exists once the body streams — a
 * connect that hangs before that (TCP up, no answer) would otherwise never end,
 * and with it the whole live-update path.
 */
const CONNECT_TIMEOUT_MS = 30_000;

/**
 * The reason of a refused connect, with its likely cause as a half sentence —
 * the fleet rule for a warning. The stream endpoint is fixed, so a 404 is the
 * cloud's doing as much as a 5xx (measured live 2026-09-23: 503, 504 and 404 in
 * one morning, each warned as a bare "status 503").
 *
 * The body's BSH error key is named too when there is one: a 403 is often a
 * missing scope, not a rejected login — only the key tells.
 *
 * @param status the HTTP status of the refused connect
 * @param key the BSH error key of the answer, if any
 * @returns the reason for the log line and the connection test
 */
function refusedReason(status: number, key?: string): string {
  const detail = key ? ` (${key})` : "";
  if (status >= 500 || status === 404) {
    return `HTTP ${status}${detail}, a problem on the Home Connect side`;
  }
  if (status === 401 || status === 403) {
    return `HTTP ${status}${detail}, the login was rejected`;
  }
  if (status === 429) {
    return `HTTP 429${detail}, the Home Connect rate limit`;
  }
  return `HTTP ${status}${detail}`;
}

/**
 * The BSH error key of a refused answer — read capped, never throwing. Reading
 * the body also frees the connection (undici keeps an unread body until GC).
 *
 * @param res the refused response
 * @returns the error key, if the body carries one
 */
async function refusedKey(res: Response): Promise<string | undefined> {
  try {
    const text = await readBodyCapped(res, REFUSED_BODY_BYTES);
    if (!text) {
      return undefined;
    }
    const body: unknown = JSON.parse(text);
    return isRecord(body) ? errorKey(body) : undefined;
  } catch {
    return undefined;
  }
}

/** Everything the stream needs from the adapter, injected for testability + managed timers. */
export interface EventStreamDeps {
  /** Region base URL. */
  baseUrl: string;
  /** The current access token, or undefined if not signed in yet. */
  getAccessToken: () => string | undefined;
  /** Called with each non-KEEP-ALIVE event. */
  onEvent: (event: SseEvent) => void;
  /**
   * Called when the connection goes up (true) or down (false). On a down-report after the keep-alive watchdog
   * fired, `quietSince` is the epoch-ms of the last traffic — the stream was dead from then on, not only from the
   * abort.
   */
  onConnected: (connected: boolean, quietSince?: number) => void;
  /**
   * Called when the stream endpoint rejects the token (401). The adapter
   * refreshes the token; the next attempt then carries the fresh one. Without
   * this, a token revoked server-side would keep the stream dead until the
   * periodic refresh notices the expiry — up to a day later.
   */
  onUnauthorized?: () => Promise<boolean>;
  /**
   * Called when the stream endpoint answers 429, with the pause in ms. The daily
   * quota is shared with REST, so the adapter pauses REST too.
   */
  onRateLimited?: (ms: number) => void;
  /** Log sink. */
  log: (level: "debug" | "info" | "warn", msg: string) => void;
  /** Schedule a callback (the adapter's managed setTimeout). */
  setTimer: (cb: () => void, ms: number) => unknown;
  /** Cancel a scheduled callback (the adapter's managed clearTimeout). */
  clearTimer: (handle: unknown) => void;
  /** Clock, injectable for deterministic tests (defaults to Date.now). */
  now?: () => number;
}

/** A persistent, self-reconnecting Home Connect event-stream connection. */
export class EventStream {
  private stopped = true;
  private abort: AbortController | undefined;
  private keepAliveTimer: unknown;
  private reconnectTimer: unknown;
  private connectTimer: unknown;
  private failures = 0;
  /** Whether the "connected" info line was already logged this session (reconnects stay on debug). */
  private loggedConnected = false;
  /** Whether the current failing spell was already warned about (repeats → debug, recovery → info). */
  private failureWarned = false;
  /** The reason of the last failed connect attempt, cleared once the stream is up (for the connection test). */
  private lastFailure: string | undefined;
  /** Epoch-ms before which no reconnect may go out (a 429 on the stream). */
  private rateLimitedUntil = 0;
  /** Epoch-ms of the last traffic on the open connection (every chunk re-arms the keep-alive watchdog). */
  private lastTrafficAt: number | undefined;
  /** Set when the keep-alive watchdog aborted a silent connection: when the silence began. */
  private quietSince: number | undefined;

  /**
   * @param deps adapter-provided transport, callbacks, log and managed timers
   */
  constructor(private readonly deps: EventStreamDeps) {}

  /** Current epoch-ms (injected clock in tests, Date.now otherwise). */
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The reason the last connect attempt failed, or undefined while the stream is up / never failed. */
  get lastError(): string | undefined {
    return this.lastFailure;
  }

  /** Open the stream and keep it open (reconnecting on drop) until {@link stop}. */
  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.failures = 0;
    this.loggedConnected = false;
    this.connect();
  }

  /** Stop the stream and cancel all pending timers (synchronous, for onUnload). */
  stop(): void {
    this.stopped = true;
    this.abort?.abort();
    this.abort = undefined;
    this.clearKeepAlive();
    this.clearConnectTimer();
    if (this.reconnectTimer) {
      this.deps.clearTimer(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /**
   * Connect right now instead of waiting out a pending backoff — for a fresh
   * token after a re-sign-in at runtime. Without a token every attempt counts
   * as a failure and the backoff grows (measured: 10, 20, 40, 80, 160, 300 s);
   * the token then arrived into a pending 300 s timer, and live updates stayed
   * off for up to five minutes although the stream could have connected at
   * once. Acts ONLY while a reconnect is pending: with a connection in flight
   * a second attempt would open a second event channel (the API caps them).
   */
  reconnectNow(): void {
    if (this.stopped || !this.reconnectTimer) {
      return;
    }
    this.deps.clearTimer(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.connect();
  }

  /** Run one connection attempt, then schedule a reconnect when it ends. */
  private connect(): void {
    if (this.stopped) {
      return;
    }
    void this.streamOnce().then(
      () => this.scheduleReconnect(),
      () => this.scheduleReconnect(),
    );
  }

  /** Wait out the backoff, then connect again. */
  private scheduleReconnect(): void {
    if (this.stopped) {
      return;
    }
    const quietSince = this.quietSince;
    this.quietSince = undefined;
    this.deps.onConnected(false, quietSince);
    // A 429 carries the pause the cloud asks for; retrying sooner counts against
    // the same daily quota (every request counts, refused ones too).
    const delay = Math.max(
      Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.failures),
      this.rateLimitedUntil - this.now(),
    );
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  /** One connection: stream frames to the parser until it closes or errors. */
  private async streamOnce(): Promise<void> {
    const token = this.deps.getAccessToken();
    if (!token) {
      this.failures++;
      return;
    }
    const abort = new AbortController();
    this.abort = abort;
    let connectedAt: number | undefined;
    let timedOut = false;
    // Bound the connect phase: no headers within the window → abort → retry.
    this.connectTimer = this.deps.setTimer(() => {
      this.deps.log("debug", "event stream connect timed out.");
      timedOut = true;
      abort.abort();
    }, CONNECT_TIMEOUT_MS);
    try {
      const res = await fetch(new URL(EVENTS_PATH, this.deps.baseUrl), {
        headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" },
        signal: abort.signal,
      });
      this.clearConnectTimer();
      if (!res.ok) {
        // Reading the (small, capped) body frees the connection too — undici
        // holds on to one whose body is neither read nor cancelled until the
        // garbage collector finds it, once per retry of a failing spell.
        const key = await this.readRefusedKey(res, abort);
        this.noteConnectFailure(refusedReason(res.status, key));
        if (res.status === 429) {
          const pause = retryAfterMs(res.headers.get("retry-after")) ?? RATE_LIMIT_FALLBACK_MS;
          this.rateLimitedUntil = this.now() + pause;
          this.deps.onRateLimited?.(pause);
        }
        if (res.status === 401 && this.deps.onUnauthorized) {
          // A rejected token: refresh it now so the retry can succeed, instead of
          // backing off against a token the server will never accept again.
          await this.deps.onUnauthorized();
        }
        return;
      }
      if (!res.body) {
        this.noteConnectFailure(`HTTP ${res.status}, connected without a body`);
        return;
      }
      connectedAt = this.now();
      this.lastFailure = undefined;
      this.deps.onConnected(true);
      if (this.failureWarned) {
        // The user saw the warning; without this they cannot tell it recovered.
        this.deps.log("info", "Home Connect event stream connected again.");
        this.failureWarned = false;
      } else {
        // First connect of the session gets an info line; reconnects stay on
        // debug so a flapping stream can't spam the log.
        this.deps.log(this.loggedConnected ? "debug" : "info", "Home Connect event stream connected.");
      }
      this.loggedConnected = true;
      await this.pump(res.body);
    } catch (e) {
      this.clearConnectTimer();
      if (!this.stopped) {
        if (connectedAt === undefined) {
          // The watchdog's abort surfaces as "This operation was aborted" — say what happened.
          this.noteConnectFailure(timedOut ? `no answer within ${CONNECT_TIMEOUT_MS / 1000} s` : errMessage(e));
        } else {
          this.deps.log("debug", `event stream ended: ${errMessage(e)}`);
        }
      }
    } finally {
      // A connection that stayed up a while is healthy → reset the backoff. A
      // connect that never came up, or dropped almost immediately (flapping),
      // grows it — so a broken stream backs off instead of reconnecting every 5 s.
      if (connectedAt !== undefined && this.now() - connectedAt >= STABLE_CONNECTION_MS) {
        this.failures = 0;
      } else {
        this.failures++;
      }
      this.clearKeepAlive();
      this.clearConnectTimer();
      this.abort = undefined;
    }
  }

  /**
   * Report a failed connect attempt: the first of a failing spell warns (the
   * user should know live updates are paused), repeats stay on debug, and the
   * next successful connect announces the recovery.
   *
   * @param reason what went wrong ({@link refusedReason}, a transport error)
   */
  private noteConnectFailure(reason: string): void {
    this.lastFailure = reason;
    const level = this.failureWarned ? "debug" : "warn";
    this.deps.log(level, `event stream connect failed: ${reason} — live updates are paused until it reconnects.`);
    this.failureWarned = true;
  }

  /**
   * The error key of a refused connect, read within {@link REFUSED_BODY_TIMEOUT_MS}
   * (a body that never ends is aborted), and the body released either way.
   *
   * @param res the refused response
   * @param abort the attempt's abort controller (aborting it ends the body read)
   * @returns the BSH error key, if one arrived in time
   */
  private readRefusedKey(res: Response, abort: AbortController): Promise<string | undefined> {
    return new Promise<string | undefined>(resolve => {
      let settled = false;
      const timer = this.deps.setTimer(() => {
        if (!settled) {
          settled = true;
          abort.abort();
          resolve(undefined);
        }
      }, REFUSED_BODY_TIMEOUT_MS);
      void refusedKey(res).then(async key => {
        // A body the reader could not take (no stream API) is still released.
        try {
          await res.body?.cancel();
        } catch {
          // Already read to the end, or locked by the reader — nothing left to free.
        }
        if (!settled) {
          settled = true;
          this.deps.clearTimer(timer);
          resolve(key);
        }
      });
    });
  }

  /** Cancel the connect-phase watchdog. */
  private clearConnectTimer(): void {
    if (this.connectTimer) {
      this.deps.clearTimer(this.connectTimer);
      this.connectTimer = undefined;
    }
  }

  /**
   * Read the response body to completion, decoding + parsing SSE frames and
   * dispatching every non-KEEP-ALIVE event; a stalled stream is aborted by the
   * keep-alive timer.
   *
   * @param body the fetch response body stream
   */
  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const reader = body.getReader();
    this.armKeepAlive();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        return;
      }
      this.armKeepAlive();
      for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
        if (ev.event !== "KEEP-ALIVE") {
          this.deps.onEvent(ev);
        }
      }
    }
  }

  /** (Re)start the keep-alive watchdog — abort the connection if it fires. */
  private armKeepAlive(): void {
    this.clearKeepAlive();
    this.lastTrafficAt = this.now();
    this.keepAliveTimer = this.deps.setTimer(() => {
      this.deps.log("debug", "event stream keep-alive timed out — reconnecting.");
      // The outage began with the silence, not with this abort — the caller measures it from here.
      this.quietSince = this.lastTrafficAt;
      this.abort?.abort();
    }, KEEPALIVE_TIMEOUT_MS);
  }

  /** Cancel the keep-alive watchdog. */
  private clearKeepAlive(): void {
    if (this.keepAliveTimer) {
      this.deps.clearTimer(this.keepAliveTimer);
      this.keepAliveTimer = undefined;
    }
  }
}
