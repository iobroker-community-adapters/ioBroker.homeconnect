import { join } from "node:path";
import { vi } from "vitest";

/**
 * Orchestration tests for the adapter lifecycle. `@iobroker/adapter-core` is
 * stubbed with a minimal Adapter base class carrying in-memory object/state
 * stores and a REVERSIBLE encrypt/decrypt (base64) — a pass-through would make
 * the stored token's two formats indistinguishable and hide the migration path.
 * The HTTP layer is mocked; the three collaborators are replaced through the
 * factory seams in main.ts. Nothing here touches the network.
 */
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { silly: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "homeconnect.0";
    public adapterDir = "/opt/iobroker/node_modules/iobroker.homeconnect";
    public language: string | undefined = undefined;
    public config: Record<string, unknown> = {};
    public objects = new Map<string, Record<string, unknown>>();
    public states = new Map<string, { val: unknown; ack: boolean }>();
    /**
     * Every state write that ACTUALLY landed, in order. `setStateChangedAsync`
     * writes only on a real change, so this is what tells an unconditional write
     * apart from a guarded one.
     */
    public writeLog: Array<{ id: string; val: unknown }> = [];
    public subscribed: string[] = [];
    public on = vi.fn();
    public registerNotification = vi.fn(() => Promise.resolve(undefined));
    public sendTo = vi.fn();
    /** Reversible on purpose: the encrypted and the legacy cleartext form must stay distinguishable. */
    public encrypt = vi.fn((s: string) => `enc:${Buffer.from(s, "utf8").toString("base64")}`);
    public decrypt = vi.fn((s: string) => {
      if (!s.startsWith("enc:")) {
        throw new Error("not encrypted with this instance's secret");
      }
      return Buffer.from(s.slice(4), "base64").toString("utf8");
    });
    private key(id: string): string {
      return id.replace(`${this.namespace}.`, "");
    }
    public setState = vi.fn((id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      this.states.set(this.key(id), { val: s?.val, ack: s?.ack === true });
      this.writeLog.push({ id: this.key(id), val: s?.val });
      return Promise.resolve();
    });
    /**
     * js-controller writes only when the value actually differs
     * (`_setStateChangedHelper` reads the state first and compares). A fake that
     * always delegates to `setState` cannot tell the two calls apart — and then
     * no orchestration test notices when a marker write turns into an
     * unconditional one (history churn plus a change event on every tick). Same
     * correction the appliance-sync fake got on 2026-09-07 (finding A22).
     */
    public setStateChangedAsync = vi.fn(async (id: string, state: unknown) => {
      const s = state as { val?: unknown; ack?: boolean };
      const current = this.states.get(this.key(id));
      if (current !== undefined && current.val === s?.val && current.ack === (s?.ack === true)) {
        return Promise.resolve();
      }
      return this.setState(id, state);
    });
    // Reads answer with a copy, like the controller: with the stored object itself, a
    // change the code makes on what it read lands in the store without any write.
    public getStateAsync = vi.fn((id: string) => {
      const state = this.states.get(this.key(id));
      return Promise.resolve(state ? structuredClone(state) : null);
    });
    public getObjectAsync = vi.fn((id: string) => {
      const obj = this.objects.get(this.key(id));
      return Promise.resolve(obj ? structuredClone(obj) : null);
    });
    public setObjectNotExistsAsync = vi.fn((id: string, obj: Record<string, unknown>) => {
      if (!this.objects.has(this.key(id))) {
        this.objects.set(this.key(id), obj);
      }
      return Promise.resolve();
    });
    public extendObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      this.objects.set(this.key(id), { ...(this.objects.get(this.key(id)) ?? {}), ...obj });
      return Promise.resolve();
    });
    /** All own states in one call, like the controller's `getStatesAsync("*")` (by full id). */
    public getStatesAsync = vi.fn(() =>
      Promise.resolve(Object.fromEntries([...this.states].map(([k, v]) => [`${this.namespace}.${k}`, { ...v, q: 0 }]))),
    );
    /** One list call over the namespace, like the controller's `getObjectList` (rows by full id). */
    public getObjectListAsync = vi.fn(() =>
      Promise.resolve({
        rows: [...this.objects].map(([k, v]) => ({ id: `${this.namespace}.${k}`, value: structuredClone(v) })),
      }),
    );
    public getAdapterObjectsAsync = vi.fn(() => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of this.objects) {
        out[`${this.namespace}.${k}`] = structuredClone(v);
      }
      return Promise.resolve(out);
    });
    /** Objects outside the namespace (rooms/functions, aliases), by full id. */
    public foreign = new Map<string, Record<string, unknown>>();
    public getForeignObjectsAsync = vi.fn((pattern: string) => {
      const prefix = pattern.replace(/\*$/, "");
      if (prefix.startsWith(`${this.namespace}.`)) {
        return Promise.resolve({});
      }
      return Promise.resolve(
        structuredClone(Object.fromEntries([...this.foreign].filter(([id]) => id.startsWith(prefix)))),
      );
    });
    public getForeignObjectAsync = vi.fn((id: string) =>
      Promise.resolve(this.foreign.has(id) ? structuredClone(this.foreign.get(id)) : null),
    );
    public setForeignObject = vi.fn((id: string, obj: Record<string, unknown>) => {
      if (id.startsWith(`${this.namespace}.`)) {
        this.objects.set(this.key(id), structuredClone(obj));
      } else {
        this.foreign.set(id, structuredClone(obj));
      }
      return Promise.resolve();
    });
    public extendForeignObjectAsync = vi.fn((id: string, obj: Record<string, unknown>) => this.extendObject(id, obj));
    public getForeignStatesAsync = vi.fn(() => Promise.resolve({}));
    public setForeignStateAsync = vi.fn((id: string, state: unknown) => this.setState(id, state));
    public delObjectAsync = vi.fn((id: string, opts?: { recursive?: boolean }) => {
      const key = this.key(id);
      for (const k of [...this.objects.keys()]) {
        if (k === key || (opts?.recursive && k.startsWith(`${key}.`))) {
          this.objects.delete(k);
        }
      }
      return Promise.resolve();
    });
    public subscribeStatesAsync = vi.fn((pattern: string) => {
      this.subscribed.push(pattern);
      return Promise.resolve();
    });
    public setInterval = vi.fn(() => ({ kind: "interval" }));
    public clearInterval = vi.fn();
    // Real (short) timers behind the spies: the REST transport spaces requests
    // through `this.delay`, so a stub that never resolves would hang every
    // second call. Long timers (re-read cooldowns) are driven by hand below.
    public setTimeout = vi.fn((cb: () => void, ms: number) => globalThis.setTimeout(cb, ms));
    public clearTimeout = vi.fn((handle: unknown) => globalThis.clearTimeout(handle as NodeJS.Timeout));
    public delay = vi.fn((ms: number) => new Promise<void>(resolve => globalThis.setTimeout(resolve, ms)));
    constructor(_opts: unknown) {}
  }
  const I18n = {
    init: vi.fn(() => Promise.resolve()),
    getTranslatedObject: vi.fn((key: string) => ({ en: key })),
    translate: vi.fn((key: string) => key),
  };
  return { Adapter, I18n };
});

const httpMock = vi.hoisted(() => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
  deleteJson: vi.fn(),
  postForm: vi.fn(),
}));
vi.mock("./lib/http", () => httpMock);

import { Homeconnect } from "./main";
import type { JsonResult } from "./lib/http";
import type { WriteRequest } from "./lib/command-dispatch";

const okResult = (data: unknown = { fine: true }): JsonResult => ({
  status: 200,
  ok: true,
  data,
  error: undefined,
});
const failResult = (status: number, extra: Partial<JsonResult> = {}): JsonResult => ({
  status,
  ok: false,
  data: undefined,
  error: `status ${status}`,
  ...extra,
});

/** A client id in the portal's form — 64 hexadecimal characters. */
const CLIENT_ID = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

interface FakeSync {
  sortOutLegacyTrees: ReturnType<typeof vi.fn>;
  migrateDeviceIds: ReturnType<typeof vi.fn>;
  migrateRenamedStates: ReturnType<typeof vi.fn>;
  migrateHistoryRuns: ReturnType<typeof vi.fn>;
  primeFromObjects: ReturnType<typeof vi.fn>;
  syncAppliances: ReturnType<typeof vi.fn>;
  markAllUnreachable: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  handleStreamEvent: ReturnType<typeof vi.fn>;
  handleWrite: ReturnType<typeof vi.fn>;
  noteUnsupportedProgram: ReturnType<typeof vi.fn>;
  noteNotReady: ReturnType<typeof vi.fn>;
  noteRefused: ReturnType<typeof vi.fn>;
  port: Record<string, (...a: never[]) => unknown>;
}
interface FakeAuthCtl {
  start: ReturnType<typeof vi.fn>;
  requestSignIn: ReturnType<typeof vi.fn>;
  resetLogin: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  refreshNow: ReturnType<typeof vi.fn>;
  persistPendingToken: ReturnType<typeof vi.fn>;
  settle: ReturnType<typeof vi.fn>;
  accessToken: string | undefined;
  port: Record<string, (...a: never[]) => unknown>;
}
interface FakeStream {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  reconnectNow: ReturnType<typeof vi.fn>;
  lastError?: string;
  deps: Record<string, (...a: never[]) => unknown>;
}

/**
 * Typed access to the private members the orchestration tests drive.
 *
 * @param adapter Adapter instance under test
 */
function internalOf(adapter: Homeconnect): {
  onReady(): Promise<void>;
  onUnload(cb: () => void): void;
  onStateChange(id: string, state: unknown): void;
  apiGet(path: string): Promise<unknown>;
  apiWrite(req: WriteRequest): Promise<JsonResult | undefined>;
  acceptLanguage(): string | undefined;
  notifyUser(msg: string): void;
  onMessage(obj: unknown): Promise<void>;
  checkConnection(): Promise<{ result: string } | { error: string }>;
  streamUp: boolean;
  sendTo: ReturnType<typeof vi.fn>;
  authCtl: FakeAuthCtl | undefined;
  eventStream: FakeStream | undefined;
  sync: FakeSync | undefined;
  restBlockedUntil: number;
  objects: Map<string, Record<string, unknown>>;
  foreign: Map<string, Record<string, unknown>>;
  states: Map<string, { val: unknown; ack: boolean }>;
  writeLog: Array<{ id: string; val: unknown }>;
  config: Record<string, unknown>;
  language: string | undefined;
  log: Record<"debug" | "info" | "warn" | "error", ReturnType<typeof vi.fn>>;
  subscribed: string[];
  registerNotification: ReturnType<typeof vi.fn>;
  encrypt(s: string): string;
  makeSync: unknown;
  makeAuthController: unknown;
  makeEventStream: unknown;
  setTimeout: ReturnType<typeof vi.fn>;
  clearTimeout: ReturnType<typeof vi.fn>;
  resyncTimer: unknown;
  subscribeStatesAsync: ReturnType<typeof vi.fn>;
  extendObject: ReturnType<typeof vi.fn>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn>;
  delObjectAsync: ReturnType<typeof vi.fn>;
  getObjectListAsync: ReturnType<typeof vi.fn>;
  getStatesAsync: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  setStateChangedAsync: ReturnType<typeof vi.fn>;
  readOwnObjects(): Promise<void>;
  refreshManifestObjects(): Promise<void>;
} {
  return adapter as never;
}

interface Ctx {
  i: ReturnType<typeof internalOf>;
  syncs: FakeSync[];
  auths: FakeAuthCtl[];
  streams: FakeStream[];
}

/**
 * Build an adapter with fake collaborators and a config.
 *
 * @param config native config fields for this run
 */
function setup(config: Record<string, unknown> = {}): Ctx {
  const i = internalOf(new Homeconnect());
  i.config = { clientID: CLIENT_ID, clientSecret: "sec", ...config };
  const syncs: FakeSync[] = [];
  const auths: FakeAuthCtl[] = [];
  const streams: FakeStream[] = [];

  i.makeSync = (port: Record<string, (...a: never[]) => unknown>) => {
    const s: FakeSync = {
      port,
      sortOutLegacyTrees: vi.fn(() => Promise.resolve(undefined)),
      migrateDeviceIds: vi.fn(() => Promise.resolve(undefined)),
      migrateRenamedStates: vi.fn(() => Promise.resolve(undefined)),
      migrateHistoryRuns: vi.fn(() => Promise.resolve(undefined)),
      primeFromObjects: vi.fn(() => Promise.resolve(undefined)),
      // Resolves TRUE: syncAppliances reports whether it reached the cloud, and
      // the outage catch-up only stamps its cooldown on a sync that did.
      syncAppliances: vi.fn(() => Promise.resolve(true)),
      markAllUnreachable: vi.fn(() => Promise.resolve(undefined)),
      stop: vi.fn(),
      handleStreamEvent: vi.fn(),
      handleWrite: vi.fn(() => Promise.resolve(undefined)),
      noteUnsupportedProgram: vi.fn(),
      noteNotReady: vi.fn(),
      noteRefused: vi.fn(),
    };
    syncs.push(s);
    return s;
  };
  i.makeAuthController = (_auth: unknown, port: Record<string, (...a: never[]) => unknown>) => {
    const a: FakeAuthCtl = {
      port,
      accessToken: "AT",
      start: vi.fn(() => Promise.resolve(undefined)),
      requestSignIn: vi.fn(() => Promise.resolve("A new sign-in link was requested.")),
      resetLogin: vi.fn(() => Promise.resolve("A new sign-in link was requested.")),
      stop: vi.fn(),
      refreshNow: vi.fn(() => Promise.resolve(false)),
      persistPendingToken: vi.fn(() => Promise.resolve(undefined)),
      settle: vi.fn(() => Promise.resolve(undefined)),
    };
    auths.push(a);
    return a;
  };
  i.makeEventStream = (deps: Record<string, (...a: never[]) => unknown>) => {
    const s: FakeStream = { deps, start: vi.fn(), stop: vi.fn(), reconnectNow: vi.fn() };
    streams.push(s);
    return s;
  };
  return { i, syncs, auths, streams };
}

