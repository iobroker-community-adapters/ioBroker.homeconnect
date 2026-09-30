import { describe, it, expect, vi, afterEach } from "vitest";
import { EventStream, type EventStreamDeps } from "./event-stream";

afterEach(() => vi.unstubAllGlobals());

/**
 * A managed-timer + clock harness the adapter would otherwise provide.
 *
 * @param overrides Dependencies that replace the harness defaults
 */
function harness(overrides: Partial<EventStreamDeps> = {}): {
  deps: EventStreamDeps;
  timers: Array<{ cb: () => void; ms: number; handle: object }>;
  clock: { t: number };
  connected: boolean[];
  logs: Array<{ level: string; msg: string }>;
  fireReconnect: () => void;
} {
  const timers: Array<{ cb: () => void; ms: number; handle: object }> = [];
  const clock = { t: 0 };
  const connected: boolean[] = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const deps: EventStreamDeps = {
    baseUrl: "https://api.home-connect.com",
    getAccessToken: () => "TOKEN",
    onEvent: () => {},
    onConnected: c => connected.push(c),
    log: (level, msg) => logs.push({ level, msg }),
    setTimer: (cb, ms) => {
      const handle = {};
      timers.push({ cb, ms, handle });
      return handle;
    },
    clearTimer: handle => {
      const i = timers.findIndex(t => t.handle === handle);
      if (i >= 0) {
        timers.splice(i, 1);
      }
    },
    now: () => clock.t,
    ...overrides,
  };
  // After each attempt settles (keep-alive already cleared), the sole remaining timer is the reconnect.
  const fireReconnect = (): void => {
    const t = timers[timers.length - 1];
    if (t) {
      timers.splice(timers.indexOf(t), 1);
      t.cb();
    }
  };
  return { deps, timers, clock, connected, logs, fireReconnect };
}

/** Let the async connect/pump chain settle. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

/**
 * A response body whose single read bumps the clock by `ms` then ends (a connection that lasted `ms`).
 *
 * @param clock Shared fake clock
 * @param clock.t Current fake time in milliseconds
 * @param ms How long the connection is supposed to have lasted
 */
function bodyLasting(clock: { t: number }, ms: number): ReadableStream<Uint8Array> {
  return {
    getReader: () => ({
      read: () => {
        clock.t += ms;
        return Promise.resolve({ done: true, value: undefined });
      },
    }),
  } as unknown as ReadableStream<Uint8Array>;
}

describe("EventStream reconnect/backoff", () => {
  it("does not fetch without a token and backs off", async () => {
    const h = harness({ getAccessToken: () => undefined });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    // one reconnect scheduled: failures == 1 → 5 s × 2^1 = 10 s
    expect(h.timers.at(-1)?.ms).toBe(10_000);
  });

  it("schedules a reconnect and marks disconnected when the connect fails", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(h.connected).toContain(false); // scheduleReconnect reported disconnected
    expect(h.timers.at(-1)?.ms).toBe(10_000); // failures == 1
  });

  it("grows the backoff while the connection keeps flapping (short-lived)", async () => {
    const h = harness();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve({ ok: true, body: bodyLasting(h.clock, 2_000) })),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(h.timers.at(-1)?.ms).toBe(10_000); // 1 short connection → failures 1 → 5000*2^1
    h.fireReconnect();
    await flush();
    expect(h.timers.at(-1)?.ms).toBe(20_000); // failures 2
    h.fireReconnect();
    await flush();
    expect(h.timers.at(-1)?.ms).toBe(40_000); // failures 3
  });

  it("resets the backoff after a stable connection", async () => {
    const h = harness();
    // first a flap to raise failures, then a healthy 70s connection resets it
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve({ ok: true, body: bodyLasting(h.clock, ++calls === 1 ? 2_000 : 70_000) }),
        ),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(h.timers.at(-1)?.ms).toBe(10_000); // flap → failures 1
    h.fireReconnect();
    await flush();
    expect(h.timers.at(-1)?.ms).toBe(5_000); // stable 70s → failures reset → MIN
  });

  it("logs 'connected' at info once, then reconnects stay on debug", async () => {
    const h = harness();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => Promise.resolve({ ok: true, body: bodyLasting(h.clock, 70_000) })),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    h.fireReconnect();
    await flush();
    const connectedLogs = h.logs.filter(l => l.msg.includes("connected"));
    expect(connectedLogs[0]).toMatchObject({ level: "info" });
    expect(connectedLogs[1]).toMatchObject({ level: "debug" });
  });

  it("stop() cancels the pending reconnect and does not reconnect", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(h.timers.length).toBe(1);
    es.stop();
    expect(h.timers.length).toBe(0);
  });

  it("aborts the connection when the keep-alive watchdog fires", async () => {
    const h = harness();
    // a body whose read never resolves — the connection stays 'up' until aborted
    const body = { getReader: () => ({ read: () => new Promise(() => {}) }) } as unknown as ReadableStream<Uint8Array>;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body });
    vi.stubGlobal("fetch", fetchMock);
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    // while connected: the keep-alive timer is armed (it is the only pending timer)
    const keepAlive = h.timers.at(-1);
    expect(keepAlive?.ms).toBe(130_000);
    keepAlive?.cb(); // fire the watchdog
    const signal = (fetchMock.mock.calls[0][1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
    es.stop();
  });
});