/**
 * Configure the fake sync the moment onReady creates it — its local start-up
 * steps run inside onReady, before a test could reach the instance otherwise.
 *
 * @param ctx the test context
 * @param configure applied to the new fake sync
 */
function withSync(ctx: Ctx, configure: (s: FakeSync) => void): void {
  const make = ctx.i.makeSync as (port: Record<string, (...a: never[]) => unknown>) => FakeSync;
  ctx.i.makeSync = (port: Record<string, (...a: never[]) => unknown>) => {
    const s = make(port);
    configure(s);
    return s;
  };
}

/** Let a chain of fire-and-forget state writes settle (publishConnection writes two states). */
const settle = (): Promise<void> => new Promise(resolve => globalThis.setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  httpMock.getJson.mockResolvedValue(okResult());
  httpMock.putJson.mockResolvedValue(okResult());
  httpMock.deleteJson.mockResolvedValue(okResult());
  httpMock.postForm.mockResolvedValue({ status: 200, ok: true, body: {} });
});

describe("Homeconnect onReady", () => {
  it("starts the sign-in and reports itself disconnected until it succeeds", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // A green instance before the token exists tells the user everything is fine
    // while nothing works.
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    expect(ctx.auths[0].start).toHaveBeenCalledTimes(1);
  });

  it("stops with a hint and starts no sign-in without a client id — but greys out the markers", async () => {
    for (const config of [{ clientID: "" }, { clientID: "  \n" }, { clientID: undefined }]) {
      const ctx = setup(config);
      // A crashed signed-in run left both markers green.
      ctx.i.states.set("auth.signedIn", { val: true, ack: true });
      await ctx.i.onReady();
      expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("No Home Connect Client ID configured"));
      // Running the device flow against an empty client id produces a stream of
      // rejected requests and a sign-in link that can never work.
      expect(ctx.auths).toHaveLength(0);
      // The local steps still run: nothing else would ever turn a stale green
      // marker grey in an instance that cannot sign in.
      expect(ctx.i.states.get("auth.signedIn")).toEqual({ val: false, ack: true });
      expect(ctx.syncs[0].markAllUnreachable).toHaveBeenCalledTimes(1);
      expect(ctx.syncs[0].syncAppliances).not.toHaveBeenCalled();
    }
  });

  it("removes the settings an earlier version left behind once, and stops the start for the restart", async () => {
    const ctx = setup();
    // An instance first set up by the previous adapter generation still carries its keys.
    ctx.i.foreign.set("system.adapter.homeconnect.0", {
      common: { nogit: true, supportCustoms: true, enabled: true },
      native: { clientID: CLIENT_ID, username: "me@example.com", password: "secret" },
    });
    await ctx.i.onReady();
    const a = ctx.i as unknown as { extendForeignObjectAsync: ReturnType<typeof vi.fn> };
    // `nogit` stays: since 2.0 the adapter is installed from npm, and the flag keeps the GitHub install away.
    expect(a.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.homeconnect.0", {
      native: { password: null, username: null },
      common: { supportCustoms: null },
    });
    // The write restarts the instance: nothing of this run may start after it.
    expect(ctx.syncs).toHaveLength(0);
    expect(ctx.auths).toHaveLength(0);
  });

  it("starts normally when no obsolete setting is left", async () => {
    const ctx = setup();
    ctx.i.foreign.set("system.adapter.homeconnect.0", {
      common: { enabled: true },
      native: { clientID: CLIENT_ID, clientSecret: "" },
    });
    await ctx.i.onReady();
    const a = ctx.i as unknown as { extendForeignObjectAsync: ReturnType<typeof vi.fn> };
    expect(a.extendForeignObjectAsync).not.toHaveBeenCalledWith("system.adapter.homeconnect.0", expect.anything());
    expect(ctx.auths[0].start).toHaveBeenCalledTimes(1);
  });

  it("sorts out the previous generation's trees first, before any tree moves", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const sync = ctx.syncs[0];
    expect(sync.sortOutLegacyTrees).toHaveBeenCalledTimes(1);
    expect(sync.sortOutLegacyTrees.mock.invocationCallOrder[0]).toBeLessThan(
      sync.migrateDeviceIds.mock.invocationCallOrder[0],
    );
  });

  it("starts no later step when sorting out the legacy trees throws", async () => {
    const ctx = setup();
    withSync(ctx, s => s.sortOutLegacyTrees.mockRejectedValue(new Error("objects db down")));
    await ctx.i.onReady();
    expect(ctx.i.log.error).toHaveBeenCalledWith("Start-up failed at the legacy cleanup: objects db down");
    expect(ctx.syncs[0].migrateDeviceIds).not.toHaveBeenCalled();
    expect(ctx.auths).toHaveLength(0);
  });

  it("signs in without a client secret — the device flow needs none", async () => {
    const ctx = setup({ clientSecret: "" });
    await ctx.i.onReady();
    expect(ctx.auths).toHaveLength(1);
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
  });

  it("trims the client id and warns — without stopping — when it does not look like one", async () => {
    const ctx = setup({ clientID: `  ${CLIENT_ID}\n` });
    await ctx.i.onReady();
    expect(ctx.i.log.warn).not.toHaveBeenCalled();

    const odd = setup({ clientID: "my-app" });
    await odd.i.onReady();
    expect(odd.i.log.warn).toHaveBeenCalledWith(
      "The Client ID does not look like one of Home Connect (64 hexadecimal characters, this one has 6 characters) — copy it again from the developer portal.",
    );
    // Home Connect decides — the sign-in still starts and says so if the id is unknown.
    expect(odd.auths).toHaveLength(1);
  });

  it("says nothing is known yet about a sign-in problem at start", async () => {
    const ctx = setup();
    ctx.i.states.set("auth.lastError", { val: "unauthorized_client: Invalid client id", ack: true });
    await ctx.i.onReady();
    expect(ctx.i.states.get("auth.lastError")).toEqual({ val: "Unknown", ack: true });
    await (ctx.auths[0].port.setProblem as (text: string) => Promise<void>)(
      "invalid_client: client secret validation failed",
    );
    expect(ctx.i.states.get("auth.lastError")).toEqual({
      val: "invalid_client: client secret validation failed",
      ack: true,
    });
  });

  it("forgets the stored login when the controller asks", async () => {
    const ctx = setup();
    ctx.i.states.set("auth.session", { val: "enc:abc", ack: true });
    await ctx.i.onReady();
    await (ctx.auths[0].port.clearStoredLogin as () => Promise<void>)();
    expect(ctx.i.states.get("auth.session")).toEqual({ val: "", ack: true });
  });

  it("reports a failing start-up instead of dying on an unhandled rejection", async () => {
    const ctx = setup();
    (ctx.i as unknown as { setStateChangedAsync: ReturnType<typeof vi.fn> }).setStateChangedAsync.mockRejectedValueOnce(
      new Error("states db down"),
    );
    await expect(ctx.i.onReady()).resolves.toBeUndefined();
    expect(ctx.i.log.error).toHaveBeenCalledWith(expect.stringContaining("onReady failed: states db down"));
  });
});

describe("Homeconnect stored login", () => {
  it("stores the token encrypted, never as readable JSON", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.saveToken({ accessToken: "AT", refreshToken: "RT", accessExpires: 1, scope: "" } as never);

    const stored = ctx.i.states.get("auth.session")?.val as string;
    // The refresh token is a long-lived credential to the user's appliances. In
    // cleartext it is readable by anything that can read the object DB.
    expect(stored).not.toContain("RT");
    expect(() => JSON.parse(stored)).toThrow();
    expect(stored).toBe(ctx.i.encrypt('{"accessToken":"AT","refreshToken":"RT","accessExpires":1,"scope":""}'));
  });

  it("reads back its own encrypted token", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.states.set("auth.session", {
      val: ctx.i.encrypt(JSON.stringify({ accessToken: "AT", refreshToken: "SECRET" })),
      ack: true,
    });
    await expect(ctx.auths[0].port.loadRefreshToken()).resolves.toBe("SECRET");
  });

  it("keeps the previous adapter's cleartext login across the update", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // The old generation stored plain JSON. Without this path every existing user
    // has to run the device flow again after updating.
    ctx.i.states.set("auth.session", { val: JSON.stringify({ refresh_token: "LEGACY" }), ack: true });
    await expect(ctx.auths[0].port.loadRefreshToken()).resolves.toBe("LEGACY");
  });

  it("reports no login for an empty, missing or undecryptable session", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const load = ctx.auths[0].port.loadRefreshToken as () => Promise<string | undefined>;

    await expect(load()).resolves.toBeUndefined();
    ctx.i.states.set("auth.session", { val: "", ack: true });
    await expect(load()).resolves.toBeUndefined();
    // A session written by a different instance secret: decrypt throws, and an
    // escaping throw here would abort onReady before the device flow could run.
    ctx.i.states.set("auth.session", { val: "gAAAAA-not-ours", ack: true });
    await expect(load()).resolves.toBeUndefined();
    // Unreadable is not absent: the user learns why a sign-in is asked for again.
    expect(ctx.i.log.warn).toHaveBeenCalledWith(
      "The stored Home Connect login cannot be read on this system (it was saved by another ioBroker installation) — a new sign-in is required.",
    );
    ctx.i.states.set("auth.session", { val: 42, ack: true });
    await expect(load()).resolves.toBeUndefined();
  });
});

describe("Homeconnect sign-in wiring", () => {
  it("runs migrations and priming at start, then syncs, subscribes and opens the stream once signed in", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();

    // Device trees move to the current id rule first, then renamed states
    // WITHIN a device — both BEFORE priming (the maps must only ever see current
    // ids), and priming BEFORE the REST sync: it fills the maps the write path
    // needs for an appliance that is offline right now.
    expect(ctx.syncs[0].migrateDeviceIds).toHaveBeenCalled();
    expect(ctx.syncs[0].migrateDeviceIds.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.syncs[0].migrateRenamedStates.mock.invocationCallOrder[0],
    );
    expect(ctx.syncs[0].migrateRenamedStates).toHaveBeenCalled();
    expect(ctx.syncs[0].migrateRenamedStates.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.syncs[0].primeFromObjects.mock.invocationCallOrder[0],
    );
    // The numbered history moves to named runs before priming too (decision 48).
    expect(ctx.syncs[0].migrateHistoryRuns).toHaveBeenCalledTimes(1);
    expect(ctx.syncs[0].migrateHistoryRuns.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.syncs[0].primeFromObjects.mock.invocationCallOrder[0],
    );
    expect(ctx.syncs[0].primeFromObjects).toHaveBeenCalled();
    expect(ctx.syncs[0].primeFromObjects.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.syncs[0].syncAppliances.mock.invocationCallOrder[0],
    );
    expect(ctx.i.subscribed).toEqual(["*"]);
    expect(ctx.streams[0].start).toHaveBeenCalledTimes(1);
  });

  it("stamps every appliance unreachable before the first cloud call", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const sync = ctx.syncs[0];

    // The appliance list can fail to arrive (expired token, no internet). Without
    // the stamp nothing would ever correct the previous run's "reachable" and the
    // whole tree would sit there green while the adapter knows nothing.
    expect(sync.markAllUnreachable).toHaveBeenCalledTimes(1);
    expect(sync.markAllUnreachable.mock.invocationCallOrder[0]).toBeLessThan(
      sync.syncAppliances.mock.invocationCallOrder[0],
    );
  });

  it("opens exactly one event stream, however often the sign-in completes", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    await ctx.auths[0].port.onSignedIn();
    // A second stream doubles every event and survives onUnload, which only ever
    // sees the newest one.
    expect(ctx.streams).toHaveLength(1);
  });

  it("publishes the verification URL and raises a notification for the user", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await (ctx.auths[0].port.setVerificationUrl as (u: string) => Promise<void>)("https://verify?code=1234");
    expect(ctx.i.states.get("auth.verificationUrl")).toEqual({ val: "https://verify?code=1234", ack: true });

    (ctx.auths[0].port.notify as (m: string) => void)("please sign in");
    expect(ctx.i.registerNotification).toHaveBeenCalledWith("homeconnect", "userActionRequired", "please sign in");
  });

  it("survives a js-controller without the notification subsystem", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.registerNotification.mockRejectedValue(new Error("no such scope"));
    // notifyUser is fire-and-forget from a sync caller: an unhandled rejection
    // here takes the whole adapter down over a cosmetic notification.
    expect(() => ctx.i.notifyUser("hi")).not.toThrow();
    await settle();
    await settle();
    expect(ctx.i.log.debug).toHaveBeenCalledWith("Could not raise notification: no such scope");
    expect(ctx.i.log.error).not.toHaveBeenCalled();
  });

  it("routes stream events into the sync and reflects the connection state", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const deps = ctx.streams[0].deps;

    (deps.onEvent as (e: unknown) => void)({ event: "STATUS", data: "{}", id: "" });
    expect(ctx.syncs[0].handleStreamEvent).toHaveBeenCalledWith({ event: "STATUS", data: "{}", id: "" });

    // Signed in (the auth port says so) AND the stream is up → connected.
    await (ctx.auths[0].port.setConnected as (c: boolean) => Promise<void>)(true);
    (deps.onConnected as (c: boolean) => void)(true);
    await settle();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
    (deps.onConnected as (c: boolean) => void)(false);
    await settle();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("info.connection has one owner: a token refresh cannot turn a dead stream green", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const deps = ctx.streams[0].deps;
    const setConnected = ctx.auths[0].port.setConnected as (c: boolean) => Promise<void>;

    await setConnected(true);
    (deps.onConnected as (c: boolean) => void)(true);
    await settle();
    (deps.onConnected as (c: boolean) => void)(false);
    await settle();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });

    // A routine token refresh reports "signed in" again. With two writers this
    // flipped the flag green while no value could arrive, until the next failed
    // reconnect flipped it back — a flicker every refresh.
    await setConnected(true);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });

    // The stream alone is not enough either: without a usable token it is dead.
    await setConnected(false);
    (deps.onConnected as (c: boolean) => void)(true);
    await settle();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("lets a rejected stream token trigger a refresh", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    ctx.auths[0].refreshNow.mockResolvedValue(true);
    const onUnauthorized = ctx.streams[0].deps.onUnauthorized as () => Promise<boolean>;
    // A token the stream endpoint rejects would otherwise stay in use until the
    // periodic check notices the expiry — up to a day without live updates.
    await expect(onUnauthorized()).resolves.toBe(true);
    expect(ctx.auths[0].refreshNow).toHaveBeenCalledTimes(1);
  });

  it("gives the stream the CURRENT token, not the one from start-up", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    ctx.auths[0].accessToken = "REFRESHED";
    // A captured token would make every reconnect after the first refresh fail
    // with 401 until the adapter is restarted.
    expect((ctx.streams[0].deps.getAccessToken as () => string | undefined)()).toBe("REFRESHED");
  });
});