describe("EventStream lifecycle guards", () => {
  it("a second start does not open a second connection", async () => {
    const h = harness();
    const body = { getReader: () => ({ read: () => new Promise(() => {}) }) } as unknown as ReadableStream<Uint8Array>;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body });
    vi.stubGlobal("fetch", fetchMock);
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    es.start();
    await flush();
    // Two live streams double every event the adapter sees, and only one of them
    // is reachable by stop() — the other keeps running until the process ends.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    es.stop();
  });

  it("does not reconnect after stop, even when the attempt was already in flight", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }));
    const es = new EventStream(h.deps);
    es.start();
    es.stop();
    await flush();
    // onUnload is synchronous: the in-flight attempt settles afterwards and must
    // not schedule anything, or js-controller kills the adapter over a live timer.
    expect(h.timers.length).toBe(0);
  });

  it("does not connect again from a reconnect timer that fires after stop", async () => {
    const h = harness();
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, body: null });
    vi.stubGlobal("fetch", fetchMock);
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    const pending = h.timers.at(-1);
    es.stop();
    fetchMock.mockClear();
    pending?.cb();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats an error response as a failed connect, not an open stream", async () => {
    const h = harness();
    // A 401/429 answer still carries a body. Reading it as a stream would report
    // "connected" and then park on a body that never delivers an event.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { key: "429.Rate.Limit" } }), { status: 429 })),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(h.connected).not.toContain(true);
    expect(
      h.logs.some(l => l.msg.includes("connect failed: HTTP 429 (429.Rate.Limit), the Home Connect rate limit")),
    ).toBe(true);
    // No Retry-After: the 60 s fallback pause beats the 10 s backoff.
    expect(h.timers.at(-1)?.ms).toBe(60_000);
  });

  it("does not hand a KEEP-ALIVE frame to the adapter", async () => {
    const h = harness();
    const events: string[] = [];
    const deps = { ...h.deps, onEvent: (ev: { event: string }) => events.push(ev.event) };
    const frames = ["event: KEEP-ALIVE\ndata: \n\n", 'event: STATUS\ndata: {"haId":"HA-1"}\n\n'];
    let i = 0;
    const body = {
      getReader: () => ({
        read: () =>
          Promise.resolve(
            i < frames.length
              ? { done: false, value: new TextEncoder().encode(frames[i++]) }
              : { done: true, value: undefined },
          ),
      }),
    } as unknown as ReadableStream<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }));
    const es = new EventStream(deps);
    es.start();
    await flush();
    // A keep-alive carries no haId — routing it would take the "no haId" exit on
    // every heartbeat, and every heartbeat (about every 55 s) would look like device traffic.
    expect(events).toEqual(["STATUS"]);
    es.stop();
  });
});

describe("EventStream remaining paths", () => {
  it("uses the real clock when none is injected", async () => {
    const h = harness();
    const deps = { ...h.deps };
    delete (deps as { now?: unknown }).now;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, body: null }));
    const es = new EventStream(deps);
    es.start();
    await flush();
    // Production injects no clock; the backoff must work with the real one.
    expect(h.timers.at(-1)?.ms).toBe(10_000);
    es.stop();
  });

  it("logs a stream that dies mid-read and reconnects", async () => {
    const h = harness();
    const body = {
      getReader: () => ({
        read: () => Promise.reject(new Error("socket reset")),
      }),
    } as unknown as ReadableStream<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(h.logs.some(l => l.msg.includes("event stream ended: socket reset"))).toBe(true);
    expect(h.timers.at(-1)?.ms).toBe(10_000);
    es.stop();
  });

  it("says nothing about a stream that ended because we stopped it", async () => {
    const h = harness();
    let reject: (e: Error) => void = () => {};
    const body = {
      getReader: () => ({ read: () => new Promise((_r, rj) => (reject = rj)) }),
    } as unknown as ReadableStream<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, body }));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    h.logs.length = 0;
    es.stop();
    reject(new Error("The operation was aborted"));
    await flush();
    // Our own abort is not an incident — logging it makes every unload look like
    // a failure in the user's log.
    expect(h.logs.filter(l => l.msg.includes("event stream ended"))).toEqual([]);
  });
});