describe("Homeconnect REST reads", () => {
  it("sends the token and the system language, and unwraps the data", async () => {
    const ctx = setup();
    // The system language comes from system.config — `this.language` stays empty
    // for an adapter without `useFormatDate` (js-controller 7.2.2).
    ctx.i.foreign.set("system.config", { common: { language: "de" } });
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(okResult({ status: [] }));

    await expect(ctx.i.apiGet("/api/x")).resolves.toEqual({ status: [] });
    expect(httpMock.getJson).toHaveBeenCalledWith("https://api.home-connect.com", "/api/x", "AT", "de-DE");
  });

  it("hands the system language to the appliance sync — the language of every value label", async () => {
    const ctx = setup();
    ctx.i.foreign.set("system.config", { common: { language: "de" } });
    await ctx.i.onReady();
    expect((ctx.syncs[0].port as unknown as { language?: string }).language).toBe("de");
    const none = setup();
    await none.i.onReady();
    expect((none.syncs[0].port as unknown as { language?: string }).language).toBeUndefined();
  });

  it("asks the API to decide the language when the system language is unmapped", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    expect(ctx.i.acceptLanguage()).toBeUndefined();
    const other = setup();
    other.i.foreign.set("system.config", { common: { language: "kl" } });
    await other.i.onReady();
    expect(other.i.acceptLanguage()).toBeUndefined();
    const zh = setup();
    zh.i.foreign.set("system.config", { common: { language: "zh-cn" } });
    await zh.i.onReady();
    expect(zh.i.acceptLanguage()).toBe("zh-CN");
  });

  it("does not call the API while there is no token", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.auths[0].accessToken = undefined;
    await expect(ctx.i.apiGet("/api/x")).resolves.toBeUndefined();
    expect(httpMock.getJson).not.toHaveBeenCalled();
  });

  it("refreshes once on a 401 and repeats the call with the fresh token", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValueOnce(failResult(401)).mockResolvedValueOnce(okResult({ ok: 1 }));
    ctx.auths[0].refreshNow.mockImplementation(() => {
      ctx.auths[0].accessToken = "FRESH";
      return Promise.resolve(true);
    });

    await expect(ctx.i.apiGet("/api/x")).resolves.toEqual({ ok: 1 });
    expect(httpMock.getJson).toHaveBeenCalledTimes(2);
    expect(httpMock.getJson.mock.calls[1][2]).toBe("FRESH");
  });

  it("gives up after one 401 retry instead of looping", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(401));
    ctx.auths[0].refreshNow.mockResolvedValue(true);
    // Without the single-shot retry a permanently rejected token produces an
    // endless refresh/call loop against a rate-limited API.
    await expect(ctx.i.apiGet("/api/x")).resolves.toBeUndefined();
    expect(httpMock.getJson).toHaveBeenCalledTimes(2);
  });

  it("does not repeat the call when the refresh itself failed", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(401));
    ctx.auths[0].refreshNow.mockResolvedValue(false);
    await expect(ctx.i.apiGet("/api/x")).resolves.toBeUndefined();
    expect(httpMock.getJson).toHaveBeenCalledTimes(1);
  });
});

describe("Homeconnect rate limiting", () => {
  const NOW = 1_700_000_000_000;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());
  /**
   * apiGet under fake timers: let the 100 ms request spacing elapse.
   *
   * @param ctx the adapter under test
   * @param path the endpoint path
   * @returns what apiGet resolves to
   */
  const get = async (ctx: Ctx, path: string): Promise<unknown> => {
    const pending = ctx.i.apiGet(path);
    await vi.advanceTimersByTimeAsync(100);
    return pending;
  };

  it("honours the Retry-After the API sent", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(429, { retryAfterMs: 5_000 }));
    await get(ctx, "/api/x");
    httpMock.getJson.mockClear();

    await expect(get(ctx, "/api/y")).resolves.toBeUndefined();
    expect(httpMock.getJson).not.toHaveBeenCalled();

    vi.setSystemTime(NOW + 5_001);
    httpMock.getJson.mockResolvedValue(okResult({ back: true }));
    await expect(get(ctx, "/api/y")).resolves.toEqual({ back: true });
  });

  it("pauses even when the 429 carried no Retry-After", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(429));
    await get(ctx, "/api/x");
    httpMock.getJson.mockClear();

    // Hammering on through a 429 is how an app loses its Home Connect quota for
    // the rest of the day.
    await get(ctx, "/api/y");
    expect(httpMock.getJson).not.toHaveBeenCalled();
    vi.setSystemTime(NOW + 60_001);
    await get(ctx, "/api/y");
    expect(httpMock.getJson).toHaveBeenCalledTimes(1);
  });

  it("tells the user about a dropped write, but keeps a dropped read quiet", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(429, { retryAfterMs: 30_000 }));
    await get(ctx, "/api/x");
    ctx.i.log.warn.mockClear();
    ctx.i.log.debug.mockClear();

    await get(ctx, "/api/y");
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("REST paused"));

    // A dropped write is a lost user action — silently swallowing it leaves the
    // user staring at a button that did nothing.
    await expect(ctx.i.apiWrite({ method: "PUT", path: "/api/z", body: { key: "k" } })).resolves.toBeUndefined();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("PUT /api/z dropped"));
    expect(httpMock.putJson).not.toHaveBeenCalled();
  });

  it("warns once per failure category, then drops to debug, and says when it recovers", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(500));
    await get(ctx, "/api/x");
    await get(ctx, "/api/x");
    expect(ctx.i.log.warn.mock.calls.filter(c => String(c[0]).includes("/api/x failed"))).toHaveLength(1);
    expect(ctx.i.log.debug.mock.calls.filter(c => String(c[0]).includes("/api/x failed"))).toHaveLength(1);

    httpMock.getJson.mockResolvedValue(okResult());
    await get(ctx, "/api/x");
    expect(ctx.i.log.info).toHaveBeenCalledWith("GET /api/x succeeded again.");

    ctx.i.log.info.mockClear();
    await get(ctx, "/api/x");
    // Only the FIRST success after a failure is news. Announcing every routine
    // read as a recovery makes the info log useless.
    expect(ctx.i.log.info).not.toHaveBeenCalled();
  });

  it("says nothing at info about a call that never failed", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.log.info.mockClear();
    await get(ctx, "/api/fresh");
    expect(ctx.i.log.info).not.toHaveBeenCalled();
  });

  it("keeps an expected appliance answer out of the warnings entirely", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // An idle appliance HAS no active program — the API ships that as an HTTP
    // error. Every adapter start next to an idle dishwasher used to warn.
    httpMock.getJson.mockResolvedValue(failResult(404, { error: "SDK.Error.NoProgramActive" }));
    await expect(get(ctx, "/api/a/programs/active")).resolves.toBeNull();
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("SDK.Error.NoProgramActive"));

    // And it never arms the recovery echo: the next success is routine, not news.
    httpMock.getJson.mockResolvedValue(okResult());
    ctx.i.log.info.mockClear();
    await get(ctx, "/api/a/programs/active");
    expect(ctx.i.log.info).not.toHaveBeenCalled();
  });

  it("tells 'there is none' (null) apart from 'nothing is known' (undefined)", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // "No program selected/active" is an answer — the caller may write "idle" on
    // it. A busy appliance, a 5xx and a transport failure answer NOTHING: a
    // caller that treated them like "none" wrote an idle program over a running
    // one after a single timeout and disarmed the option gate with it.
    httpMock.getJson.mockResolvedValue(failResult(404, { error: "SDK.Error.NoProgramSelected" }));
    await expect(get(ctx, "/api/a/programs/selected")).resolves.toBeNull();
    httpMock.getJson.mockResolvedValue(failResult(409, { error: "SDK.Error.WrongOperationState" }));
    await expect(get(ctx, "/api/a/programs/available")).resolves.toBeUndefined();
    httpMock.getJson.mockResolvedValue(failResult(503));
    await expect(get(ctx, "/api/a/programs/selected")).resolves.toBeUndefined();
    httpMock.getJson.mockResolvedValue(failResult(0));
    await expect(get(ctx, "/api/a/programs/selected")).resolves.toBeUndefined();
    // The busy answer stays quiet like the idle one; the two failures warn (deduped).
    expect(ctx.i.log.warn.mock.calls.filter(c => String(c[0]).includes("WrongOperationState"))).toHaveLength(0);
  });

  it("counts an appliance answer as the recovery of a failing endpoint kind", async () => {
    // Measured on a live server (2026-09-20 → 2026-09-23): an idle appliance only
    // ever answers "no program" on these two paths, so a failure there was never
    // cleared — the "succeeded again" line came days later, for another appliance,
    // and every failure of the same kind in between was debug-only.
    for (const error of ["SDK.Error.NoProgramActive", "SDK.Error.WrongOperationState"]) {
      const ctx = setup();
      await ctx.i.onReady();
      httpMock.getJson.mockResolvedValue(failResult(503));
      await get(ctx, "/api/homeappliances/A/programs/active");
      httpMock.getJson.mockResolvedValue(failResult(error.endsWith("State") ? 409 : 404, { error }));
      await get(ctx, "/api/homeappliances/A/programs/active");
      expect(ctx.i.log.info).toHaveBeenCalledWith("GET /api/homeappliances/A/programs/active succeeded again.");

      // Cleared for real: the next failure of the kind is news again.
      ctx.i.log.warn.mockClear();
      httpMock.getJson.mockResolvedValue(failResult(503));
      await get(ctx, "/api/homeappliances/A/programs/active");
      expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("programs/active failed"));
    }
  });

  it("pins the price of the appliance-free dedup key: one appliance's answer clears another's failure", async () => {
    // Accepted, not accidental: the key is the endpoint KIND (one cloud outage must
    // not warn once per appliance), so an idle appliance's answer proves the kind
    // healthy while another appliance keeps failing on it. That costs one warn plus
    // one recovery line per pass — passes run on CONNECTED, the outage re-read
    // (at most hourly) and the start, a few per day.
    const ctx = setup();
    await ctx.i.onReady();
    for (let pass = 0; pass < 2; pass++) {
      httpMock.getJson.mockResolvedValueOnce(failResult(503));
      await get(ctx, "/api/homeappliances/A/programs/active");
      httpMock.getJson.mockResolvedValueOnce(failResult(404, { error: "SDK.Error.NoProgramActive" }));
      await get(ctx, "/api/homeappliances/B/programs/active");
    }
    expect(ctx.i.log.warn.mock.calls.filter(c => String(c[0]).includes("programs/active failed"))).toHaveLength(2);
    expect(ctx.i.log.info.mock.calls.filter(c => String(c[0]).includes("succeeded again"))).toHaveLength(2);
  });

  it("reads a refused program list (ProgramNotAvailable) as a busy appliance, not a failure", async () => {
    // Measured live (2026-09-16, 2026-09-20): a washer-dryer running a program the
    // API does not know refuses the LIST with this key — the swagger names it only
    // for the single-program path.
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(409, { error: "SDK.Error.ProgramNotAvailable" }));
    await expect(get(ctx, "/api/homeappliances/A/programs/available")).resolves.toBeUndefined();
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("SDK.Error.ProgramNotAvailable"));
  });

  it("reads a program the API does not describe as an answer and reports it to the sync", async () => {
    // A program chosen at the dial that the API does not offer — a permanent
    // property of the appliance, nothing the user can fix (measured live
    // 2026-09-16 → 2026-09-22: one warning per selection spell).
    const ctx = setup();
    await ctx.i.onReady();
    const path = "/api/homeappliances/A/programs/available/P.Auto30";
    httpMock.getJson.mockResolvedValue(failResult(503));
    await get(ctx, "/api/homeappliances/A/programs/available/P.Other");
    ctx.i.log.warn.mockClear();
    httpMock.getJson.mockResolvedValue(failResult(400, { error: "SDK.Error.UnsupportedProgram" }));
    await expect(get(ctx, path)).resolves.toBeUndefined();
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("SDK.Error.UnsupportedProgram"));
    // The answer proves the endpoint kind healthy.
    expect(ctx.i.log.info).toHaveBeenCalledWith(`GET ${path} succeeded again.`);
    expect(ctx.syncs[0].noteUnsupportedProgram).toHaveBeenCalledWith(path);
  });

  it("reads 'connection still initializing' as a state: debug, reported to the sync, dedup untouched", async () => {
    // Measured live (2026-09-18/20/23): an appliance just switched on answered six
    // reads in a row with this — six warnings and five "succeeded again" lines per
    // power-on, a third of the whole log.
    const ctx = setup();
    await ctx.i.onReady();
    const path = "/api/homeappliances/A/status";
    httpMock.getJson.mockResolvedValue(failResult(503));
    await get(ctx, path);
    ctx.i.log.warn.mockClear();
    httpMock.getJson.mockResolvedValue(
      failResult(409, { error: "SDK.Error.HomeAppliance.Connection.Initialization.Failed" }),
    );
    await expect(get(ctx, path)).resolves.toBeUndefined();
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Initialization.Failed"));
    expect(ctx.syncs[0].noteNotReady).toHaveBeenCalledWith(path);
    // Neither a failure nor a proof the endpoint works: the earlier 503 is still
    // the open failure, and the next real success reports its recovery.
    expect(ctx.i.log.info).not.toHaveBeenCalledWith(`GET ${path} succeeded again.`);
    httpMock.getJson.mockResolvedValue(okResult());
    await get(ctx, path);
    expect(ctx.i.log.info).toHaveBeenCalledWith(`GET ${path} succeeded again.`);
  });
});

describe("Homeconnect REST writes", () => {
  it("routes PUT and DELETE to their transports", async () => {
    const ctx = setup();
    await ctx.i.onReady();

    await ctx.i.apiWrite({ method: "PUT", path: "/api/p", body: { key: "k", value: 1 } });
    expect(httpMock.putJson).toHaveBeenCalledWith("https://api.home-connect.com", "/api/p", "AT", {
      key: "k",
      value: 1,
    });

    await ctx.i.apiWrite({ method: "DELETE", path: "/api/d" });
    expect(httpMock.deleteJson).toHaveBeenCalledWith("https://api.home-connect.com", "/api/d", "AT");
    expect(httpMock.putJson).toHaveBeenCalledTimes(1);
  });

  it("returns the result so the caller can react to a 409", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.putJson.mockResolvedValue(failResult(409));
    // A rejected write logged as "ok" hides the one failure the user cares most
    // about — the button they just pressed.
    await ctx.i.apiWrite({ method: "PUT", path: "/api/p", body: { key: "k" } });
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("PUT /api/p failed"));
    expect(ctx.i.log.debug).not.toHaveBeenCalledWith("PUT /api/p ok");

    // ApplianceSync retries a rejected program start with defaults — it can only
    // do that if the status actually comes back.
    await expect(ctx.i.apiWrite({ method: "PUT", path: "/api/p", body: { key: "k" } })).resolves.toMatchObject({
      status: 409,
      ok: false,
    });
  });

  it("says when a write works again after a failing spell", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.putJson.mockResolvedValue(failResult(500));
    const req: WriteRequest = { method: "PUT", path: "/api/p", body: { key: "k" } };
    await ctx.i.apiWrite(req);
    expect(ctx.i.log.warn).toHaveBeenCalledWith(expect.stringContaining("PUT /api/p failed"));

    httpMock.putJson.mockResolvedValue(okResult());
    ctx.i.log.info.mockClear();
    await ctx.i.apiWrite(req);
    // The user saw the warning; without this they have no way to know the button
    // works again.
    expect(ctx.i.log.info).toHaveBeenCalledWith("PUT /api/p succeeded again.");

    ctx.i.log.info.mockClear();
    await ctx.i.apiWrite(req);
    expect(ctx.i.log.info).not.toHaveBeenCalled();
  });

  it("retries a write once after a 401", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.putJson.mockResolvedValueOnce(failResult(401)).mockResolvedValueOnce(okResult());
    ctx.auths[0].refreshNow.mockImplementation(() => {
      ctx.auths[0].accessToken = "FRESH";
      return Promise.resolve(true);
    });

    await expect(ctx.i.apiWrite({ method: "PUT", path: "/api/p", body: { key: "k" } })).resolves.toMatchObject({
      ok: true,
    });
    expect(httpMock.putJson.mock.calls[1][2]).toBe("FRESH");
  });

  it("sends nothing while there is no token", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.auths[0].accessToken = undefined;
    await expect(ctx.i.apiWrite({ method: "PUT", path: "/api/p", body: { key: "k" } })).resolves.toBeUndefined();
    expect(httpMock.putJson).not.toHaveBeenCalled();
  });
});

describe("Homeconnect state changes", () => {
  it("routes a user write and ignores its own confirmations", async () => {
    const ctx = setup();
    await ctx.i.onReady();

    ctx.i.onStateChange("homeconnect.0.oven.settings.powerState", { val: "off", ack: false });
    expect(ctx.syncs[0].handleWrite).toHaveBeenCalledWith("homeconnect.0.oven.settings.powerState", "off");

    ctx.syncs[0].handleWrite.mockClear();
    // An acked change is the adapter's own echo. Sending it back would turn every
    // confirmation into a new cloud write — an endless loop.
    ctx.i.onStateChange("homeconnect.0.oven.settings.powerState", { val: "off", ack: true });
    ctx.i.onStateChange("homeconnect.0.oven.settings.powerState", null);
    ctx.i.onStateChange("homeconnect.0.oven.settings.powerState", undefined);
    expect(ctx.syncs[0].handleWrite).not.toHaveBeenCalled();
  });

  it("ignores a write without throwing when no client id is configured", async () => {
    const ctx = setup({ clientID: "" });
    await ctx.i.onReady();
    expect(() => ctx.i.onStateChange("homeconnect.0.x.y.z", { val: 1, ack: false })).not.toThrow();
  });
});

describe("Homeconnect onUnload", () => {
  it("stops both collaborators, reports disconnected and always calls back", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const cb = vi.fn();

    await new Promise<void>(resolve => ctx.i.onUnload(() => (cb(), resolve())));
    expect(ctx.auths[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.streams[0].stop).toHaveBeenCalledTimes(1);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    expect(cb).toHaveBeenCalledTimes(1);
    // Dropping the references stops a late callback from reviving anything.
    expect(ctx.i.authCtl).toBeUndefined();
    expect(ctx.i.eventStream).toBeUndefined();
  });

  it("does not subscribe to states when the stop lands during the start-up chain", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // The sign-in chain is fire-and-forget. Stop the adapter while it is between
    // two steps: nothing after the guard may run on a shutting-down instance.
    // After the LAST step of the chain: the guard after the appliance read is the
    // only one before the subscribe — which is exactly why it is not redundant.
    ctx.syncs[0].syncAppliances.mockImplementation(() => {
      ctx.i.onUnload(() => undefined);
      return Promise.resolve(true);
    });
    await ctx.auths[0].port.onSignedIn();
    await settle();
    expect(ctx.i.subscribeStatesAsync).not.toHaveBeenCalled();
  });

  it("resets auth.signedIn — a stopped instance must not report itself signed in", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await (ctx.auths[0].port.setConnected as (c: boolean) => Promise<void>)(true);
    await ctx.auths[0].port.onSignedIn();
    expect(ctx.i.states.get("auth.signedIn")).toEqual({ val: true, ack: true });

    await new Promise<void>(resolve => ctx.i.onUnload(() => resolve()));

    // Before the fix only `publishConnection` wrote this marker, and it does not run during
    // teardown — so it stayed `true` after every signed-in stop and the sign-in
    // panel showed "signed in" for an instance that was not running. Same rule as
    // the appliance markers: what is set at runtime is reset on the way out.
    expect(ctx.i.states.get("auth.signedIn")).toEqual({ val: false, ack: true });
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });

  it("marks every appliance unreachable before reporting done", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const sync = ctx.syncs[0];

    // Settle a turn LATER than the call — a write that resolves synchronously
    // would let this pass even with the callback fired first.
    const order: string[] = [];
    sync.markAllUnreachable.mockImplementation(
      async () => new Promise<void>(r => globalThis.setTimeout(() => (order.push("markers"), r()), 0)),
    );

    await new Promise<void>(resolve => ctx.i.onUnload(() => (order.push("callback"), resolve())));

    // Nothing else resets them, and the host's own reset writes to the wrong id —
    // a lost write leaves every appliance green while the adapter is off.
    expect(order).toEqual(["markers", "callback"]);
  });

  it("still reports done when the last write is rejected", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    ctx.syncs[0].markAllUnreachable.mockRejectedValue(new Error("states db down"));

    const cb = vi.fn();
    await new Promise<void>(resolve => ctx.i.onUnload(() => (cb(), resolve())));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Final shutdown write failed"));
  });

  it("still calls back when a teardown step throws", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.auths[0].stop.mockImplementation(() => {
      throw new Error("boom");
    });
    const cb = vi.fn();
    // A missed callback is a SIGKILL — js-controller does not wait.
    expect(() => ctx.i.onUnload(cb)).not.toThrow();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("unloads cleanly before anything was started", async () => {
    const ctx = setup();
    const cb = vi.fn();
    await new Promise<void>(resolve => ctx.i.onUnload(() => (cb(), resolve())));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("stops the still-running start-up chain: no REST, no late event stream", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await new Promise<void>(resolve => ctx.i.onUnload(resolve));

    // The sign-in/sync chain is fire-and-forget. On a stop right after start it
    // used to keep syncing past the teardown and re-open the event stream —
    // whose timer the host then refuses ("setTimeout called, but adapter is
    // shutting down") while the tree filled with post-shutdown online markers.
    httpMock.getJson.mockClear();
    await expect(ctx.i.apiGet("/api/x")).resolves.toBeUndefined();
    expect(httpMock.getJson).not.toHaveBeenCalled();
    await expect(ctx.i.apiWrite({ method: "PUT", path: "/api/p", body: { key: "k" } })).resolves.toBeUndefined();
    expect(httpMock.putJson).not.toHaveBeenCalled();

    await ctx.auths[0].port.onSignedIn();
    expect(ctx.streams).toHaveLength(0);
  });
});