describe("EventStream connect watchdog + failure reporting", () => {
  it("aborts a connect that never answers, and retries", async () => {
    const h = harness();
    // fetch that only settles when its signal is aborted (TCP up, no headers).
    const fetchMock = vi.fn().mockImplementation(
      (_url: unknown, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    // The keep-alive watchdog only exists once the body streams; this timer is
    // what ends a hung connect — without it the live path is dead until restart.
    const watchdog = h.timers.find(t => t.ms === 30_000);
    expect(watchdog).toBeDefined();
    watchdog?.cb();
    await flush();
    expect((fetchMock.mock.calls[0][1] as { signal: AbortSignal }).signal.aborted).toBe(true);
    // …and a reconnect is scheduled like after any other failed attempt.
    expect(h.timers.at(-1)?.ms).toBe(10_000);
    es.stop();
  });

  it("warns once about a failing spell, repeats on debug, and announces the recovery", async () => {
    const h = harness();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            ++calls <= 2 ? { ok: false, status: 503, body: null } : { ok: true, body: bodyLasting(h.clock, 70_000) },
          ),
        ),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    h.fireReconnect();
    await flush();
    const failures = h.logs.filter(l => l.msg.includes("connect failed"));
    // The user must learn that live updates are paused — but not once per retry.
    expect(failures.map(l => l.level)).toEqual(["warn", "debug"]);

    h.fireReconnect();
    await flush();
    expect(h.logs.some(l => l.level === "info" && l.msg.includes("connected again"))).toBe(true);
    es.stop();
  });

  it("asks for a token refresh when the stream endpoint answers 401", async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve(true));
    const h = harness({ onUnauthorized });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, body: null }));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    // Otherwise only the periodic refresh near expiry would replace it, up to a day
    // later: REST only refreshes on its own 401s, and without events there are no REST calls.
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    es.stop();
  });

  it("does not treat a 503 as an auth problem", async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve(true));
    const h = harness({ onUnauthorized });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, body: null }));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(onUnauthorized).not.toHaveBeenCalled();
    es.stop();
  });

  it("frees the body of a refused connect instead of leaving it to the garbage collector", async () => {
    // undici keeps a connection whose body is neither read nor cancelled — and a
    // failing spell retries every few minutes.
    const h = harness();
    const cancel = vi.fn(() => Promise.resolve());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, body: { cancel } }));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    es.stop();
  });

  it("names the likely cause of a refused connect in the warning", async () => {
    // Measured live 2026-09-23: 503, 504 and 404 in one morning, each warned as a
    // bare "status 503" — the user could not tell a cloud outage from a local fault.
    const cases: Array<[number, string]> = [
      [503, "HTTP 503, a problem on the Home Connect side"],
      [504, "HTTP 504, a problem on the Home Connect side"],
      [404, "HTTP 404, a problem on the Home Connect side"],
      [401, "HTTP 401, the login was rejected"],
      [403, "HTTP 403, the login was rejected"],
      [429, "HTTP 429, the Home Connect rate limit"],
      [400, "HTTP 400"],
    ];
    for (const [status, reason] of cases) {
      const h = harness({ onUnauthorized: () => Promise.resolve(false) });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status, body: null }));
      const es = new EventStream(h.deps);
      es.start();
      await flush();
      expect(h.logs.find(l => l.level === "warn")?.msg).toBe(
        `event stream connect failed: ${reason} — live updates are paused until it reconnects.`,
      );
      es.stop();
    }
  });

  it("clears the connect watchdog on stop", async () => {
    const h = harness();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(h.timers.some(t => t.ms === 30_000)).toBe(true);
    es.stop();
    // A live timer after unload is what makes js-controller kill the adapter.
    expect(h.timers).toHaveLength(0);
  });
});