describe("Homeconnect port wiring", () => {
  it("builds the real collaborators when nothing replaces the seams", () => {
    // The seams exist only for these tests. If one pointed at the wrong class,
    // every test here would still pass while production started nothing.
    const i = internalOf(new Homeconnect());
    expect(typeof i.makeSync).toBe("function");
    expect(typeof i.makeAuthController).toBe("function");
    expect(typeof i.makeEventStream).toBe("function");
    const sync = (i.makeSync as (p: unknown) => object)({ namespace: "homeconnect.0", log: i.log });
    expect(sync.constructor.name).toBe("ApplianceSync");
    const stream = (i.makeEventStream as (d: unknown) => object)({ baseUrl: "https://x" });
    expect(stream.constructor.name).toBe("EventStream");
    const ctl = (i.makeAuthController as (a: unknown, p: unknown) => object)({}, { log: i.log });
    expect(ctl.constructor.name).toBe("AuthController");
  });

  it("hands the sync the adapter APIs its contract names", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      namespace: string;
      extendObject(id: string, o: unknown): Promise<unknown>;
      setState(id: string, s: unknown): Promise<unknown>;
      setStateChanged(id: string, s: unknown): Promise<unknown>;
      getState(id: string): Promise<unknown>;
      getObject(id: string): Promise<unknown>;
      delObject(id: string): Promise<unknown>;
      getForeignObjects(p: string, t: string): Promise<unknown>;
      getAdapterObjects(): Promise<unknown>;
      getForeignStates(p: string): Promise<unknown>;
      setForeignObject(id: string, o: unknown): Promise<unknown>;
      extendForeignObject(id: string, o: unknown): Promise<unknown>;
      setForeignState(id: string, s: unknown): Promise<unknown>;
      getAliases(): Promise<unknown>;
      getEnums(): Promise<unknown>;
      apiGet(p: string): Promise<unknown>;
      apiWrite(r: WriteRequest): Promise<unknown>;
    };
    const a = ctx.i as unknown as Record<string, ReturnType<typeof vi.fn>>;

    expect(port.namespace).toBe("homeconnect.0");
    await port.extendObject("oven", { type: "device" });
    expect(ctx.i.objects.get("oven")).toMatchObject({ type: "device" });
    await port.setState("oven.x", { val: 1, ack: true });
    expect(ctx.i.states.get("oven.x")).toEqual({ val: 1, ack: true });
    // setStateChanged must NOT be wired to setState: the sync leans on it to keep
    // the object DB quiet when a value did not move.
    await port.setStateChanged("oven.y", { val: 2, ack: true });
    expect(a.setStateChangedAsync).toHaveBeenCalledWith("oven.y", { val: 2, ack: true });
    await expect(port.getState("oven.x")).resolves.toEqual({ val: 1, ack: true });
    await expect(port.getObject("oven")).resolves.toMatchObject({ type: "device" });
    // delObject must NOT be recursive here — the sync deletes single stale leaves.
    await port.delObject("oven.x");
    expect(a.delObjectAsync).toHaveBeenLastCalledWith("oven.x");
    await port.getForeignObjects("homeconnect.0.*", "device");
    expect(a.getForeignObjectsAsync).toHaveBeenCalledWith("homeconnect.0.*", "device");
    // The move calls — every one by FULL id, some of them outside the namespace.
    await port.getAdapterObjects();
    expect(a.getAdapterObjectsAsync).toHaveBeenCalled();
    await port.getForeignStates("homeconnect.0.oven.*");
    expect(a.getForeignStatesAsync).toHaveBeenCalledWith("homeconnect.0.oven.*");
    await port.setForeignObject("alias.0.x", { type: "state", common: {} });
    expect(ctx.i.foreign.get("alias.0.x")).toMatchObject({ type: "state" });
    await port.extendForeignObject("homeconnect.0.oven", { native: { idScheme: 3 } });
    expect(a.extendForeignObjectAsync).toHaveBeenCalledWith("homeconnect.0.oven", { native: { idScheme: 3 } });
    await port.setForeignState("homeconnect.0.oven.z", { val: 3, ack: true, ts: 5 });
    expect(a.setForeignStateAsync).toHaveBeenCalledWith("homeconnect.0.oven.z", { val: 3, ack: true, ts: 5 });
    await expect(port.getAliases()).resolves.toMatchObject({ "alias.0.x": { type: "state" } });
    expect(a.getForeignObjectsAsync).toHaveBeenCalledWith("alias.*", "state");
    ctx.i.foreign.set("enum.rooms.kitchen", { type: "enum", common: { members: [] } });
    await expect(port.getEnums()).resolves.toMatchObject({ "enum.rooms.kitchen": { type: "enum" } });
    expect(a.getForeignObjectsAsync).toHaveBeenCalledWith("enum.*", "enum");

    httpMock.getJson.mockResolvedValue(okResult({ v: 7 }));
    await expect(port.apiGet("/api/q")).resolves.toEqual({ v: 7 });
    await port.apiWrite({ method: "PUT", path: "/api/w", body: { key: "k" } });
    expect(httpMock.putJson).toHaveBeenCalled();
  });

  it("hands the sync the adapter's MANAGED timers", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      setTimer(cb: () => void, ms: number): unknown;
      clearTimer(h: unknown): void;
    };
    const a = ctx.i as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const cb = (): void => {};
    // The "not ready" re-read runs on these; a native timer outlives the unload.
    const t = port.setTimer(cb, 30_000);
    expect(a.setTimeout).toHaveBeenCalledWith(cb, 30_000);
    port.clearTimer(t);
    expect(a.clearTimeout).toHaveBeenCalledWith(t);
  });

  it("hands the sign-in the adapter's MANAGED timers", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.auths[0].port as unknown as {
      setTimer(cb: () => void, ms: number): unknown;
      clearTimer(h: unknown): void;
      setIntervalTimer(cb: () => void, ms: number): unknown;
      clearIntervalTimer(h: unknown): void;
      setConnected(c: boolean): Promise<void>;
    };
    const a = ctx.i as unknown as Record<string, ReturnType<typeof vi.fn>>;
    const cb = (): void => {};

    // Native timers are not cleared on unload — js-controller SIGKILLs over them.
    const t = port.setTimer(cb, 10);
    expect(a.setTimeout).toHaveBeenCalledWith(cb, 10);
    port.clearTimer(t);
    expect(a.clearTimeout).toHaveBeenCalledWith(t);
    const iv = port.setIntervalTimer(cb, 20);
    expect(a.setInterval).toHaveBeenCalledWith(cb, 20);
    port.clearIntervalTimer(iv);
    expect(a.clearInterval).toHaveBeenCalledWith(iv);

    // "Signed in" alone is half of info.connection — the stream must be up too.
    await port.setConnected(true);
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
    await ctx.auths[0].port.onSignedIn();
    (ctx.streams[0].deps.onConnected as (c: boolean) => void)(true);
    await settle();
    expect(ctx.i.states.get("info.connection")).toEqual({ val: true, ack: true });
  });

  it("initialises the translations before any object is created", async () => {
    const ctx = setup();
    const core = (await import("@iobroker/adapter-core")) as unknown as { I18n: { init: ReturnType<typeof vi.fn> } };
    core.I18n.init.mockClear();
    await ctx.i.onReady();
    // Channel and marker names are translation objects from admin/i18n; without
    // init they would come out as bare keys.
    expect(core.I18n.init).toHaveBeenCalledTimes(1);
    expect(core.I18n.init.mock.calls[0][0]).toBe(join("/opt/iobroker/node_modules/iobroker.homeconnect", "admin"));
  });

  it("gives the event stream the adapter's logger and managed timers", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const deps = ctx.streams[0].deps as unknown as {
      baseUrl: string;
      log(level: "debug" | "info", msg: string): void;
      setTimer(cb: () => void, ms: number): unknown;
      clearTimer(h: unknown): void;
    };
    const a = ctx.i as unknown as Record<string, ReturnType<typeof vi.fn>>;

    expect(deps.baseUrl).toBe("https://api.home-connect.com");
    deps.log("info", "hello");
    expect(ctx.i.log.info).toHaveBeenCalledWith("hello");
    deps.log("debug", "quiet");
    expect(ctx.i.log.debug).toHaveBeenCalledWith("quiet");
    const t = deps.setTimer(() => {}, 30);
    expect(a.setTimeout).toHaveBeenCalled();
    deps.clearTimer(t);
    expect(a.clearTimeout).toHaveBeenCalledWith(t);
  });

  it("posts the OAuth form to the configured host", async () => {
    const ctx = setup();
    let poster: ((p: string, f: Record<string, string>) => Promise<unknown>) | undefined;
    const realMake = ctx.i.makeAuthController as (a: unknown, p: unknown) => unknown;
    ctx.i.makeAuthController = (auth: { post?: unknown }, p: unknown) => {
      poster = (auth as unknown as { post: (p: string, f: Record<string, string>) => Promise<unknown> }).post;
      return realMake(auth, p);
    };
    await ctx.i.onReady();
    await poster?.("/security/oauth/token", { grant_type: "refresh_token" });
    expect(httpMock.postForm).toHaveBeenCalledWith("https://api.home-connect.com", "/security/oauth/token", {
      grant_type: "refresh_token",
    });
  });

  it("does not re-issue a call when the refresh produced no usable token", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(401));
    ctx.auths[0].refreshNow.mockImplementation(() => {
      ctx.auths[0].accessToken = undefined;
      return Promise.resolve(true);
    });
    // A refresh that reports success but leaves no token would otherwise repeat
    // the call with `undefined` in the Authorization header.
    await expect(ctx.i.apiGet("/api/x")).resolves.toBeUndefined();
    expect(httpMock.getJson).toHaveBeenCalledTimes(1);

    ctx.auths[0].accessToken = "AT";
    httpMock.putJson.mockResolvedValue(failResult(401));
    await ctx.i.apiWrite({ method: "PUT", path: "/api/p", body: { key: "k" } });
    expect(httpMock.putJson).toHaveBeenCalledTimes(1);
  });

  it("skips the appliance read but still subscribes and opens the stream when the sync was never built", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.sync = undefined;
    await expect(ctx.auths[0].port.onSignedIn()).resolves.toBeUndefined();
    expect(ctx.i.subscribed).toEqual(["*"]);
  });

  it("names the failure when the API sent no message", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue({ status: 503, ok: false, data: undefined, error: undefined });
    await ctx.i.apiGet("/api/x");
    // "GET /api/x failed: undefined" is a bug report nobody can act on.
    expect(ctx.i.log.warn).toHaveBeenCalledWith("GET /api/x failed: unknown");
  });
});

describe("Homeconnect tree delete that carries rooms and functions", () => {
  it("reads the assignments, deletes the tree once, then lists every new id — old ids gone", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      deleteTreeCarryingEnums(root: string, carry: Map<string, string[]>): Promise<number>;
    };
    ctx.i.objects.set("old", { type: "device" });
    ctx.i.objects.set("old.status.doorState", { type: "state" });
    ctx.i.foreign.set("enum.rooms.kitchen", {
      type: "enum",
      common: { members: ["homeconnect.0.old", "homeconnect.0.old.status.doorState", "hm-rpc.0.X"] },
    });
    ctx.i.foreign.set("enum.functions.doors", {
      type: "enum",
      common: { members: ["homeconnect.0.old.status.doorState"] },
    });
    const a = ctx.i as unknown as Record<string, ReturnType<typeof vi.fn>>;
    a.delObjectAsync.mockClear();

    const carried = await port.deleteTreeCarryingEnums(
      "old",
      new Map([
        ["homeconnect.0.old", ["homeconnect.0.new"]],
        // One old datapoint can have two successors (a door text became open + locked).
        [
          "homeconnect.0.old.status.doorState",
          ["homeconnect.0.new.status.doorOpen", "homeconnect.0.new.status.doorLocked"],
        ],
      ]),
    );

    expect(a.delObjectAsync).toHaveBeenCalledTimes(1);
    expect(a.delObjectAsync).toHaveBeenCalledWith("old", { recursive: true });
    expect(ctx.i.objects.has("old.status.doorState")).toBe(false);
    expect([...(ctx.i.foreign.get("enum.rooms.kitchen")?.common as { members: string[] }).members].sort()).toEqual([
      "hm-rpc.0.X",
      "homeconnect.0.new",
      "homeconnect.0.new.status.doorLocked",
      "homeconnect.0.new.status.doorOpen",
    ]);
    expect((ctx.i.foreign.get("enum.functions.doors")?.common as { members: string[] }).members.sort()).toEqual([
      "homeconnect.0.new.status.doorLocked",
      "homeconnect.0.new.status.doorOpen",
    ]);
    expect(carried).toBe(5);
  });

  it("only deletes when nothing of the tree is assigned anywhere", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      deleteTreeCarryingEnums(root: string, carry: Map<string, string[]>): Promise<number>;
    };
    ctx.i.objects.set("old", { type: "device" });
    const a = ctx.i as unknown as Record<string, ReturnType<typeof vi.fn>>;
    a.setForeignObject.mockClear();
    await expect(port.deleteTreeCarryingEnums("old", new Map())).resolves.toBe(0);
    expect(ctx.i.objects.has("old")).toBe(false);
    expect(a.setForeignObject).not.toHaveBeenCalled();
  });
});
describe("Homeconnect connection test (settings panel button)", () => {
  /** A signed-in adapter with the stream up, ready to be tested. */
  async function signedIn(): Promise<Ctx> {
    const ctx = setup();
    await ctx.i.onReady();
    await (ctx.auths[0].port.setConnected as (c: boolean) => Promise<void>)(true);
    await ctx.auths[0].port.onSignedIn();
    (ctx.streams[0].deps.onConnected as (c: boolean) => void)(true);
    await settle();
    return ctx;
  }

  it("makes a REAL request and reports the appliance count from that answer", async () => {
    const ctx = await signedIn();
    httpMock.getJson.mockResolvedValue(
      okResult({
        homeappliances: [
          { haId: "A", connected: true },
          { haId: "B", connected: false },
          { haId: "C", connected: true },
        ],
      }),
    );
    const answer = await ctx.i.checkConnection();
    expect(httpMock.getJson).toHaveBeenCalledWith(
      "https://api.home-connect.com",
      "/api/homeappliances",
      "AT",
      undefined,
    );
    // Every word is backed by the check: the count and the connected number come
    // from THIS response, "live updates" from the stream's actual state.
    expect(answer).toEqual({
      result: "Signed in — Home Connect listed 3 appliance(s), 2 of them connected right now. Live updates: connected.",
    });
  });

  it("says when the sign-in works but live updates are down, with the stream's own reason", async () => {
    const ctx = await signedIn();
    (ctx.streams[0].deps.onConnected as (c: boolean) => void)(false);
    ctx.streams[0].lastError = "status 503";
    httpMock.getJson.mockResolvedValue(okResult({ homeappliances: [] }));
    const answer = await ctx.i.checkConnection();
    expect(answer).toEqual({
      result:
        "Signed in — Home Connect listed 0 appliance(s), 0 of them connected right now. Live updates: NOT connected (status 503) — the adapter keeps retrying.",
    });
  });

  it("refreshes once on a 401 and reports a rejected login when that does not help", async () => {
    const ctx = await signedIn();
    httpMock.getJson.mockResolvedValueOnce(failResult(401)).mockResolvedValueOnce(okResult({ homeappliances: [] }));
    ctx.auths[0].refreshNow.mockImplementation(() => {
      ctx.auths[0].accessToken = "FRESH";
      return Promise.resolve(true);
    });
    await expect(ctx.i.checkConnection()).resolves.toMatchObject({ result: expect.stringContaining("listed 0") });
    expect(httpMock.getJson.mock.calls[1][2]).toBe("FRESH");

    httpMock.getJson.mockResolvedValue(failResult(401));
    ctx.auths[0].refreshNow.mockResolvedValue(false);
    // "Signed in" must never be claimed from a token the server just rejected.
    await expect(ctx.i.checkConnection()).resolves.toEqual({
      error: "Home Connect rejected the login (HTTP 401) — a new sign-in is required.",
    });
  });

  it("names a network failure and an unexpected answer instead of calling them fine", async () => {
    const ctx = await signedIn();
    httpMock.getJson.mockResolvedValue({ status: 0, ok: false, data: undefined, error: "network_error: ECONNREFUSED" });
    await expect(ctx.i.checkConnection()).resolves.toEqual({
      error: "Home Connect is not reachable: network_error: ECONNREFUSED",
    });
    httpMock.getJson.mockResolvedValue(failResult(503, { error: "SDK.Error.Unavailable" }));
    await expect(ctx.i.checkConnection()).resolves.toEqual({
      error: "Home Connect answered HTTP 503: SDK.Error.Unavailable",
    });
    httpMock.getJson.mockResolvedValue(okResult({ something: "else" }));
    await expect(ctx.i.checkConnection()).resolves.toMatchObject({
      error: expect.stringContaining("not with an appliance list"),
    });
  });

  it("does not spend a request during a rate-limit pause, and says so", async () => {
    const ctx = await signedIn();
    ctx.i.restBlockedUntil = Date.now() + 30_000;
    httpMock.getJson.mockClear();
    await expect(ctx.i.checkConnection()).resolves.toMatchObject({
      error: expect.stringContaining("paused after a rate limit"),
    });
    expect(httpMock.getJson).not.toHaveBeenCalled();
  });

  it("explains what is missing before any sign-in", async () => {
    const noCreds = setup({ clientID: "" });
    await noCreds.i.onReady();
    await expect(noCreds.i.checkConnection()).resolves.toMatchObject({
      error: expect.stringContaining("No Client ID configured"),
    });

    const ctx = setup();
    await ctx.i.onReady();
    ctx.auths[0].accessToken = undefined;
    await expect(ctx.i.checkConnection()).resolves.toMatchObject({
      error: expect.stringContaining("no Home Connect login is stored"),
    });
    ctx.i.states.set("auth.verificationUrl", { val: "https://verify?code=1", ack: true });
    await expect(ctx.i.checkConnection()).resolves.toMatchObject({
      error: expect.stringContaining("open the sign-in link"),
    });
    expect(httpMock.getJson).not.toHaveBeenCalled();
  });

  it("answers the panel's message with the test result, and unknown commands with an error", async () => {
    const ctx = await signedIn();
    httpMock.getJson.mockResolvedValue(okResult({ homeappliances: [] }));
    await ctx.i.onMessage({ command: "checkConnection", from: "system.adapter.admin.0", callback: { id: 1 } });
    expect(ctx.i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "checkConnection",
      { result: expect.stringContaining("Signed in") },
      { id: 1 },
    );
    await ctx.i.onMessage({ command: "somethingElse", from: "system.adapter.admin.0", callback: { id: 2 } });
    expect(ctx.i.sendTo).toHaveBeenLastCalledWith(
      "system.adapter.admin.0",
      "somethingElse",
      { error: "Unknown command: somethingElse" },
      { id: 2 },
    );
    // Without a callback there is nobody to answer — and nothing throws.
    ctx.i.sendTo.mockClear();
    await ctx.i.onMessage({ command: "checkConnection", from: "x" });
    expect(ctx.i.sendTo).not.toHaveBeenCalled();
  });

  it("passes the panel's sign-in buttons to the sign-in and answers with what happened", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.i.onMessage({ command: "requestSignIn", from: "system.adapter.admin.0", callback: { id: 3 } });
    expect(ctx.auths[0].requestSignIn).toHaveBeenCalledTimes(1);
    expect(ctx.i.sendTo).toHaveBeenLastCalledWith(
      "system.adapter.admin.0",
      "requestSignIn",
      { result: "A new sign-in link was requested." },
      { id: 3 },
    );
    await ctx.i.onMessage({ command: "resetLogin", from: "system.adapter.admin.0", callback: { id: 4 } });
    expect(ctx.auths[0].resetLogin).toHaveBeenCalledTimes(1);
    expect(ctx.auths[0].requestSignIn).toHaveBeenCalledTimes(1);
  });

  it("says what is missing when a sign-in button is pressed without a client id", async () => {
    const ctx = setup({ clientID: "" });
    await ctx.i.onReady();
    await ctx.i.onMessage({ command: "resetLogin", from: "system.adapter.admin.0", callback: { id: 5 } });
    expect(ctx.i.sendTo).toHaveBeenLastCalledWith(
      "system.adapter.admin.0",
      "resetLogin",
      { error: "No Client ID configured — enter it above and save first." },
      { id: 5 },
    );
  });

  it("publishes the sign-in half on its own for the panel", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await (ctx.auths[0].port.setConnected as (c: boolean) => Promise<void>)(true);
    // Signed in, stream not up: the panel must be able to show exactly that.
    expect(ctx.i.states.get("auth.signedIn")).toEqual({ val: true, ack: true });
    expect(ctx.i.states.get("info.connection")).toEqual({ val: false, ack: true });
  });
});

describe("findings of the 2026-09-04 audit", () => {
  it("names its own manifest objects on every start", async () => {
    const ctx = setup();
    await ctx.i.onReady();

    // js-controller applies the manifest at each start, but preserves
    // common.name — a rename would reach new installations only. The adapter
    // owns its datapoints, so it writes name and explanation itself.
    for (const id of [
      "auth",
      "auth.session",
      "auth.verificationUrl",
      "auth.signedIn",
      "info",
      "info.connection",
      "info.devicesTotal",
      "info.devicesOnline",
      "info.devicesAllOnline",
    ]) {
      expect(ctx.i.objects.get(id), id).toBeDefined();
      expect((ctx.i.objects.get(id) as { common: { name: unknown } }).common.name).toBeDefined();
    }
    // The states carry an explanation too; the two channels have nothing to explain.
    expect((ctx.i.objects.get("info.connection") as { common: { desc: unknown } }).common.desc).toBeDefined();
    expect((ctx.i.objects.get("info") as { common: Record<string, unknown> }).common.desc).toBeUndefined();
  });

  it("names them even when no credentials are configured yet", async () => {
    const ctx = setup({ clientID: "", clientSecret: "" });
    await ctx.i.onReady();

    // A fresh instance sits here until the user enters the credentials — its
    // objects must still carry readable names in the object browser.
    expect(ctx.i.objects.get("info.connection")).toBeDefined();
    expect(ctx.i.log.warn).toHaveBeenCalled();
  });

  it("stops the start-up chain when the adapter is shutting down", async () => {
    const ctx = setup();
    // A stop right after start: each local step takes a while. Without the guard
    // the tree moves and the label repair keep WRITING OBJECTS after onUnload
    // already reported done.
    withSync(ctx, s =>
      s.migrateDeviceIds.mockImplementation(() => {
        ctx.i.onUnload(() => undefined);
        return Promise.resolve(undefined);
      }),
    );
    await ctx.i.onReady();
    const sync = ctx.syncs[0];

    expect(ctx.auths).toHaveLength(0);
    expect(sync.migrateDeviceIds).toHaveBeenCalledTimes(1);
    expect(sync.migrateRenamedStates).not.toHaveBeenCalled();
    expect(sync.primeFromObjects).not.toHaveBeenCalled();
    expect(sync.syncAppliances).not.toHaveBeenCalled();
    expect(ctx.i.subscribed).toEqual([]);
  });

  it("runs the whole start-up chain in order when it is not shutting down", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const sync = ctx.syncs[0];
    await ctx.auths[0].port.onSignedIn();

    // The order matters: both migrations before priming (the in-memory maps must
    // only ever see current ids), the unreachable stamp before the first cloud call.
    const order = [
      sync.migrateDeviceIds,
      sync.migrateRenamedStates,
      sync.primeFromObjects,
      sync.markAllUnreachable,
      sync.syncAppliances,
    ].map(fn => fn.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order.every(n => typeof n === "number")).toBe(true);
    expect(ctx.i.subscribed).toEqual(["*"]);
  });
});

describe("Homeconnect event-stream outage", () => {
  /**
   * Boot an adapter, sign it in and bring the stream up once — the state a live
   * instance is in before anything goes wrong.
   *
   * @returns the context plus the stream's onConnected callback
   */
  async function running(): Promise<{ ctx: Ctx; onConnected: (c: boolean) => void }> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    await settle();
    const onConnected = ctx.streams[0].deps.onConnected as unknown as (c: boolean) => void;
    onConnected(true);
    await settle();
    return { ctx, onConnected };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reads the appliances after an outage long enough to have lost something", async () => {
    const { ctx, onConnected } = await running();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(1);

    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();

    // Home Connect sends no snapshot on reconnect: without this the tree keeps
    // its pre-outage values while info.connection turns green again.
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(2);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("Live updates were interrupted for 120 s"));
    expect(ctx.i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("held back"));
  });

  it("measures an outage the keep-alive watchdog noticed from the last traffic, not from the abort", async () => {
    const { ctx } = await running();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(1);
    const onConnected = ctx.streams[0].deps.onConnected as unknown as (c: boolean, quietSince?: number) => void;

    // The connection went silent 130 s ago; the watchdog aborts only now and the
    // reconnect follows 5 s later. Counted from the abort, the outage looked like
    // 5 s and nothing was re-read — 130 s of events were simply missing.
    const quietSince = Date.now() - 130_000;
    onConnected(false, quietSince);
    await settle();
    vi.setSystemTime(Date.now() + 5_000);
    onConnected(true);
    await settle();

    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(2);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("Live updates were interrupted for 135 s"));
  });

  it("says so when the re-read was held back by the request quota", async () => {
    // Measured live 2026-09-23: a 925 s outage was re-read 21 minutes after the
    // stream came back — the info line read as if it had happened right away.
    const { ctx, onConnected } = await running();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    const deferred = ctx.i.setTimeout.mock.calls.at(-1)?.[0] as () => void;
    deferred();
    await settle();
    expect(ctx.i.log.info).toHaveBeenLastCalledWith(
      "Live updates were interrupted for 120 s — re-read the appliances (held back 58 min to protect the daily request quota).",
    );
  });

  it("A7: a hold-back under a minute says seconds, not '1 min'", async () => {
    const { ctx, onConnected } = await running();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    // The next outage ends 30 s before the cooldown runs out.
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 60 * 60_000 - 30_000);
    onConnected(true);
    await settle();
    const deferred = ctx.i.setTimeout.mock.calls.at(-1)?.[0] as () => void;
    deferred();
    await settle();
    expect(ctx.i.log.info).toHaveBeenLastCalledWith(
      expect.stringContaining("(held back 30 s to protect the daily request quota)"),
    );
  });

  it("neither announces nor cools down a catch-up that never reached the cloud", async () => {
    const { ctx, onConnected } = await running();
    // The appliance list is unreachable (expired token, no internet) — the sync
    // returns having learned nothing, one request spent.
    ctx.syncs[0].syncAppliances.mockResolvedValue(false);

    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();

    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(2);
    // No "re-read the appliances" line for a re-read that did not happen.
    expect(ctx.i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("Live updates were interrupted"));

    // And the cooldown did NOT start: the very next outage tries again instead of
    // leaving the tree on its pre-outage state for another 57 minutes.
    ctx.syncs[0].syncAppliances.mockResolvedValue(true);
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(3);
    expect(ctx.i.log.info).toHaveBeenCalledWith(expect.stringContaining("Live updates were interrupted"));
  });

  it("writes the two markers only when they actually change", async () => {
    const { ctx } = await running();
    const writes = (id: string): number => ctx.i.writeLog.filter(w => w.id === id).length;
    // Bring both halves up first — THAT write is a real change.
    await (ctx.auths[0].port.setConnected as (c: boolean) => Promise<void>)(true);
    await settle();
    const connBefore = writes("info.connection");
    const signedBefore = writes("auth.signedIn");
    expect(connBefore).toBeGreaterThan(0);

    // Now a routine token refresh: same values, so NOTHING may be written.
    // Writing unconditionally puts a change event and a history entry on every
    // token refresh (the check runs every ten minutes).
    await (ctx.auths[0].port.setConnected as (c: boolean) => Promise<void>)(true);
    await settle();
    expect(writes("info.connection")).toBe(connBefore);
    expect(writes("auth.signedIn")).toBe(signedBefore);
  });

  it("does not run a deferred re-read that comes due after the stop", async () => {
    const { ctx, onConnected } = await running();
    // Use up the hour, then queue a deferred re-read inside the cooldown.
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    const deferred = ctx.i.setTimeout.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    expect(deferred).toBeTypeOf("function");
    const before = ctx.syncs[0].syncAppliances.mock.calls.length;

    // The instance stops, and only THEN the deferred callback fires — a timer
    // callback already queued still arrives. Syncing now writes objects past the
    // teardown and re-opens what onUnload just closed.
    ctx.i.onUnload(() => undefined);
    deferred?.();
    await settle();
    expect(ctx.syncs[0].syncAppliances.mock.calls.length).toBe(before);
  });

  it("does not defer a second re-read onto a timer nobody clears", async () => {
    const { ctx, onConnected } = await running();
    // First outage uses up the hour.
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(2);

    // Two more outages INSIDE the cooldown: the due re-read is deferred, but only
    // ONE timer may exist — onUnload clears a single handle, so a second one would
    // fire on a shut-down instance.
    const timers = (): number => ctx.i.setTimeout.mock.calls.length;
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    const afterFirst = timers();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    expect(timers()).toBe(afterFirst);
  });

  it("does not re-read on the first connect of a run", async () => {
    const { ctx } = await running();
    // The start-up chain has just read everything — doing it again is a wasted
    // request out of a 1000/day quota.
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(1);
  });

  it("does not re-read when the FIRST connect only succeeded after a long wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_700_000_000_000);
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    await settle();
    const onConnected = ctx.streams[0].deps.onConnected as unknown as (c: boolean) => void;
    // The stream's first attempts fail; it only comes up minutes later. That is a
    // long "outage" by the clock, but the start-up chain read everything at t=0 —
    // re-reading here would just spend requests.
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 300_000);
    onConnected(true);
    await settle();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(1);
  });

  it("does not re-read after a short drop", async () => {
    const { ctx, onConnected } = await running();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 10_000);
    onConnected(true);
    await settle();
    // A clean transport drop reconnects in ~5 s; nothing meaningful is lost.
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(1);
  });

  it("counts the outage from the FIRST down report, not the last", async () => {
    const { ctx, onConnected } = await running();
    // The stream reports "down" again before every reconnect attempt.
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 100_000);
    onConnected(false);
    await settle();
    onConnected(true);
    await settle();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(2);
  });

  it("defers a second re-read into the next cooldown window instead of dropping it", async () => {
    const { ctx, onConnected } = await running();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(2);

    // A second outage right after: re-reading now would let a flapping stream
    // spend 4608 requests a day against a quota of 1000.
    ctx.i.setTimeout.mockClear();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(2);

    // But it is DEFERRED, not dropped — a dropped one would leave the tree stale
    // exactly when it must not be.
    const deferred = ctx.i.setTimeout.mock.calls.at(-1);
    expect(deferred).toBeDefined();
    expect(deferred?.[1]).toBeGreaterThan(0);
    (deferred?.[0] as () => void)();
    await settle();
    expect(ctx.syncs[0].syncAppliances).toHaveBeenCalledTimes(3);
  });

  it("takes one last chance at storing a rotated token on unload", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const auth = ctx.auths[0];
    await new Promise<void>(resolve => ctx.i.onUnload(resolve));
    // Home Connect kills the previous refresh token the moment it hands out a new
    // one — a rotated token the database refused earlier must get this last write,
    // or the next start asks the user for a fresh sign-in.
    expect(auth.persistPendingToken).toHaveBeenCalledTimes(1);
  });

  it("cancels a deferred re-read on unload", async () => {
    const { ctx, onConnected } = await running();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    onConnected(false);
    await settle();
    vi.setSystemTime(Date.now() + 120_000);
    onConnected(true);
    await settle();
    expect(ctx.i.resyncTimer).toBeDefined();

    await new Promise<void>(resolve => ctx.i.onUnload(resolve));
    // A timer left running fires into a stopped instance ("setTimeout called,
    // but adapter is shutting down").
    expect(ctx.i.clearTimeout).toHaveBeenCalled();
    expect(ctx.i.resyncTimer).toBeUndefined();
  });

  it("opens no event stream when the stop arrives while it is still subscribing", async () => {
    // Between the last `terminating` check and startEventStream() there is an
    // await (subscribeStatesAsync). A stop landing in that window must not leave
    // a live stream behind on a shut-down instance — the guard sits in
    // startEventStream itself, not only in onAuthenticated.
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.subscribeStatesAsync.mockImplementation(() => {
      // The host stops the instance while the subscription is still in flight.
      ctx.i.onUnload(() => undefined);
      return Promise.resolve();
    });
    await ctx.auths[0].port.onSignedIn();
    await settle();

    expect(ctx.streams).toHaveLength(0);
    expect(ctx.i.eventStream).toBeUndefined();
  });
});