describe("EventStream last error (for the connection test)", () => {
  it("remembers why the last connect failed and forgets it once connected", async () => {
    const h = harness();
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(
            ++calls === 1 ? { ok: false, status: 503, body: null } : { ok: true, body: bodyLasting(h.clock, 70_000) },
          ),
        ),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    // The settings panel's test shows this reason — it must be the real one.
    expect(es.lastError).toBe("HTTP 503, a problem on the Home Connect side");
    h.fireReconnect();
    await flush();
    expect(es.lastError).toBeUndefined();
    es.stop();
  });
});

describe("EventStream.reconnectNow (2026-09-15, §7.1)", () => {
  it("cuts a pending backoff short — the token the stream was waiting for is back", async () => {
    let token: string | undefined = undefined;
    const h = harness({ getAccessToken: () => token });
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve({ ok: true, body: bodyLasting(h.clock, 120_000) }));
    vi.stubGlobal("fetch", fetchMock);
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    h.fireReconnect();
    await flush();
    h.fireReconnect();
    await flush();
    // Three attempts without a token: 10, 20, 40 s — a 40 s timer is pending.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.timers.at(-1)?.ms).toBe(40_000);
    // Measured before the fix: the fresh token arrived into a pending 300 s
    // timer and live updates stayed off for up to five minutes.
    token = "AT";
    es.reconnectNow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(h.timers.filter(t => t.ms === 40_000)).toEqual([]);
    es.stop();
  });

  it("does nothing while a connection is up or in flight, and nothing after stop()", async () => {
    const h = harness();
    // A body that stays open: the connection is up, no reconnect is pending.
    const open = {
      getReader: () => ({ read: () => new Promise(() => undefined) }),
    } as unknown as ReadableStream<Uint8Array>;
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve({ ok: true, body: open }));
    vi.stubGlobal("fetch", fetchMock);
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Connected: a second attempt would open a second event channel (the API caps them).
    es.reconnectNow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    es.stop();
    es.reconnectNow();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("EventStream findings of the 2026-09-24 audit", () => {
  it("F17: honours Retry-After on a 429 and hands the pause to REST", async () => {
    const onRateLimited = vi.fn();
    const h = harness({ onRateLimited });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 429, headers: { "retry-after": "120" } })),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    // Before: the plain backoff (10 s), every retry counting against the same quota.
    expect(h.timers.at(-1)?.ms).toBe(120_000);
    expect(onRateLimited).toHaveBeenCalledWith(120_000);
    es.stop();
  });

  it("A8: names the BSH error key of a refused connect", async () => {
    const h = harness();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ error: { key: "insufficient_scope" } }), { status: 403 })),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(es.lastError).toBe("HTTP 403 (insufficient_scope), the login was rejected");
    es.stop();
  });

  it("A9: a 401 releases the body and asks for a fresh token", async () => {
    const onUnauthorized = vi.fn(() => Promise.resolve(true));
    const h = harness({ onUnauthorized });
    const res = new Response("{}", { status: 401 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(res));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(res.bodyUsed).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    es.stop();
  });

  it("A8/A9: an answer without a body is reported as such, not as 'HTTP 200'", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, body: null }));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    expect(es.lastError).toBe("HTTP 200, connected without a body");
    es.stop();
  });

  it("a refused body that never ends is abandoned after 5 s", async () => {
    const h = harness();
    const stuck = new ReadableStream<Uint8Array>({ start() {} });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stuck, { status: 503 })));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    const guard = h.timers.find(t => t.ms === 5_000);
    expect(guard).toBeDefined();
    guard?.cb();
    await flush();
    expect(es.lastError).toBe("HTTP 503, a problem on the Home Connect side");
    expect(h.timers.at(-1)?.ms).toBe(10_000); // the reconnect is scheduled
    es.stop();
  });

  it("F27: a connect that times out says so instead of 'This operation was aborted'", async () => {
    const h = harness();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: unknown, init: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("This operation was aborted", "AbortError")),
            );
          }),
      ),
    );
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    h.timers.find(t => t.ms === 30_000)?.cb();
    await flush();
    expect(es.lastError).toBe("no answer within 30 s");
    es.stop();
  });

  it("E4: once connected, no connect watchdog is left armed", async () => {
    const h = harness();
    const pending = new ReadableStream<Uint8Array>({ start() {} });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(pending, { status: 200 })));
    const es = new EventStream(h.deps);
    es.start();
    await flush();
    // A left-over 30 s watchdog would abort every healthy stream after 30 s.
    expect(h.timers.map(t => t.ms)).toEqual([130_000]);
    es.stop();
  });
});