describe("Homeconnect findings of the 2026-09-15 audit", () => {
  it("stops the sync before the markers are written on unload", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const sync = ctx.syncs[0];
    const order: string[] = [];
    sync.stop.mockImplementation(() => order.push("stop"));
    sync.markAllUnreachable.mockImplementation(() => (order.push("markers"), Promise.resolve(undefined)));
    await new Promise<void>(resolve => ctx.i.onUnload(() => (order.push("callback"), resolve())));
    // A pass still in flight would otherwise mark appliances online AFTER the
    // offline stamp — measured: two of four stayed green after a stop.
    expect(order).toEqual(["stop", "markers", "callback"]);
  });

  it("reports a failing start-up step as its own error", async () => {
    const ctx = setup();
    withSync(ctx, s => s.primeFromObjects.mockRejectedValue(new Error("Connection is closed.")));
    await expect(ctx.i.onReady()).resolves.toBeUndefined();
    expect(ctx.i.log.error).toHaveBeenCalledWith("Start-up failed at the priming: Connection is closed.");
    expect(ctx.i.log.warn).not.toHaveBeenCalled();
    // The chain stops at the failed step — no sign-in, no sync, no stream.
    expect(ctx.auths).toHaveLength(0);
    expect(ctx.syncs[0].syncAppliances).not.toHaveBeenCalled();
    expect(ctx.streams).toHaveLength(0);
  });

  it("logs a start-up error during the teardown at debug only", async () => {
    const ctx = setup();
    withSync(ctx, s =>
      s.primeFromObjects.mockImplementation(() => {
        ctx.i.onUnload(() => undefined);
        return Promise.reject(new Error("Connection is closed."));
      }),
    );
    await expect(ctx.i.onReady()).resolves.toBeUndefined();
    expect(ctx.i.log.error).not.toHaveBeenCalled();
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("start-up chain stopped at the priming"));
  });
});

describe("Homeconnect REST log dedup per endpoint kind (2026-09-15, F10)", () => {
  it("warns once for an outage that hits every appliance and setting, and recovers once", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValue(failResult(503));
    for (const path of [
      "/api/homeappliances/HA-1/settings/BSH.Common.Setting.PowerState",
      "/api/homeappliances/HA-1/settings/BSH.Common.Setting.ChildLock",
      "/api/homeappliances/HA-2/settings/BSH.Common.Setting.PowerState",
      "/api/homeappliances/HA-2/status",
    ]) {
      await ctx.i.apiGet(path);
    }
    // Measured before the fix: one warning per path (25 for a single 503 over a
    // start-up), then 25 "succeeded again" lines. Now one per endpoint kind.
    const warns = ctx.i.log.warn.mock.calls.map(c => String(c[0]));
    expect(warns.filter(m => m.includes("/settings/"))).toHaveLength(1);
    expect(warns.filter(m => m.includes("/status"))).toHaveLength(1);
    // The line itself still names the real path.
    expect(warns[0]).toContain("/HA-1/settings/BSH.Common.Setting.PowerState");

    httpMock.getJson.mockResolvedValue(okResult());
    ctx.i.log.info.mockClear();
    await ctx.i.apiGet("/api/homeappliances/HA-2/settings/BSH.Common.Setting.ChildLock");
    await ctx.i.apiGet("/api/homeappliances/HA-1/settings/BSH.Common.Setting.PowerState");
    expect(ctx.i.log.info.mock.calls.filter(c => String(c[0]).includes("succeeded again"))).toHaveLength(1);
  });
});

describe("Homeconnect §7 improvements (2026-09-15)", () => {
  it("kicks a waiting event stream when the user signs in again at runtime", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    expect(ctx.streams).toHaveLength(1);
    // A re-sign-in (revoked login → device flow → user confirms) runs the
    // sign-in callback again. The stream exists and used to be left alone —
    // waiting out a backoff of up to 300 s for a token that was already there.
    await ctx.auths[0].port.onSignedIn();
    expect(ctx.streams).toHaveLength(1);
    expect(ctx.streams[0].reconnectNow).toHaveBeenCalledTimes(1);
  });

  it("spaces two REST requests at least 100 ms apart", async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup();
      await ctx.i.onReady();
      httpMock.getJson.mockResolvedValue(okResult());
      const first = ctx.i.apiGet("/api/a");
      const second = ctx.i.apiGet("/api/b");
      await vi.advanceTimersByTimeAsync(0);
      expect(httpMock.getJson).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(httpMock.getJson).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(httpMock.getJson).toHaveBeenCalledTimes(2);
      await Promise.all([first, second]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not send a request whose spacing wait ran into the teardown", async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup();
      await ctx.i.onReady();
      httpMock.getJson.mockResolvedValue(okResult());
      void ctx.i.apiGet("/api/a");
      const second = ctx.i.apiGet("/api/b");
      await vi.advanceTimersByTimeAsync(0);
      ctx.i.onUnload(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      await expect(second).resolves.toBeUndefined();
      expect(httpMock.getJson).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Homeconnect findings of the 2026-09-24 audit", () => {
  it("F2: starts the subscription and the event stream even when the appliance sync fails", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.syncs[0].syncAppliances.mockRejectedValue(new TypeError("terminated"));
    await expect(ctx.auths[0].port.onSignedIn()).resolves.toBeUndefined();
    expect(ctx.i.log.error).toHaveBeenCalledWith(
      "Setting up the appliances failed: terminated — live updates start anyway.",
    );
    // Before: signed in, but no stream and no write path until a restart.
    expect(ctx.i.subscribed).toEqual(["*"]);
    expect(ctx.streams).toHaveLength(1);
    expect(ctx.streams[0].start).toHaveBeenCalled();
  });
});

describe("Homeconnect findings of the 2026-09-24 audit (unload, 401)", () => {
  it("F18: reports done only after every final write, even when the first one is rejected", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    const order: string[] = [];
    // The first final write goes through setStateChangedAsync (the fake's objects carry no read-only flag).
    (
      ctx.i as unknown as { setStateChangedAsync: ReturnType<typeof vi.fn> }
    ).setStateChangedAsync.mockImplementationOnce(() => Promise.reject(new Error("db gone")));
    let finishMarkers: () => void = () => undefined;
    ctx.syncs[0].markAllUnreachable.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishMarkers = () => {
            order.push("markers");
            resolve();
          };
        }),
    );
    const done = new Promise<void>(resolve => ctx.i.onUnload(() => (order.push("callback"), resolve())));
    await settle();
    // Promise.all gave up at the rejected write and fired the callback here.
    expect(order).toEqual([]);
    finishMarkers();
    await done;
    expect(order).toEqual(["markers", "callback"]);
    expect(ctx.i.log.debug).toHaveBeenCalledWith("Final shutdown write failed: db gone");
  });

  it("F12: waits for a token request in flight before storing the pending token", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const order: string[] = [];
    let finish: () => void = () => undefined;
    ctx.auths[0].settle.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finish = () => {
            order.push("settled");
            resolve();
          };
        }),
    );
    ctx.auths[0].persistPendingToken.mockImplementation(() => (order.push("persist"), Promise.resolve()));
    const done = new Promise<void>(resolve => ctx.i.onUnload(() => (order.push("callback"), resolve())));
    await settle();
    expect(order).toEqual([]);
    finish();
    await done;
    expect(order).toEqual(["settled", "persist", "callback"]);
  });

  it("C12: a 401 after someone else already refreshed retries with the new token, no second refresh", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockImplementationOnce(() => {
      // The token rotated while this request was on its way.
      ctx.auths[0].accessToken = "AT2";
      return Promise.resolve(failResult(401));
    });
    httpMock.getJson.mockResolvedValueOnce(okResult({ x: 1 }));
    await expect(ctx.i.apiGet("/api/homeappliances")).resolves.toEqual({ x: 1 });
    expect(ctx.auths[0].refreshNow).not.toHaveBeenCalled();
    expect(httpMock.getJson.mock.calls.at(-1)?.[2]).toBe("AT2");
  });
});

describe("Homeconnect findings of the 2026-09-24 audit (start-up once)", () => {
  it("F5: a runtime re-sign-in reads the appliances again but neither re-primes nor re-stamps", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    // The login was revoked at runtime and the user signed in again.
    await ctx.auths[0].port.onSignedIn();
    const sync = ctx.syncs[0];
    // Priming again added every writable option back into the armed gate, and the
    // stamp flipped every online appliance to offline.
    expect(sync.primeFromObjects).toHaveBeenCalledTimes(1);
    expect(sync.markAllUnreachable).toHaveBeenCalledTimes(1);
    expect(sync.migrateDeviceIds).toHaveBeenCalledTimes(1);
    expect(sync.syncAppliances).toHaveBeenCalledTimes(2);
  });

  it("F13: the local steps run before the sign-in starts", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const sync = ctx.syncs[0];
    expect(sync.markAllUnreachable.mock.invocationCallOrder[0]).toBeLessThan(
      ctx.auths[0].start.mock.invocationCallOrder[0],
    );
  });
});

describe("Homeconnect findings of the 2026-09-24 audit (write without login)", () => {
  it("F20: a write while not signed in is reported, not dropped silently", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.auths[0].accessToken = undefined;
    const req: WriteRequest = {
      method: "PUT",
      path: "/api/homeappliances/HA/settings/X",
      body: { key: "X", value: 1 },
    };
    await expect(ctx.i.apiWrite(req)).resolves.toBeUndefined();
    expect(ctx.i.log.warn).toHaveBeenCalledWith(
      "PUT /api/homeappliances/HA/settings/X dropped — not signed in to Home Connect (a new sign-in is pending).",
    );
    expect(httpMock.putJson).not.toHaveBeenCalled();
  });
});

describe("Homeconnect findings of the 2026-09-24 audit (rate pause)", () => {
  it("C8: a short 429 never shortens a long pause already running", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValueOnce(failResult(429, { retryAfterMs: 3_600_000 }));
    await ctx.i.apiGet("/api/homeappliances/A/status");
    const long = ctx.i.restBlockedUntil;
    // A request that was already in flight comes back with a header-less 429 (60 s).
    (ctx.i as unknown as { handleRestFailure(s: string, r: JsonResult): void }).handleRestFailure(
      "GET /api/homeappliances/B/status",
      failResult(429),
    );
    expect(ctx.i.restBlockedUntil).toBe(long);
  });

  it("C9: a request queued for its slot does not go out after a 429 armed the pause", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValueOnce(failResult(429, { retryAfterMs: 60_000 }));
    await Promise.all([ctx.i.apiGet("/api/homeappliances/A/status"), ctx.i.apiGet("/api/homeappliances/B/status")]);
    expect(httpMock.getJson).toHaveBeenCalledTimes(1);
  });

  it("C10: a 429 on the connection test pauses REST like on every other path", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValueOnce(failResult(429, { retryAfterMs: 30_000 }));
    await ctx.i.checkConnection();
    expect(ctx.i.restBlockedUntil).toBeGreaterThan(Date.now() + 25_000);
  });

  it("F17: a 429 on the event stream pauses REST too (one daily quota)", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    await ctx.auths[0].port.onSignedIn();
    (ctx.streams[0].deps.onRateLimited as (ms: number) => void)(120_000);
    expect(ctx.i.restBlockedUntil).toBeGreaterThan(Date.now() + 115_000);
  });
});

describe("Homeconnect findings of the 2026-09-24 audit (refused reads)", () => {
  it("B13: books a read refused for good (4xx) with the sync, not a transient failure", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.getJson.mockResolvedValueOnce(failResult(400, { error: "SDK.Error.InvalidSettingKey" }));
    await ctx.i.apiGet("/api/homeappliances/HA/settings/X");
    expect(ctx.syncs[0].noteRefused).toHaveBeenCalledWith("/api/homeappliances/HA/settings/X");
    ctx.syncs[0].noteRefused.mockClear();
    for (const status of [503, 429, 401, 0]) {
      httpMock.getJson.mockResolvedValueOnce(failResult(status));
      await ctx.i.apiGet("/api/homeappliances/HA/settings/Y");
    }
    expect(ctx.syncs[0].noteRefused).not.toHaveBeenCalled();
  });
});

describe("Homeconnect findings of the 2026-09-24 audit (write path and connection test)", () => {
  const req: WriteRequest = { method: "PUT", path: "/api/homeappliances/HA/settings/X", body: { key: "X", value: 1 } };

  it("C10: the connection test takes its slot in the 10/s spacing like every other request", async () => {
    vi.useFakeTimers();
    try {
      const ctx = setup();
      await ctx.i.onReady();
      httpMock.getJson.mockResolvedValue(okResult({ homeappliances: [] }));
      const first = ctx.i.apiGet("/api/a");
      const test = ctx.i.checkConnection();
      await vi.advanceTimersByTimeAsync(0);
      expect(httpMock.getJson).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(99);
      expect(httpMock.getJson).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(httpMock.getJson).toHaveBeenCalledTimes(2);
      await Promise.all([first, test]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("C9: a write queued for its slot does not go out after a 429 armed the pause", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.putJson.mockResolvedValueOnce(failResult(429, { retryAfterMs: 60_000 }));
    await Promise.all([ctx.i.apiWrite(req), ctx.i.apiWrite({ ...req, path: "/api/homeappliances/HA/settings/Y" })]);
    expect(httpMock.putJson).toHaveBeenCalledTimes(1);
  });

  it("C12: a write's 401 after someone else already refreshed retries with the new token", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    httpMock.putJson.mockImplementationOnce(() => {
      ctx.auths[0].accessToken = "AT2";
      return Promise.resolve(failResult(401));
    });
    httpMock.putJson.mockResolvedValueOnce(okResult());
    await ctx.i.apiWrite(req);
    expect(ctx.auths[0].refreshNow).not.toHaveBeenCalled();
    expect(httpMock.putJson.mock.calls.at(-1)?.[2]).toBe("AT2");
  });

  it("a write after the teardown began is neither sent nor reported as a missing sign-in", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    ctx.i.onUnload(() => undefined);
    ctx.auths[0].accessToken = undefined;
    await expect(ctx.i.apiWrite(req)).resolves.toBeUndefined();
    expect(httpMock.putJson).not.toHaveBeenCalled();
    expect(ctx.i.log.warn).not.toHaveBeenCalledWith(expect.stringContaining("not signed in"));
    expect(ctx.i.log.debug).not.toHaveBeenCalledWith(expect.stringContaining("not signed in"));
  });
});

describe("Homeconnect writes an object only when it changes (tooling round 61)", () => {
  /**
   * The ids of the objects extendObject was called for.
   *
   * @param ctx the test context
   * @returns the ids, in call order
   */
  function extended(ctx: Ctx): string[] {
    return ctx.i.extendObject.mock.calls.map(c => String(c[0]));
  }

  it("leaves a manifest object alone when it already carries its texts", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // js-controller extends every manifest object before onReady — on the next start the texts are there.
    await ctx.i.readOwnObjects();
    ctx.i.extendObject.mockClear();
    await ctx.i.refreshManifestObjects();
    expect(extended(ctx)).toEqual([]);
  });

  it("removes the objects without an object type it finds at the start, and nothing else (decision 48)", async () => {
    const ctx = setup();
    // What an earlier version left under an appliance's former id: an object another writer created by
    // extending an id that did not exist — no type, no name.
    ctx.i.objects.set("wm-05.settings.powerState", { common: {}, from: "system.adapter.other.0" });
    ctx.i.objects.set("wm-1", { type: "device", common: { name: "Wm" }, native: {} });
    ctx.i.objects.set("wm-1.settings.powerState", { type: "state", common: { name: "Power" }, native: {} });
    await ctx.i.onReady();
    expect(ctx.i.objects.has("wm-05.settings.powerState")).toBe(false);
    expect(ctx.i.objects.has("wm-1")).toBe(true);
    expect(ctx.i.objects.has("wm-1.settings.powerState")).toBe(true);
    expect(ctx.i.log.info).toHaveBeenCalledWith("Removed 1 leftover object(s) without an object type.");
    // A start with nothing left over says nothing.
    const again = setup();
    again.i.objects.set("wm-1", { type: "device", common: { name: "Wm" }, native: {} });
    await again.i.onReady();
    expect(again.i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("leftover"));
  });

  it("writes the one manifest object whose text differs", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    (ctx.i.objects.get("info.connection") as { common: Record<string, unknown> }).common.name = { en: "Old name" };
    await ctx.i.readOwnObjects();
    ctx.i.extendObject.mockClear();
    await ctx.i.refreshManifestObjects();
    expect(extended(ctx)).toEqual(["info.connection"]);
  });

  it("gives the appliance sync a write that is left out when it would change nothing", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      extendObject(id: string, obj: Record<string, unknown>): Promise<unknown>;
    };
    const channel = { type: "channel", common: { name: "Status" }, native: {} };
    await port.extendObject("wm-1.status", channel);
    await port.extendObject("wm-1.status", structuredClone(channel));
    expect(extended(ctx).filter(id => id === "wm-1.status")).toHaveLength(1);
    await port.extendObject("wm-1.status", { common: { name: "State" } });
    expect(extended(ctx).filter(id => id === "wm-1.status")).toHaveLength(2);
  });

  it("writes an object again after the sync deleted it", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      extendObject(id: string, obj: Record<string, unknown>): Promise<unknown>;
      delObject(id: string): Promise<unknown>;
      delObjectRecursive(id: string): Promise<unknown>;
    };
    const state = { type: "state", common: { name: "Door" }, native: {} };
    await port.extendObject("wm-1.status.door", state);
    await port.delObject("wm-1.status.door");
    await port.extendObject("wm-1.status.door", structuredClone(state));
    await port.delObjectRecursive("wm-1");
    await port.extendObject("wm-1.status.door", structuredClone(state));
    expect(extended(ctx).filter(id => id === "wm-1.status.door")).toHaveLength(3);
    expect(ctx.i.objects.get("wm-1.status.door")).toBeDefined();
  });

  it("leaves out an unchanged foreign-call write to an own object, never one to a room or an alias", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      extendForeignObject(id: string, patch: Record<string, unknown>): Promise<unknown>;
      setForeignObject(id: string, obj: Record<string, unknown>): Promise<unknown>;
    };
    const foreignWrites = ctx.i.extendForeignObjectAsync;
    const custom = { common: { custom: { "influxdb.0": { enabled: true } } } };
    await port.setForeignObject("homeconnect.0.wm-1.status.door", {
      type: "state",
      common: { name: "Door" },
      native: {},
    });
    await port.extendForeignObject("homeconnect.0.wm-1.status.door", custom);
    await port.extendForeignObject("homeconnect.0.wm-1.status.door", structuredClone(custom));
    // The object written whole is held too: the same name again is no write.
    await port.extendForeignObject("homeconnect.0.wm-1.status.door", { common: { name: "Door" } });
    const members = { common: { members: ["homeconnect.0.wm-1.status.door"] } };
    await port.extendForeignObject("enum.rooms.kitchen", members);
    await port.extendForeignObject("enum.rooms.kitchen", structuredClone(members));
    expect(foreignWrites.mock.calls.map(c => String(c[0]))).toEqual([
      "homeconnect.0.wm-1.status.door",
      "enum.rooms.kitchen",
      "enum.rooms.kitchen",
    ]);
  });

  it("never lets a written alias make an own object of the same path look written", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      extendObject(id: string, obj: Record<string, unknown>): Promise<unknown>;
      setForeignObject(id: string, obj: Record<string, unknown>): Promise<unknown>;
    };
    const door = { type: "state", common: { name: "Door" }, native: {} };
    await port.setForeignObject("alias.0.kitchen.door", door);
    await port.extendObject("alias.0.kitchen.door", structuredClone(door));
    expect(extended(ctx)).toContain("alias.0.kitchen.door");
  });

  it("writes an object again after its tree was deleted carrying rooms and functions", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      extendObject(id: string, obj: Record<string, unknown>): Promise<unknown>;
      deleteTreeCarryingEnums(root: string, carry: ReadonlyMap<string, readonly string[]>): Promise<number>;
    };
    const state = { type: "state", common: { name: "Door" }, native: {} };
    await port.extendObject("old-1.status.door", state);
    await port.deleteTreeCarryingEnums("old-1", new Map());
    await port.extendObject("old-1.status.door", structuredClone(state));
    expect(extended(ctx).filter(id => id === "old-1.status.door")).toHaveLength(2);
  });

  it("compares a read-only state in memory and writes it only on a change", async () => {
    const ctx = setup();
    ctx.i.objects.set("wm-1.status.running", { type: "state", common: { write: false }, native: {} });
    ctx.i.states.set("wm-1.status.running", { val: false, ack: true });
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      setStateChanged(id: string, state: Record<string, unknown>): Promise<unknown>;
    };
    ctx.i.setState.mockClear();
    ctx.i.setStateChangedAsync.mockClear();
    await port.setStateChanged("wm-1.status.running", { val: false, ack: true });
    await port.setStateChanged("wm-1.status.running", { val: true, ack: true });
    await port.setStateChanged("wm-1.status.running", { val: true, ack: true });
    // Never read back from the database: no setStateChangedAsync, one write for the one change.
    expect(ctx.i.setStateChangedAsync).not.toHaveBeenCalled();
    expect(ctx.i.setState.mock.calls.map(c => [c[0], (c[1] as { val: unknown }).val])).toEqual([
      ["wm-1.status.running", true],
    ]);
  });

  it("leaves a writable state to setStateChangedAsync, whose database compare sees a user's write", async () => {
    const ctx = setup();
    ctx.i.objects.set("wm-1.settings.power", { type: "state", common: { write: true }, native: {} });
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      setStateChanged(id: string, state: Record<string, unknown>): Promise<unknown>;
    };
    ctx.i.setStateChangedAsync.mockClear();
    await port.setStateChanged("wm-1.settings.power", { val: "on", ack: true });
    expect(ctx.i.setStateChangedAsync).toHaveBeenCalledWith("wm-1.settings.power", { val: "on", ack: true });
  });

  it("writes a read-only state again after the sync deleted it", async () => {
    const ctx = setup();
    const state = { type: "state", common: { write: false }, native: {} };
    ctx.i.objects.set("wm-1.status.running", state);
    ctx.i.objects.set("wm-2.status.running", structuredClone(state));
    ctx.i.objects.set("wm-3.status.running", structuredClone(state));
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      setStateChanged(id: string, state: Record<string, unknown>): Promise<unknown>;
      delObject(id: string): Promise<unknown>;
      delObjectRecursive(id: string): Promise<unknown>;
      deleteTreeCarryingEnums(root: string, carry: ReadonlyMap<string, readonly string[]>): Promise<number>;
      extendObject(id: string, obj: Record<string, unknown>): Promise<unknown>;
    };
    for (const id of ["wm-1.status.running", "wm-2.status.running", "wm-3.status.running"]) {
      await port.setStateChanged(id, { val: true, ack: true });
    }
    await port.delObject("wm-1.status.running");
    await port.delObjectRecursive("wm-2");
    await port.deleteTreeCarryingEnums("wm-3", new Map());
    ctx.i.setState.mockClear();
    for (const id of ["wm-1.status.running", "wm-2.status.running", "wm-3.status.running"]) {
      await port.extendObject(id, structuredClone(state));
      await port.setStateChanged(id, { val: true, ack: true });
    }
    expect(ctx.i.setState.mock.calls.map(c => c[0])).toEqual([
      "wm-1.status.running",
      "wm-2.status.running",
      "wm-3.status.running",
    ]);
  });

  it("writes a read-only state when the own states could not be read", async () => {
    const ctx = setup();
    ctx.i.objects.set("wm-1.status.running", { type: "state", common: { write: false }, native: {} });
    ctx.i.states.set("wm-1.status.running", { val: true, ack: true });
    ctx.i.getStatesAsync.mockImplementation(() => Promise.reject(new Error("states db down")));
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      setStateChanged(id: string, state: Record<string, unknown>): Promise<unknown>;
    };
    ctx.i.setState.mockClear();
    await port.setStateChanged("wm-1.status.running", { val: true, ack: true });
    expect(ctx.i.setState).toHaveBeenCalledTimes(1);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Could not read the own states"));
  });

  it("holds a value moved to a new id, and one written every time", async () => {
    const ctx = setup();
    ctx.i.objects.set("wm-1.status.running", { type: "state", common: { write: false }, native: {} });
    ctx.i.objects.set("wm-1.status.remaining", { type: "state", common: { write: false }, native: {} });
    await ctx.i.onReady();
    const port = ctx.syncs[0].port as unknown as {
      setStateChanged(id: string, state: Record<string, unknown>): Promise<unknown>;
      setState(id: string, state: Record<string, unknown>): Promise<unknown>;
      setForeignState(id: string, state: Record<string, unknown>): Promise<unknown>;
    };
    await port.setForeignState("homeconnect.0.wm-1.status.running", { val: true, ack: true });
    await port.setState("wm-1.status.remaining", { val: 30, ack: true });
    ctx.i.setState.mockClear();
    await port.setStateChanged("wm-1.status.running", { val: true, ack: true });
    await port.setStateChanged("wm-1.status.remaining", { val: 30, ack: true });
    expect(ctx.i.setState).not.toHaveBeenCalled();
  });

  it("writes everything when the own tree could not be read", async () => {
    const ctx = setup();
    await ctx.i.onReady();
    // The objects carry their texts, but this start could not read them: nothing may be left out.
    ctx.i.getObjectListAsync.mockImplementation(() => Promise.reject(new Error("objects db down")));
    await ctx.i.readOwnObjects();
    ctx.i.extendObject.mockClear();
    await ctx.i.refreshManifestObjects();
    expect(extended(ctx)).toHaveLength(10);
    expect(ctx.i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Could not read the own objects"));
  });
});
