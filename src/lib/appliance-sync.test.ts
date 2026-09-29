import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vi, describe, it, expect, beforeEach } from "vitest";

// adapter-core's I18n needs init() with a real adapter; the tests feed it the
// shipped admin/i18n files directly, so translated names are the real ones.
vi.mock("@iobroker/adapter-core", () => {
  const i18nDir = join(__dirname, "../../admin/i18n");
  const i18nData: Record<string, Record<string, string>> = {};
  for (const f of readdirSync(i18nDir).filter(f => f.endsWith(".json"))) {
    i18nData[f.replace(".json", "")] = JSON.parse(readFileSync(join(i18nDir, f), "utf8"));
  }
  const fill = (text: string, args: unknown[]): string =>
    args.reduce<string>((t, a) => t.replace("%s", String(a)), text);
  return {
    I18n: {
      getTranslatedObject: (key: string, ...args: unknown[]) => {
        const result: Record<string, string> = {};
        for (const [lang, translations] of Object.entries(i18nData)) {
          result[lang] = fill(translations[key] ?? key, args);
        }
        return result;
      },
      translate: (key: string, ...args: unknown[]) => fill(i18nData.en?.[key] ?? key, args),
    },
  };
});

import { ApplianceSync, parseAppliancePath, type AdapterPort } from "./appliance-sync";
import { deviceIcon, ICON_URI_PREFIX } from "./device-icons";
import { tName } from "./i18n";
import type { WriteRequest } from "./command-dispatch";
import type { JsonResult } from "./http";

const NS = "homeconnect.0";
const ok: JsonResult = { status: 204, ok: true, data: undefined, error: undefined };

/**
 * The merge js-controller performs on extendObject (node.extend(true, target, source)):
 * plain objects and ARRAYS are merged recursively, `undefined` is not copied,
 * `null` overwrites.
 *
 * @param target the object as it stands in the database
 * @param source the partial update
 * @returns the merged object
 */
function deepExtend(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = Array.isArray(target) ? ([...target] as never) : { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value !== null && (Array.isArray(value) || (typeof value === "object" && value !== undefined))) {
      const base = out[key];
      const seed = Array.isArray(value)
        ? Array.isArray(base)
          ? base
          : []
        : base !== null && typeof base === "object" && !Array.isArray(base)
          ? base
          : {};
      out[key] = deepExtend(seed as Record<string, unknown>, value as Record<string, unknown>);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** A recording in-memory AdapterPort — no adapter, no network. */
class FakePort implements AdapterPort {
  readonly namespace = NS;
  /** The ioBroker system language (undefined = English labels). */
  language: string | undefined = undefined;
  /** Recorded log lines as `level: message`, so "what did the user see" is assertable. */
  readonly logs: string[] = [];
  readonly log = {
    debug: (m: string) => this.logs.push(`debug: ${m}`),
    info: (m: string) => this.logs.push(`info: ${m}`),
    warn: (m: string) => this.logs.push(`warn: ${m}`),
    error: (m: string) => this.logs.push(`error: ${m}`),
    silly: () => {},
  } as unknown as ioBroker.Logger;

  readonly objects = new Map<string, ioBroker.PartialObject>();
  readonly states = new Map<string, ioBroker.StateValue>();
  readonly deleted: string[] = [];
  readonly writes: WriteRequest[] = [];
  readonly getCalls: string[] = [];
  /** Every extendObject id, with repeats — an object must not be rewritten per sync. */
  readonly extendCalls: string[] = [];
  /** Every getState id, with repeats — the start payload must only be read for a start. */
  readonly getStateCalls: string[] = [];
  /** Every state write in order — a button press must produce exactly one. */
  readonly stateWrites: Array<{ id: string; val: ioBroker.StateValue }> = [];

  /** path → unwrapped data; absent ⇒ apiGet resolves undefined (a failure). */
  readonly getResponses = new Map<string, unknown>();
  writeResult: JsonResult | undefined = ok;
  primeDevices: Record<string, ioBroker.Object> = {};
  primeStates: Record<string, ioBroker.Object> = {};
  primeChannels: Record<string, ioBroker.Object> = {};

  extendObject(id: string, obj: ioBroker.PartialObject): Promise<unknown> {
    this.extendCalls.push(id);
    // The real extendObject merges DEEPLY (js-controller 7.2.2 → node.extend(true, …)):
    // objects key by key, arrays element by element, `undefined` is skipped and
    // `null` overwrites. Emulated faithfully — a shallow merge here would hide
    // exactly the stale-entry problem the refresh has to solve.
    const existing = this.objects.get(id) as Record<string, unknown> | undefined;
    this.objects.set(id, existing ? deepExtend(existing, obj as unknown as Record<string, unknown>) : obj);
    return Promise.resolve();
  }
  setState(id: string, state: ioBroker.SettableState): Promise<unknown> {
    const val = (state as { val: ioBroker.StateValue }).val;
    this.stateWrites.push({ id, val });
    this.states.set(id, val);
    return Promise.resolve();
  }
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<unknown> {
    // js-controller writes only when the value actually differs. A fake that
    // always writes cannot tell the two calls apart — and then no test notices
    // when a value write turns into an unconditional one (history churn, a
    // change event on every sync).
    const val = (state as { val: ioBroker.StateValue }).val;
    if (this.states.has(id) && this.states.get(id) === val) {
      return Promise.resolve();
    }
    return this.setState(id, state);
  }
  getState(id: string): Promise<ioBroker.State | null | undefined> {
    this.getStateCalls.push(id);
    return Promise.resolve(this.states.has(id) ? ({ val: this.states.get(id), ack: true } as ioBroker.State) : null);
  }
  getObject(id: string): Promise<ioBroker.Object | null | undefined> {
    // A copy, like the controller hands every read: with the stored object itself,
    // a change the code makes on what it read lands in the store without a write.
    const obj = this.objects.get(id) as ioBroker.Object | undefined;
    return Promise.resolve(obj ? structuredClone(obj) : null);
  }
  /** Objects outside the namespace — aliases (`alias.*`) and rooms/functions (`enum.*`), by full id. */
  readonly foreign = new Map<string, ioBroker.Object>();
  /** Every carry the tree delete was asked for: root → old full id → new full ids. */
  readonly enumCarries: Array<{ root: string; carry: Map<string, string[]> }> = [];

  /**
   * The namespace-relative id of a full id, or undefined for a foreign one.
   *
   * @param id a full id
   * @returns the relative id
   */
  private rel(id: string): string | undefined {
    return id.startsWith(`${NS}.`) ? id.slice(NS.length + 1) : undefined;
  }
  getAdapterObjects(): Promise<Record<string, ioBroker.Object | null | undefined>> {
    return Promise.resolve(
      structuredClone(
        Object.fromEntries([...this.objects].map(([id, obj]) => [`${NS}.${id}`, obj as ioBroker.Object])),
      ),
    );
  }
  getForeignStates(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>> {
    const prefix = this.rel(pattern.replace(/\*$/, "")) ?? "\0";
    const out: Record<string, ioBroker.State> = {};
    for (const [id, val] of this.states) {
      if (id.startsWith(prefix)) {
        out[`${NS}.${id}`] = { val, ack: true, ...(this.stateMeta.get(id) ?? {}) } as ioBroker.State;
      }
    }
    return Promise.resolve(out);
  }
  /** Timestamps and quality of stored values, by relative id — a move must carry them. */
  readonly stateMeta = new Map<string, { ts?: number; lc?: number; q?: number }>();
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown> {
    const rel = this.rel(id);
    if (rel === undefined) {
      this.foreign.set(id, structuredClone(obj) as ioBroker.Object);
      return Promise.resolve();
    }
    this.extendCalls.push(rel);
    this.objects.set(rel, structuredClone(obj));
    return Promise.resolve();
  }
  extendForeignObject(id: string, patch: ioBroker.PartialObject): Promise<unknown> {
    const rel = this.rel(id);
    if (rel === undefined) {
      const existing = this.foreign.get(id) as Record<string, unknown> | undefined;
      this.foreign.set(id, deepExtend(existing ?? {}, patch as Record<string, unknown>) as unknown as ioBroker.Object);
      return Promise.resolve();
    }
    return this.extendObject(rel, patch);
  }
  setForeignState(id: string, state: ioBroker.SettableState): Promise<unknown> {
    const rel = this.rel(id) ?? id;
    const { ts, lc, q } = state as { ts?: number; lc?: number; q?: number };
    if (ts !== undefined || lc !== undefined || q !== undefined) {
      this.stateMeta.set(rel, { ts, lc, q });
    }
    return this.setState(rel, state);
  }
  getAliases(): Promise<Record<string, ioBroker.Object | null | undefined>> {
    return Promise.resolve(
      structuredClone(Object.fromEntries([...this.foreign].filter(([id]) => id.startsWith("alias.")))),
    );
  }
  getEnums(): Promise<Record<string, unknown>> {
    return Promise.resolve(
      structuredClone(Object.fromEntries([...this.foreign].filter(([id]) => id.startsWith("enum.")))),
    );
  }
  /**
   * What main does through the fleet helper, as its outcome: the tree is gone, and every room or
   * function that listed an old id lists its new ids instead.
   *
   * @param root the relative root to delete
   * @param carry old full id → new full ids
   * @returns how many room/function entries now list a new id
   */
  async deleteTreeCarryingEnums(root: string, carry: ReadonlyMap<string, readonly string[]>): Promise<number> {
    this.enumCarries.push({ root, carry: new Map([...carry].map(([k, v]) => [k, [...v]])) });
    const rootFull = `${NS}.${root}`;
    await this.delObjectRecursive(root);
    let carried = 0;
    for (const [enumId, obj] of this.foreign) {
      const members = (obj.common as { members?: string[] }).members;
      if (!enumId.startsWith("enum.") || !Array.isArray(members)) {
        continue;
      }
      const next: string[] = [];
      for (const member of members) {
        if (member === rootFull || member.startsWith(`${rootFull}.`)) {
          for (const moved of carry.get(member) ?? []) {
            next.push(moved);
            carried++;
          }
        } else {
          next.push(member);
        }
      }
      (obj.common as { members?: string[] }).members = next;
    }
    return carried;
  }
  delObject(id: string): Promise<void> {
    this.deleted.push(id);
    this.objects.delete(id);
    this.states.delete(id);
    return Promise.resolve();
  }
  delObjectRecursive(id: string): Promise<void> {
    this.deleted.push(id);
    for (const map of [this.objects, this.states] as Map<string, unknown>[]) {
      for (const key of [...map.keys()]) {
        if (key === id || key.startsWith(`${id}.`)) {
          map.delete(key);
        }
      }
    }
    return Promise.resolve();
  }
  getForeignObjects(_pattern: string, type: "state" | "device" | "channel"): Promise<Record<string, ioBroker.Object>> {
    return Promise.resolve(
      structuredClone(
        type === "device" ? this.primeDevices : type === "channel" ? this.primeChannels : this.primeStates,
      ),
    );
  }
  /** The sync under test — the transport reports classified appliance answers back to it, like main does. */
  sync: ApplianceSync | undefined;
  /** Paths Home Connect answers with `SDK.Error.UnsupportedProgram`. */
  readonly unsupportedPaths = new Set<string>();
  /** Paths Home Connect answers with `SDK.Error.HomeAppliance.Connection.Initialization.Failed`. */
  readonly notReadyPaths = new Set<string>();
  /** Paths Home Connect refuses for good (a 4xx that is no appliance state). */
  readonly refusedPaths = new Set<string>();
  /** Managed timers, driven by hand ({@link fire}). */
  readonly timers: Array<{ cb: () => void; ms: number; cleared: boolean; fired: boolean }> = [];

  /** Called on every GET before it answers — lets a test interleave a stop with a read in flight. */
  onGet: ((path: string) => void) | undefined;

  apiGet(path: string): Promise<unknown> {
    this.getCalls.push(path);
    this.onGet?.(path);
    if (this.unsupportedPaths.has(path)) {
      this.sync?.noteUnsupportedProgram(path);
      return Promise.resolve(undefined);
    }
    if (this.notReadyPaths.has(path)) {
      this.sync?.noteNotReady(path);
      return Promise.resolve(undefined);
    }
    if (this.refusedPaths.has(path)) {
      this.sync?.noteRefused(path);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(this.getResponses.get(path));
  }
  setTimer(cb: () => void, ms: number): unknown {
    const timer = { cb, ms, cleared: false, fired: false };
    this.timers.push(timer);
    return timer;
  }
  clearTimer(handle: unknown): void {
    (handle as { cleared: boolean }).cleared = true;
  }
  /** Timers armed and neither cleared nor fired yet. */
  pendingTimers(): Array<{ cb: () => void; ms: number; cleared: boolean; fired: boolean }> {
    return this.timers.filter(t => !t.cleared && !t.fired);
  }
  /** Fire every pending timer once, as the host would. */
  fire(): void {
    for (const t of this.pendingTimers()) {
      t.fired = true;
      t.cb();
    }
  }
  apiWrite(req: WriteRequest): Promise<JsonResult | undefined> {
    this.writes.push(req);
    return Promise.resolve(this.writeResult);
  }
}

/** Let the fire-and-forget stream/write chains settle. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

/**
 * Configure the endpoints one connected appliance's full sync hits.
 *
 * @param port Fake adapter port whose HTTP answers are primed
 * @param haId Home Connect appliance id
 * @param name Appliance name as the account lists it
 * @param parts Per-endpoint answers, each optional
 * @param parts.connected Whether the appliance reports as connected
 * @param parts.status Status endpoint payload
 * @param parts.settings Settings endpoint payload
 * @param parts.available Available programs endpoint payload
 * @param parts.commands Commands endpoint payload
 * @param parts.type Appliance type
 * @param parts.enumber E-number (model designation)
 * @param parts.vib VIB code
 */
function appliance(
  port: FakePort,
  haId: string,
  name: string,
  parts: {
    connected?: boolean;
    status?: unknown[];
    settings?: unknown[];
    available?: string[];
    commands?: unknown[];
    /** The appliance type (drives catalog events, door form, programs). */
    type?: string;
    /** Type-plate E-number (model part of the device id without a model code). Defaults to the name, so the fixture ids read `<name>-<haId tail>`; "" ⇒ absent. */
    enumber?: string;
    /** Model code fallback. */
    vib?: string;
  } = {},
): void {
  const base = `/api/homeappliances/${haId}`;
  const list =
    (port.getResponses.get("/api/homeappliances") as { homeappliances: unknown[] } | undefined)?.homeappliances ?? [];
  port.getResponses.set("/api/homeappliances", {
    homeappliances: [
      ...list,
      {
        haId,
        name,
        connected: parts.connected ?? true,
        type: parts.type ?? "Dishwasher",
        enumber: parts.enumber ?? name,
        vib: parts.vib,
      },
    ],
  });
  if (parts.status !== undefined) {
    port.getResponses.set(`${base}/status`, { status: parts.status });
  }
  if (parts.settings !== undefined) {
    port.getResponses.set(`${base}/settings`, { settings: parts.settings });
  }
  port.getResponses.set(`${base}/programs/available`, { programs: (parts.available ?? []).map(key => ({ key })) });
  port.getResponses.set(`${base}/programs/selected`, {});
  port.getResponses.set(`${base}/programs/active`, {});
  if (parts.commands !== undefined) {
    port.getResponses.set(`${base}/commands`, { commands: parts.commands });
  }
}

describe("ApplianceSync.syncAppliances", () => {
  let port: FakePort;
  let sync: ApplianceSync;
  beforeEach(() => {
    port = new FakePort();
    sync = new ApplianceSync(port);
  });

  it("does not arm the option gate when no program is selected", async () => {
    // An appliance with nothing selected reports an empty /programs/selected.
    // Arming with that empty key would fetch a definition for "" (a request that
    // can only fail) and set the write gate to an EMPTY set — every option write
    // would then be refused until something re-armed it.
    appliance(port, "HA-1", "Geschirrspüler", { status: [] });
    await sync.syncAppliances();

    const badFetch = port.getCalls.filter(p => p.includes("/programs/available/") && p.endsWith("/"));
    expect(badFetch).toEqual([]);
    expect(port.getCalls).not.toContain("/homeappliances/HA-1/programs/available/");
  });

  it("refreshes the label of a command button that already exists", async () => {
    // A button from an older version carries a stale name. The sync must patch the
    // label instead of leaving the known object alone (mutation A23, 2026-09-08).
    const id = "geschirrspueler.commands.pauseProgram";
    const stale = {
      _id: "",
      type: "state",
      common: { name: "Old label", type: "boolean", role: "button", read: false, write: true },
      native: { bshKey: "BSH.Common.Command.PauseProgram" },
    } as unknown as ioBroker.Object;
    port.primeDevices = {
      [`${NS}.geschirrspueler`]: {
        _id: "",
        type: "device",
        common: {},
        native: { haId: "HA-1" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = { [`${NS}.${id}`]: stale };
    port.objects.set(id, stale);
    await sync.primeFromObjects();

    appliance(port, "HA-1", "Geschirrspüler", {
      commands: [{ key: "BSH.Common.Command.PauseProgram", name: "Pause program" }],
    });
    await sync.syncAppliances();

    expect(port.extendCalls).toContain(id);
    // Our own translated name, not the cloud's single-language one.
    expect(port.objects.get(id)?.common?.name).toEqual(tName("cmdPauseProgram"));
  });

  it("writes a value only when it actually changed", async () => {
    // setStateChanged, not setState: an unchanged value written on every sync
    // fills the history and fires a change event each time.
    appliance(port, "HA-1", "Geschirrspüler", {
      status: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Closed" }],
    });
    await sync.syncAppliances();
    const first = port.stateWrites.filter(w => w.id.endsWith("status.doorOpen")).length;
    expect(first).toBe(1);

    port.stateWrites.length = 0;
    await sync.syncAppliances();
    expect(port.stateWrites.filter(w => w.id.endsWith("status.doorOpen"))).toEqual([]);
  });

  it("builds a speaking device tree with idiomatic values", async () => {
    appliance(port, "HA-1", "Geschirrspüler", {
      status: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" }],
      settings: [{ key: "BSH.Common.Setting.ChildLock", value: false }],
    });
    await sync.syncAppliances();

    expect(port.objects.has("geschirrspueler-1")).toBe(true);
    expect(port.objects.get("geschirrspueler-1")?.type).toBe("device");
    // The door is a proper boolean, not enum text (design principle: idiomatic types).
    expect(port.states.get("geschirrspueler-1.status.doorOpen")).toBe(true);
    expect(port.objects.get("geschirrspueler-1.status.doorOpen")?.common).toMatchObject({ type: "boolean" });
    // A dishwasher's door does not lock — no doorLocked state for this type.
    expect(port.objects.has("geschirrspueler-1.status.doorLocked")).toBe(false);
    expect(port.objects.get("geschirrspueler-1.settings.childLock")?.common).toMatchObject({ write: true });
  });

  it("creates the catalog events of the type upfront — even for a switched-off appliance", async () => {
    appliance(port, "HA-1", "Geschirrspüler", { connected: false });
    await sync.syncAppliances();
    // Dishwasher catalog: the event exists with false BEFORE it ever fires.
    expect(port.states.get("geschirrspueler-1.events.saltNearlyEmpty")).toBe(false);
    expect(port.states.get("geschirrspueler-1.events.programAborted")).toBe(false);
    expect(port.objects.get("geschirrspueler-1.events.programFinished")?.common).toMatchObject({ type: "boolean" });
  });

  it("derives the boolean programRunning from the operation state", async () => {
    appliance(port, "HA-1", "Waschtrockner", {
      type: "WasherDryer",
      status: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" }],
    });
    await sync.syncAppliances();
    expect(port.states.get("waschtrockner-1.status.operationState")).toBe("run");
    expect(port.states.get("waschtrockner-1.status.programRunning")).toBe(true);
  });

  it("gives a lockable-door type doorOpen AND doorLocked", async () => {
    appliance(port, "HA-1", "Waschtrockner", {
      type: "WasherDryer",
      status: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Locked" }],
    });
    await sync.syncAppliances();
    expect(port.states.get("waschtrockner-1.status.doorOpen")).toBe(false);
    expect(port.states.get("waschtrockner-1.status.doorLocked")).toBe(true);
  });

  it("routes nested BSH keys into their real channel instead of misc", async () => {
    appliance(port, "HA-1", "Kühlschrank", {
      type: "FridgeFreezer",
      status: [{ key: "Refrigeration.Common.Status.Door.Freezer", value: "BSH.Common.EnumType.DoorState.Open" }],
      settings: [{ key: "Refrigeration.Common.Setting.Light.Internal.Brightness", value: 70, unit: "%" }],
    });
    await sync.syncAppliances();
    // Per-compartment door → a speaking boolean under status, not "misc.freezer".
    expect(port.states.get("kuehlschrank-1.status.doorFreezerOpen")).toBe(true);
    // A nested setting lands under settings and is writable.
    expect(port.states.get("kuehlschrank-1.settings.lightInternalBrightness")).toBe(70);
    expect(port.objects.get("kuehlschrank-1.settings.lightInternalBrightness")?.common).toMatchObject({ write: true });
    expect([...port.objects.keys()].some(k => k.includes(".misc."))).toBe(false);
  });

  it("creates no programs channel for a program-less appliance type", async () => {
    appliance(port, "HA-1", "Kühlschrank", { type: "FridgeFreezer", status: [], settings: [] });
    await sync.syncAppliances();
    expect([...port.objects.keys()].some(k => k.startsWith("kuehlschrank-1.programs"))).toBe(false);
  });

  it("creates each object once — a repeated item only updates the value", async () => {
    appliance(port, "HA-1", "Oven", {
      status: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Ready" }],
    });
    await sync.syncAppliances();
    port.objects.clear(); // if applyBshItem re-extended, the object would reappear
    await sync.syncAppliances();
    expect(port.objects.has("oven-1.status.operationState")).toBe(false);
    expect(port.states.get("oven-1.status.operationState")).toBe("ready");
  });

  it("gives two appliances of one model two trees, each named by its own number", async () => {
    appliance(port, "HA-AAAA1111", "Geschirrspüler", { status: [] });
    appliance(port, "HA-BBBB2222", "Geschirrspüler", { status: [] });
    await sync.syncAppliances();
    expect(port.objects.has("geschirrspueler-1111")).toBe(true);
    expect(port.objects.has("geschirrspueler-2222")).toBe(true);
  });

  it("gives start/stop buttons only to an appliance that has programs", async () => {
    appliance(port, "HA-FRIDGE", "Fridge", { status: [], available: [] });
    appliance(port, "HA-WASHER", "Washer", { status: [], available: ["LaundryCare.Washer.Program.Cotton"] });
    await sync.syncAppliances();
    expect(port.objects.has("fridge-idge.programs.start")).toBe(false);
    expect(port.objects.has("washer-sher.programs.start")).toBe(true);
  });
});

describe("ApplianceSync datapoint persistence", () => {
  let port: FakePort;
  let sync: ApplianceSync;
  beforeEach(() => {
    port = new FakePort();
    sync = new ApplianceSync(port);
  });

  it("keeps a state that a later, reduced response no longer carries", async () => {
    // The cloud reports a state-dependent SUBSET: a switched-off washer in
    // network standby answers with powerState only. That must never delete
    // anything (the childLock finding, 2026-09-01).
    appliance(port, "HA-1", "Waschtrockner", {
      type: "WasherDryer",
      settings: [
        { key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.On" },
        { key: "BSH.Common.Setting.ChildLock", value: false },
      ],
    });
    await sync.syncAppliances();
    expect(port.objects.has("waschtrockner-1.settings.childLock")).toBe(true);

    // Standby re-sync: only powerState comes back.
    port.getResponses.set("/api/homeappliances/HA-1/settings", {
      settings: [{ key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.Off" }],
    });
    await sync.syncAppliances();
    expect(port.deleted).not.toContain("waschtrockner-1.settings.childLock");
    expect(port.objects.has("waschtrockner-1.settings.childLock")).toBe(true);
  });

  it("keeps every state when the status GET fails entirely", async () => {
    appliance(port, "HA-1", "Oven", {
      type: "Oven",
      status: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" }],
    });
    await sync.syncAppliances();
    // Make the status GET fail (undefined).
    port.getResponses.delete("/api/homeappliances/HA-1/status");
    await sync.syncAppliances();
    expect(port.deleted).not.toContain("oven-1.status.doorOpen");
    expect(port.objects.has("oven-1.status.doorOpen")).toBe(true);
  });
});

describe("ApplianceSync.primeFromObjects + write after a restart-while-offline", () => {
  it("routes a settings write for an appliance that never synced this run", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.dishwasher`]: {
        _id: `${NS}.dishwasher`,
        type: "device",
        common: { name: "Dishwasher" },
        native: { haId: "HA-1" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.dishwasher.settings.powerState`]: {
        _id: `${NS}.dishwasher.settings.powerState`,
        type: "state",
        common: { name: "powerState", type: "string", role: "text", read: true, write: true },
        native: {
          bshKey: "BSH.Common.Setting.PowerState",
          bshValues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Off"],
        },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.dishwasher.settings.powerState`, "off");
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0]).toMatchObject({
      method: "PUT",
      path: "/api/homeappliances/HA-1/settings/BSH.Common.Setting.PowerState",
      body: { value: "BSH.Common.EnumType.PowerState.Off" },
    });
  });

  it("primes writable options into the start-payload set but not read-only display options", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: {
        _id: "",
        type: "device",
        common: { name: "Washer" },
        native: { haId: "HA-2" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.washer.options.spinSpeed`]: {
        _id: "",
        type: "state",
        common: { name: "spinSpeed", type: "string", role: "text", read: true, write: true },
        native: {
          bshKey: "LaundryCare.Washer.Option.SpinSpeed",
          bshValues: ["LaundryCare.Washer.EnumType.SpinSpeed.RPM1200"],
        },
      } as unknown as ioBroker.Object,
      [`${NS}.washer.options.remainingProgramTime`]: {
        _id: "",
        type: "state",
        common: { name: "remainingProgramTime", type: "number", role: "value", read: true, write: false },
        native: { bshKey: "BSH.Common.Option.RemainingProgramTime" },
      } as unknown as ioBroker.Object,
    };
    // setState/getState use namespace-relative ids (like the adapter).
    port.states.set("washer.options.spinSpeed", "rpm1200");
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    // Start the (selected) program → only the writable option is collected.
    port.states.set("washer.programs.selectedProgram", "cotton");
    // selectedProgram meta needs bshValues to resolve; prime it too.
    port.primeStates[`${NS}.washer.programs.selectedProgram`] = {
      _id: "",
      type: "state",
      common: { write: true },
      native: { bshKey: "BSH.Common.Root.SelectedProgram", bshValues: ["LaundryCare.Washer.Program.Cotton"] },
    } as unknown as ioBroker.Object;
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.washer.programs.start`, true);
    expect(port.writes).toHaveLength(1);
    expect(port.writes[0].body?.options).toEqual([
      { key: "LaundryCare.Washer.Option.SpinSpeed", value: "LaundryCare.Washer.EnumType.SpinSpeed.RPM1200" },
    ]);
  });
});

describe("ApplianceSync.handleWrite", () => {
  it("resets a momentary command button to false after firing it", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.oven`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.oven.commands.pauseProgram`]: {
        _id: "",
        type: "state",
        common: { type: "boolean", role: "button", read: false, write: true },
        native: { bshKey: "BSH.Common.Command.PauseProgram" },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.oven.commands.pauseProgram`, true);
    expect(port.writes[0]).toMatchObject({
      method: "PUT",
      path: "/api/homeappliances/HA-1/commands/BSH.Common.Command.PauseProgram",
    });
    expect(port.states.get("oven.commands.pauseProgram")).toBe(false);
  });

  it("ignores a write to an unknown device", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    await sync.handleWrite(`${NS}.ghost.settings.x`, true);
    expect(port.writes).toHaveLength(0);
  });
});

describe("ApplianceSync.handleStreamEvent", () => {
  it("applies NOTIFY items to a known device's states", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Oven", { status: [] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();

    sync.handleStreamEvent({
      event: "NOTIFY",
      id: "HA-1",
      data: JSON.stringify({
        items: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Closed" }],
      }),
    });
    await flush();
    expect(port.states.get("oven-1.status.doorOpen")).toBe(false);
  });

  it("fetches only the affected appliance on a CONNECTED for an unknown haId", async () => {
    const port = new FakePort();
    port.getResponses.set("/api/homeappliances/HA-NEW", { haId: "HA-NEW", name: "New Oven", connected: false });
    const sync = new ApplianceSync(port);

    sync.handleStreamEvent({ event: "CONNECTED", id: "HA-NEW", data: "{}" });
    await flush();
    expect(port.getCalls).toContain("/api/homeappliances/HA-NEW");
    expect(port.getCalls).not.toContain("/api/homeappliances");
  });

  it("prefers the payload haId over a stale SSE id (SSE ids persist across events)", async () => {
    const port = new FakePort();
    appliance(port, "HA-OVEN", "Oven", { status: [] });
    appliance(port, "HA-WASHER", "Washer", { status: [] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();

    // The SSE parser hands down the previous event's id ("HA-OVEN"); the payload names the washer.
    sync.handleStreamEvent({
      event: "NOTIFY",
      id: "HA-OVEN",
      data: JSON.stringify({
        haId: "HA-WASHER",
        items: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" }],
      }),
    });
    await flush();
    expect(port.states.get("washer-sher.status.doorOpen")).toBe(true);
    expect(port.states.has("oven-oven.status.doorOpen")).toBe(false);
  });
});

describe("ApplianceSync reachability", () => {
  it("creates info.reachable from the appliance list's connected flag", async () => {
    const port = new FakePort();
    appliance(port, "HA-ON", "Oven", { status: [] });
    appliance(port, "HA-OFF", "Washer", { status: [], connected: false });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();

    expect(port.objects.get("oven-on.info.reachable")?.common).toMatchObject({ type: "boolean", write: false });
    expect(port.states.get("oven-on.info.reachable")).toBe(true);
    expect(port.states.get("washer-off.info.reachable")).toBe(false);
  });

  it("tracks DISCONNECTED / CONNECTED / DEPAIRED stream events", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Oven", { status: [] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    expect(port.states.get("oven-1.info.reachable")).toBe(true);

    sync.handleStreamEvent({ event: "DISCONNECTED", id: "HA-1", data: "{}" });
    await flush();
    expect(port.states.get("oven-1.info.reachable")).toBe(false);

    sync.handleStreamEvent({ event: "CONNECTED", id: "HA-1", data: "{}" });
    await flush();
    expect(port.states.get("oven-1.info.reachable")).toBe(true);

    sync.handleStreamEvent({ event: "DEPAIRED", id: "HA-1", data: "{}" });
    await flush();
    // Removed from the account — the tree goes with it (see the dedicated tests).
    expect(port.objects.has("oven-1")).toBe(false);
  });

  it("builds the channels of an appliance again when it is paired again in the same run", async () => {
    // Channels are written once a run — a tree deleted meanwhile must not keep that mark.
    const port = new FakePort();
    appliance(port, "HA-1", "Oven", {
      status: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Ready" }],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    expect(port.objects.has("oven-1.status")).toBe(true);
    sync.handleStreamEvent({ event: "DEPAIRED", id: "HA-1", data: "{}" });
    await flush();
    expect(port.objects.has("oven-1.status")).toBe(false);
    sync.handleStreamEvent({ event: "PAIRED", id: "", data: JSON.stringify({ haId: "HA-1" }) });
    await flush();
    expect(port.objects.has("oven-1.status.operationState")).toBe(true);
    expect(port.objects.get("oven-1.status")?.type).toBe("channel");
  });
});

describe("ApplianceSync metadata refresh", () => {
  it("refreshes the selected-program dropdown + candidates when the program list changes", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Dishwasher", { status: [], available: ["Dishcare.Dishwasher.Program.Eco50"] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const before = port.objects.get("dishwasher-1.programs.selectedProgram");
    expect((before?.native as { bshValues: string[] }).bshValues).toEqual(["Dishcare.Dishwasher.Program.Eco50"]);

    // The appliance now reports an additional program (e.g. after a firmware update).
    port.getResponses.set("/api/homeappliances/HA-1/programs/available", {
      programs: [{ key: "Dishcare.Dishwasher.Program.Eco50" }, { key: "Dishcare.Dishwasher.Program.Auto2" }],
    });
    await sync.syncAppliances();

    const after = port.objects.get("dishwasher-1.programs.selectedProgram");
    expect((after?.native as { bshValues: string[] }).bshValues).toEqual([
      "Dishcare.Dishwasher.Program.Eco50",
      "Dishcare.Dishwasher.Program.Auto2",
    ]);
    expect((after?.common as ioBroker.StateCommon).states).toMatchObject({
      eco50: "Eco 50 °C",
      auto2: "Auto 45-65 °C",
    });
  });

  it("does not replace primed objects whose metadata is unchanged (no wave on update)", async () => {
    const port = new FakePort();
    // Objects as a previous adapter run created them (identical to the fresh transform).
    port.primeDevices = {
      [`${NS}.oven`]: {
        _id: "",
        type: "device",
        common: { name: "Oven" },
        native: { haId: "HA-1" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      // Exactly what the current version writes: derived label, BSH key as desc.
      [`${NS}.oven.settings.childLock`]: {
        _id: "",
        type: "state",
        common: {
          name: "Child lock",
          desc: "BSH.Common.Setting.ChildLock",
          type: "boolean",
          role: "switch",
          read: true,
          write: true,
          def: false,
        },
        native: { bshKey: "BSH.Common.Setting.ChildLock", nameSource: "derived" },
      } as unknown as ioBroker.Object,
    };
    appliance(port, "HA-1", "Oven", {
      settings: [{ key: "BSH.Common.Setting.ChildLock", value: false }],
      status: [],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    port.extendCalls.length = 0;
    await sync.syncAppliances();
    // An install already on the current version writes NO object at start —
    // neither a rewrite (the #387 flood: every state rewritten on every start)
    // nor a delete. Only the value is set.
    expect(port.extendCalls).not.toContain("oven.settings.childLock");
    expect(port.deleted).toHaveLength(0);
  });

  it("does not rewrite an unchanged object on a re-sync", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Oven", {
      status: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" }],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    await sync.syncAppliances();
    expect(port.deleted).toHaveLength(0);
  });

  it("puts the adapter's name back over a rename typed in the object browser", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Dishwasher", { status: [], available: ["Dishcare.Dishwasher.Program.Eco50"] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    // Somebody renamed the state in the admin. The adapter owns its datapoints
    // (a user's own datapoints live under 0_userdata) — the next refresh restores it.
    const obj = port.objects.get("dishwasher-1.programs.selectedProgram")!;
    (obj.common as ioBroker.StateCommon).name = "Mein Programm";

    port.getResponses.set("/api/homeappliances/HA-1/programs/available", {
      programs: [{ key: "Dishcare.Dishwasher.Program.Eco50" }, { key: "Dishcare.Dishwasher.Program.Auto2" }],
    });
    await sync.syncAppliances();

    const after = port.objects.get("dishwasher-1.programs.selectedProgram");
    expect((after?.common as ioBroker.StateCommon).name).toMatchObject({ en: "Selected program" });
  });

  it("unions an option's allowed values across programs and keeps the chosen value", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Washer", {
      type: "Washer",
      status: [],
      available: ["LaundryCare.Washer.Program.Cotton", "LaundryCare.Washer.Program.Wool"],
    });
    port.getResponses.set("/api/homeappliances/HA-1/programs/selected", { key: "LaundryCare.Washer.Program.Cotton" });
    const spinDef = (allowed: string[]): unknown => ({
      options: [
        {
          key: "LaundryCare.Washer.Option.SpinSpeed",
          type: "LaundryCare.Washer.EnumType.SpinSpeed",
          constraints: { allowedvalues: allowed },
        },
      ],
    });
    port.getResponses.set(
      "/api/homeappliances/HA-1/programs/available/LaundryCare.Washer.Program.Cotton",
      spinDef(["LaundryCare.Washer.EnumType.SpinSpeed.RPM800", "LaundryCare.Washer.EnumType.SpinSpeed.RPM1200"]),
    );
    port.getResponses.set(
      "/api/homeappliances/HA-1/programs/available/LaundryCare.Washer.Program.Wool",
      spinDef(["LaundryCare.Washer.EnumType.SpinSpeed.RPM800", "LaundryCare.Washer.EnumType.SpinSpeed.RPM400"]),
    );
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    // The user picked a value.
    port.states.set("washer-1.options.spinSpeed", "rpm800");

    // Both program definitions feed ONE stable object: the union of all values.
    const after = port.objects.get("washer-1.options.spinSpeed");
    expect((after?.native as { bshValues: string[] }).bshValues).toHaveLength(3);

    // A later re-sync fetches no definition again and rewrites nothing.
    port.extendCalls.length = 0;
    await sync.syncAppliances();
    expect(port.extendCalls).not.toContain("washer-1.options.spinSpeed");
    expect(port.states.get("washer-1.options.spinSpeed")).toBe("rpm800");
    const defFetches = port.getCalls.filter(p => p.includes("/programs/available/LaundryCare.Washer.Program.Cotton"));
    expect(defFetches).toHaveLength(1);
  });

  it("does not let a stream event overwrite object metadata", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Oven", {
      settings: [
        {
          key: "BSH.Common.Setting.PowerState",
          value: "BSH.Common.EnumType.PowerState.On",
          constraints: {
            allowedvalues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Standby"],
          },
        },
      ],
      status: [],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();

    // A NOTIFY carries the value only (no constraints) — the object must keep its candidates.
    sync.handleStreamEvent({
      event: "NOTIFY",
      id: "HA-1",
      data: JSON.stringify({
        items: [{ key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.Standby" }],
      }),
    });
    await flush();
    const obj = port.objects.get("oven-1.settings.powerState");
    expect((obj?.native as { bshValues: string[] }).bshValues).toHaveLength(2);
    expect(port.states.get("oven-1.settings.powerState")).toBe("standby");
    expect(port.deleted).toHaveLength(0);
  });
});

describe("ApplianceSync options write gate", () => {
  it("does not send a write to a read-only display option", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.washer.options.remainingProgramTime`]: {
        _id: "",
        type: "state",
        common: { name: "remainingProgramTime", type: "number", role: "value", read: true, write: false },
        native: { bshKey: "BSH.Common.Option.RemainingProgramTime" },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.washer.options.remainingProgramTime`, 1200);
    expect(port.writes).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Gaps found by mutation testing: rules the suite above did not pin down.
// ---------------------------------------------------------------------------

describe("ApplianceSync.primeFromObjects robustness", () => {
  it("takes only top-level device objects into the haId mapping", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.oven`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
      // A nested object that also carries a haId — a sub-device, or a leftover from
      // an older tree. Taking it as a device would map the SAME haId to a path that
      // is not a device root, and the write path would then aim there.
      [`${NS}.oven.info`]: {
        _id: "",
        type: "device",
        common: {},
        native: { haId: "HA-1" },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    sync.handleStreamEvent({
      event: "NOTIFY",
      id: "",
      data: JSON.stringify({ haId: "HA-1", items: [{ key: "BSH.Common.Status.DoorState", value: "x" }] }),
    });
    await flush();
    // The haId must resolve to the device ROOT. Mapping it to a nested path puts
    // the appliance's whole live tree one level too deep, next to the real one.
    expect(port.states.has("oven.status.doorOpen")).toBe(true);
    expect(port.states.has("oven.info.status.doorOpen")).toBe(false);
  });

  it("ignores a state whose stored BSH key is not a string", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.oven`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.oven.settings.broken`]: {
        _id: "",
        type: "state",
        common: { write: true },
        // A hand-edited or half-migrated object. Passing this through would build
        // the path "/settings/42" and produce a permanent server-side error.
        native: { bshKey: 42, bshValues: "nope" },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.oven.settings.broken`, "x");
    expect(port.writes).toHaveLength(0);
  });
});

describe("ApplianceSync malformed API responses", () => {
  it("keeps the tree when the appliance list has the wrong shape", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [{ key: "BSH.Common.Status.DoorState", value: "x" }] });
    await sync.syncAppliances();
    port.logs.length = 0;

    // A 200 carrying an error envelope instead of the list.
    port.getResponses.set("/api/homeappliances", { error: { key: "SDK.Error.HomeAppliance.Offline" } });
    await sync.syncAppliances();
    // "Setting up 0 appliance(s)" would be a lie: nothing was learned, and the
    // user would go looking for a pairing problem that does not exist.
    expect(port.logs.some(l => l.includes("Setting up"))).toBe(false);
    expect(port.objects.has("oven-1")).toBe(true);
  });

  it("keeps every state when the response has the wrong shape", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", {
      type: "Oven",
      status: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" }],
    });
    await sync.syncAppliances();

    // Not a failure (undefined) but a record without the expected array — the
    // rate-limit / error envelope shape.
    port.getResponses.set("/api/homeappliances/HA-1/status", { error: { key: "SDK.Error.TooManyRequests" } });
    await sync.syncAppliances();
    expect(port.deleted).not.toContain("oven-1.status.doorOpen");
    expect(port.objects.has("oven-1.status.doorOpen")).toBe(true);
  });

  it("falls back to the haId when the appliance has an empty name", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "HA-XYZ", name: "", connected: false }],
    });
    await sync.syncAppliances();
    // No model code, no E-number, no type: the model half is "device", the haId still
    // names the appliance — and the empty app name gives way to the haId.
    const device = [...port.objects.entries()].find(([, o]) => o.type === "device");
    expect(device?.[0]).toBe("device-xyz");
    expect(device?.[1].common?.name).toBe("HA-XYZ");
  });
});

describe("ApplianceSync stream events for unknown and new appliances", () => {
  it("rebuilds a known appliance's tree on PAIRED, not just on CONNECTED", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();
    port.getCalls.length = 0;

    sync.handleStreamEvent({ event: "PAIRED", id: "", data: JSON.stringify({ haId: "HA-1" }) });
    await flush();
    expect(port.getCalls).toContain("/api/homeappliances/HA-1/status");
    expect(port.states.get("oven-1.info.reachable")).toBe(true);
  });

  it("fetches the whole list for a PAIRED appliance it has never seen", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-NEW", "New oven", { status: [] });
    port.getCalls.length = 0;

    sync.handleStreamEvent({ event: "PAIRED", id: "", data: JSON.stringify({ haId: "HA-NEW" }) });
    await flush();
    // A brand-new appliance has no name/type yet — only the list carries them, so
    // the single-appliance shortcut used for CONNECTED is not enough here.
    expect(port.getCalls).toContain("/api/homeappliances");
    expect(port.objects.has("new-oven-new")).toBe(true);
  });

  it("does not fetch a connected appliance's data twice for overlapping events", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();
    port.getCalls.length = 0;

    sync.handleStreamEvent({ event: "CONNECTED", id: "", data: JSON.stringify({ haId: "HA-1" }) });
    sync.handleStreamEvent({ event: "CONNECTED", id: "", data: JSON.stringify({ haId: "HA-1" }) });
    await flush();
    // The appliance sends CONNECTED more than once on a flaky link. Each pass is
    // ~6 cloud calls against a rate-limited API.
    expect(port.getCalls.filter(p => p === "/api/homeappliances/HA-1/status")).toHaveLength(1);
  });
});

describe("ApplianceSync object churn", () => {
  it("creates a command button once, not on every sync", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [], commands: [{ key: "BSH.Common.Command.PauseProgram" }] });
    await sync.syncAppliances();
    expect(port.objects.has("oven-1.commands.pauseProgram")).toBe(true);
    port.extendCalls.length = 0;

    await sync.syncAppliances();
    expect(port.extendCalls).not.toContain("oven-1.commands.pauseProgram");
  });

  it("keeps the previous program's options when the program changes — no datapoint ever disappears", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const base = "/api/homeappliances/HA-1";
    port.getResponses.set(`${base}/programs/available/P.Cotton`, {
      options: [{ key: "LaundryCare.Washer.Option.SpinSpeed", type: "Int", constraints: { min: 0, max: 1600 } }],
    });
    port.getResponses.set(`${base}/programs/available/P.Wool`, {
      options: [{ key: "LaundryCare.Washer.Option.Temperature", type: "Int", constraints: { min: 0, max: 60 } }],
    });
    await sync.activateProgramOptions("washer", "HA-1", "P.Cotton");
    expect(port.objects.has("washer.options.spinSpeed")).toBe(true);

    await sync.activateProgramOptions("washer", "HA-1", "P.Wool");
    // The tree holds the union of all programs; which options the SELECTED
    // program accepts is the write gate's business, not the object tree's.
    expect(port.deleted).not.toContain("washer.options.spinSpeed");
    expect(port.objects.has("washer.options.spinSpeed")).toBe(true);
    expect(port.objects.has("washer.options.temperature")).toBe(true);
  });

  it("blocks a write to an option outside the selected program's definition", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.primeDevices = {
      [`${NS}.washer`]: {
        _id: "",
        type: "device",
        common: {},
        native: { haId: "HA-1" },
      } as unknown as ioBroker.Object,
    };
    await sync.primeFromObjects();
    const base = "/api/homeappliances/HA-1";
    port.getResponses.set(`${base}/programs/available/P.Cotton`, {
      options: [{ key: "LaundryCare.Washer.Option.SpinSpeed", type: "Int" }],
    });
    port.getResponses.set(`${base}/programs/available/P.Wool`, {
      options: [{ key: "LaundryCare.Washer.Option.Temperature", type: "Int" }],
    });
    await sync.activateProgramOptions("washer", "HA-1", "P.Cotton");
    await sync.activateProgramOptions("washer", "HA-1", "P.Wool");
    // spinSpeed still EXISTS (union) but belongs to the previous program only —
    // writing it now would just produce a server-side error, so it is not sent.
    await sync.handleWrite(`${NS}.washer.options.spinSpeed`, 800);
    expect(port.writes).toHaveLength(0);
    await sync.handleWrite(`${NS}.washer.options.temperature`, 40);
    expect(port.writes).toHaveLength(1);
  });

  it("re-fetches nothing on a program change the cache already knows", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const base = "/api/homeappliances/HA-1";
    port.getResponses.set(`${base}/programs/available/P.Cotton`, { options: [] });
    port.getResponses.set(`${base}/programs/available/P.Wool`, { options: [] });
    await sync.activateProgramOptions("washer", "HA-1", "P.Cotton");
    await sync.activateProgramOptions("washer", "HA-1", "P.Wool");
    port.getCalls.length = 0;
    await sync.activateProgramOptions("washer", "HA-1", "P.Cotton");
    expect(port.getCalls).toHaveLength(0);
  });
});

describe("ApplianceSync write results", () => {
  /** A washer primed with a selected program and one writable option. */
  function washer(): { port: FakePort; sync: ApplianceSync } {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.washer.programs.selectedProgram`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: { bshKey: "BSH.Common.Root.SelectedProgram", bshValues: ["LaundryCare.Washer.Program.Cotton"] },
      } as unknown as ioBroker.Object,
      [`${NS}.washer.settings.powerState`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: {
          bshKey: "BSH.Common.Setting.PowerState",
          bshValues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Off"],
        },
      } as unknown as ioBroker.Object,
      [`${NS}.washer.options.spinSpeed`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: { bshKey: "LaundryCare.Washer.Option.SpinSpeed", bshValues: [] },
      } as unknown as ioBroker.Object,
    };
    port.states.set("washer.programs.selectedProgram", "cotton");
    port.states.set("washer.options.spinSpeed", 1200);
    return { port, sync: new ApplianceSync(port) };
  }

  it("does not confirm a value the appliance rejected — it restores the real one", async () => {
    const { port, sync } = washer();
    await sync.primeFromObjects();
    // The user's write already sits in the database (ack:false) when the
    // adapter reacts to it — exactly what the read-back has to overwrite.
    port.states.set("washer.settings.powerState", "on");
    port.writeResult = { status: 409, ok: false, data: undefined, error: "wrong state" };
    port.getResponses.set("/api/homeappliances/HA-1/settings/BSH.Common.Setting.PowerState", {
      key: "BSH.Common.Setting.PowerState",
      value: "BSH.Common.EnumType.PowerState.Off",
    });

    await sync.handleWrite(`${NS}.washer.settings.powerState`, "on");
    // Acking a rejected write shows the user's wish as if the appliance had done
    // it — and without a read-back the wish stayed there with ack:false, the
    // tree disagreeing with the machine until the next sync (measured: "on" in
    // the database for an appliance that was off). One targeted read fixes it.
    expect(port.stateWrites.filter(w => w.id === "washer.settings.powerState").map(w => w.val)).toEqual(["off"]);
    expect(port.states.get("washer.settings.powerState")).toBe("off");
    expect(port.getCalls.filter(p => p.endsWith("/settings/BSH.Common.Setting.PowerState"))).toHaveLength(1);
  });

  it("writes a pressed button exactly once — the reset, not the press", async () => {
    const { port, sync } = washer();
    await sync.primeFromObjects();
    port.stateWrites.length = 0;

    await sync.handleWrite(`${NS}.washer.programs.start`, true);
    const own = port.stateWrites.filter(w => w.id === "washer.programs.start");
    // Confirming the press with `true` and resetting to `false` right after leaves
    // a phantom true in history and fires two state events for one press.
    expect(own).toEqual([{ id: "washer.programs.start", val: false }]);
  });

  it("resets the start button and does not confirm it as a value", async () => {
    const { port, sync } = washer();
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.washer.programs.start`, true);
    expect(port.writes[0]).toMatchObject({ method: "PUT", path: "/api/homeappliances/HA-1/programs/active" });
    // A press is momentary: leaving it true means the next press writes nothing
    // (the value did not change) and the button looks stuck in the UI.
    expect(port.states.get("washer.programs.start")).toBe(false);
  });

  it("sends an option that has no enum candidates", async () => {
    const { port, sync } = washer();
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.washer.programs.start`, true);
    // A numeric option carries an empty candidate list. Treating "list present"
    // as "is an enum" resolves nothing and silently drops the option.
    expect(port.writes[0].body?.options).toEqual([{ key: "LaundryCare.Washer.Option.SpinSpeed", value: 1200 }]);
  });

  it("does not assemble the start payload for a plain program change", async () => {
    const { port, sync } = washer();
    await sync.primeFromObjects();
    port.getStateCalls.length = 0;

    await sync.handleWrite(`${NS}.washer.programs.selectedProgram`, "cotton");
    // Selecting a program is not a start: reading every option state for it costs
    // one DB round trip per option on every single program change.
    expect(port.getStateCalls).not.toContain("washer.options.spinSpeed");
  });

  it("retries a rejected start with defaults only when options were sent", async () => {
    const { port, sync } = washer();
    await sync.primeFromObjects();
    port.writeResult = { status: 409, ok: false, data: undefined, error: "not possible" };

    await sync.handleWrite(`${NS}.washer.programs.start`, true);
    expect(port.writes).toHaveLength(2);
    expect(port.writes[1].body).toEqual({ key: "LaundryCare.Washer.Program.Cotton" });

    // No options in the first attempt → the retry would be byte-identical and only
    // burn another call against the rate-limited API.
    port.states.delete("washer.options.spinSpeed");
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.washer.programs.start`, true);
    expect(port.writes).toHaveLength(1);
  });
});

describe("ApplianceSync failure paths", () => {
  it("keeps starting when the object DB cannot be read for priming", async () => {
    const port = new FakePort();
    port.getForeignObjects = () => Promise.reject(new Error("objects db down"));
    const sync = new ApplianceSync(port);
    // Priming is best-effort: a DB hiccup at start must not abort onReady before
    // the sign-in and the REST sync ever run.
    await expect(sync.primeFromObjects()).resolves.toBeUndefined();
    expect(port.logs.filter(l => l.includes("priming"))).toHaveLength(2);
  });

  it("ignores stream payloads it cannot use", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();
    port.getCalls.length = 0;

    sync.handleStreamEvent({ event: "STATUS", id: "", data: "not json" });
    sync.handleStreamEvent({ event: "STATUS", id: "", data: "[1,2,3]" });
    sync.handleStreamEvent({ event: "STATUS", id: "", data: "{}" });
    sync.handleStreamEvent({ event: "STATUS", id: "", data: JSON.stringify({ haId: "" }) });
    await flush();
    // A malformed frame is a fact of life on a cloud stream — it must not warn
    // per frame and must not reach the device tree.
    expect(port.getCalls).toEqual([]);
    expect(port.logs.filter(l => l.startsWith("warn"))).toEqual([]);
  });

  it("removes the whole tree of an appliance that left the account", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();
    expect(port.objects.has("oven-1")).toBe(true);

    sync.handleStreamEvent({ event: "DEPAIRED", id: "", data: JSON.stringify({ haId: "HA-1" }) });
    await flush();

    // What is no longer on the account cannot be addressed either — every write
    // would go nowhere. Keeping the tree would leave datapoints that can never
    // update again and an entry counting as permanently offline in the summary.
    expect(port.logs.some(l => l.includes("removing its objects"))).toBe(true);
    expect(port.objects.has("oven-1")).toBe(false);
    expect(port.states.has("oven-1.info.reachable")).toBe(false);
    expect(port.states.get("info.devicesTotal")).toBe(0);
  });

  it("links the device object to its reachable state so the tree shows an icon", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();

    // The `info.reachable` value alone is just a number nobody connects to the
    // green/grey dot — statusStates is what makes the object browser show it, and
    // it needs the FULL id, not the device-relative one.
    const device = port.objects.get("oven-1") as { common?: { statusStates?: { onlineId?: string } } };
    expect(device.common?.statusStates?.onlineId).toBe(`${port.namespace}.oven-1.info.reachable`);
  });

  it("gives a device object the pictogram of its appliance type", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { type: "Oven", status: [] });
    await sync.syncAppliances();

    // The inline data URI, not a path: only an inlined SVG inherits the row's
    // text colour (`currentColor`); a path lands in an `<img>` and stays black.
    const device = port.objects.get("oven-1") as { common?: { icon?: string } };
    expect(device.common?.icon?.startsWith(ICON_URI_PREFIX)).toBe(true);
    expect(device.common?.icon).toBe(deviceIcon("Oven"));
  });

  it("gives an appliance that predates the pictograms its icon, exactly once", async () => {
    const port = new FakePort();
    // The device object as a version before the pictograms wrote it: name and
    // type plate, no icon.
    port.primeDevices = {
      [`${NS}.oven`]: {
        _id: "",
        type: "device",
        common: { name: "Oven" },
        // Byte-identical to what the sync forms, EXCEPT the icon — otherwise a
        // difference in the type plate would trigger the write on its own and the
        // test would pass without the fix (measured: it did).
        native: { haId: "HA-1", type: "Oven", enumber: "Oven" },
      },
    } as unknown as Record<string, ioBroker.Object>;
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { type: "Oven", status: [] });
    await sync.primeFromObjects();
    await sync.syncAppliances();

    // Priming forms the signature of what is actually STORED. Were the icon
    // derived inside the object builder instead of passed in, the primed
    // signature would already carry it, match itself, and no existing appliance
    // would EVER be given its pictogram — the memory marker cannot heal a field
    // it invents on both sides.
    expect(port.extendCalls.filter(id => id === "oven")).toHaveLength(1);
    const device = port.objects.get("oven") as { common?: { icon?: string } };
    expect(device.common?.icon?.startsWith(ICON_URI_PREFIX)).toBe(true);
    expect(device.common?.icon).toBe(deviceIcon("Oven"));

    // And it stays a one-off: the next pass finds the icon in the signature.
    port.extendCalls.length = 0;
    await sync.syncAppliances();
    expect(port.extendCalls.filter(id => id === "oven")).toHaveLength(0);
  });

  it("replaces the v1.19.0 path icon with the inline one, exactly once", async () => {
    const port = new FakePort();
    // The device object as v1.19.0 wrote it: the path form, which the Admin put
    // into a plain `<img>` — black on both dark themes.
    port.primeDevices = {
      [`${NS}.oven`]: {
        _id: "",
        type: "device",
        common: { name: "Oven", icon: "/icons/oven.svg" },
        native: { haId: "HA-1", type: "Oven", enumber: "Oven" },
      },
    } as unknown as Record<string, ioBroker.Object>;
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { type: "Oven", status: [] });
    await sync.primeFromObjects();
    await sync.syncAppliances();

    // The stored path differs from the data URI the sync now forms → one write.
    expect(port.extendCalls.filter(id => id === "oven")).toHaveLength(1);
    const device = port.objects.get("oven") as { common?: { icon?: string } };
    expect(device.common?.icon?.startsWith(ICON_URI_PREFIX)).toBe(true);
    expect(device.common?.icon).toBe(deviceIcon("Oven"));

    port.extendCalls.length = 0;
    await sync.syncAppliances();
    expect(port.extendCalls.filter(id => id === "oven")).toHaveLength(0);
  });

  it("does not rewrite a device that already carries the inline icon after a restart", async () => {
    const port = new FakePort();
    // Priming reads the icon of the STORED object into the signature; were it
    // ignored there, every start would write every device object once more.
    port.primeDevices = {
      [`${NS}.oven`]: {
        _id: "",
        type: "device",
        common: { name: "Oven", icon: deviceIcon("Oven") },
        native: { haId: "HA-1", type: "Oven", enumber: "Oven" },
      },
    } as unknown as Record<string, ioBroker.Object>;
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { type: "Oven", status: [] });
    await sync.primeFromObjects();
    await sync.syncAppliances();

    expect(port.extendCalls.filter(id => id === "oven")).toHaveLength(0);
  });

  it("an account without a single appliance does not report all-online", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();

    sync.handleStreamEvent({ event: "DEPAIRED", id: "", data: JSON.stringify({ haId: "HA-1" }) });
    await flush();

    // "All 0 of 0 connected" would be a success message for an empty setup.
    expect(port.states.get("info.devicesTotal")).toBe(0);
    expect(port.states.get("info.devicesAllOnline")).toBe(false);
  });

  it("keeps the tree of an appliance that is merely switched off", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();

    sync.handleStreamEvent({ event: "DISCONNECTED", id: "", data: JSON.stringify({ haId: "HA-1" }) });
    await flush();

    // Still on the account, just powered down — dropping the tree here would make
    // the datapoints vanish every evening and tear the history apart.
    expect(port.objects.has("oven-1")).toBe(true);
    expect(port.states.get("oven-1.info.reachable")).toBe(false);
    expect(port.states.get("info.devicesTotal")).toBe(1);
    expect(port.states.get("info.devicesOnline")).toBe(0);
  });

  it("removes an appliance that silently vanished from the account list", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    appliance(port, "HA-2", "Dishwasher", { status: [] });
    await sync.syncAppliances();
    expect(port.states.get("info.devicesTotal")).toBe(2);

    // The second way an appliance disappears: removed while the adapter was off,
    // so no DEPAIRED event ever arrives — it is simply missing from the list.
    const list = (port.getResponses.get("/api/homeappliances") as { homeappliances: { haId: string }[] })
      .homeappliances;
    port.getResponses.set("/api/homeappliances", { homeappliances: list.filter(a => a.haId !== "HA-2") });
    await sync.syncAppliances();

    expect(port.objects.has("dishwasher-2")).toBe(false);
    expect(port.objects.has("oven-1")).toBe(true);
    expect(port.states.get("info.devicesTotal")).toBe(1);
  });

  it("a failed appliance list never wipes the tree", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();

    // Nothing was learned — deleting on a network hiccup would destroy the whole
    // configuration, so the removal pass must sit behind the success guard.
    port.apiGet = () => Promise.resolve(undefined);
    await sync.syncAppliances();

    expect(port.objects.has("oven-1")).toBe(true);
    expect(port.states.get("info.devicesTotal")).toBe(1);
  });

  it("reports a failing background task instead of dying on an unhandled rejection", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    await sync.syncAppliances();
    port.setStateChanged = () => Promise.reject(new Error("states db down"));

    sync.handleStreamEvent({ event: "DISCONNECTED", id: "", data: JSON.stringify({ haId: "HA-1" }) });
    await flush();
    // Stream handling is fire-and-forget: an escaping rejection kills the process.
    expect(port.logs.some(l => l.includes("appliance sync task failed"))).toBe(true);
  });

  it("skips an appliance record without a haId", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.getResponses.set("/api/homeappliances", { homeappliances: [{ name: "Nameless" }] });
    await sync.syncAppliances();
    expect([...port.objects.keys()]).toEqual([]);
  });

  it("skips items and option definitions without a key", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [{ value: 1 }, { key: 42, value: 2 }] });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available/P.X", { options: [{ type: "Int" }] });
    await sync.syncAppliances();
    await sync.activateProgramOptions("oven-1", "HA-1", "P.X");
    expect([...port.objects.keys()].filter(k => k.startsWith("oven-1.status."))).toEqual([]);
    expect([...port.objects.keys()].filter(k => k.startsWith("oven-1.options."))).toEqual([]);
  });

  it("retries a failed definition fetch on the next activation instead of caching the failure", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const base = "/api/homeappliances/HA-1";
    // First activation: the definition fetch fails (no response configured).
    await sync.activateProgramOptions("w", "HA-1", "P.A");
    expect(port.objects.has("w.options.one")).toBe(false);
    // The endpoint recovers → the next activation fetches and creates the option.
    port.getResponses.set(`${base}/programs/available/P.A`, { options: [{ key: "X.Option.One", type: "Int" }] });
    await sync.activateProgramOptions("w", "HA-1", "P.A");
    expect(port.objects.has("w.options.one")).toBe(true);
  });

  it("ignores a program response whose options are not a list", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    port.getResponses.set("/api/homeappliances/HA-1/programs/selected", { key: "P.A", options: "nonsense" });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available/P.A", { options: [] });
    // Reached the cloud (the appliance list arrived) — a malformed PROGRAM response
    // is a per-appliance detail, not a failed sync.
    await expect(sync.syncAppliances()).resolves.toBe(true);
  });

  it("reports a failing write instead of dying on an unhandled rejection", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.oven`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.oven.settings.powerState`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: { bshKey: "BSH.Common.Setting.PowerState" },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    port.apiWrite = () => Promise.reject(new Error("transport blew up"));

    // handleWrite is called with `void` from onStateChange.
    await expect(sync.handleWrite(`${NS}.oven.settings.powerState`, "off")).resolves.toBeUndefined();
    expect(port.logs.some(l => l.includes("handling write to"))).toBe(true);
  });

  it("ignores a write to an id that is not a device state", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    for (const id of [`${NS}.info.connection`, `${NS}.oven`, `${NS}.oven.settings`, `${NS}.oven.settings.`]) {
      await sync.handleWrite(id, true);
    }
    expect(port.writes).toEqual([]);
  });
});

describe("ApplianceSync metadata replace details", () => {
  it("keeps the value, the recording configuration and the object itself across a metadata refresh", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available", {
      programs: [{ key: "Cooking.Oven.Program.HeatingMode.HotAir" }],
    });
    // The appliance has this program selected, so the sync's own value for the
    // state is "hotair" — what survives the refresh is then unambiguous.
    port.getResponses.set("/api/homeappliances/HA-1/programs/selected", {
      key: "Cooking.Oven.Program.HeatingMode.HotAir",
    });
    await sync.syncAppliances();
    const id = "oven-1.programs.selectedProgram";
    const obj = port.objects.get(id) as { common: Record<string, unknown> };
    obj.common.name = "My program";
    (obj.common as { custom?: unknown }).custom = { "history.0": { enabled: true } };
    port.states.set(id, "hotair");

    // A new program appears → the candidate list changes → the object is replaced.
    port.getResponses.set("/api/homeappliances/HA-1/programs/available", {
      programs: [
        { key: "Cooking.Oven.Program.HeatingMode.HotAir" },
        { key: "Cooking.Oven.Program.HeatingMode.TopBottomHeating" },
      ],
    });
    await sync.syncAppliances();
    const after = port.objects.get(id) as { common: Record<string, unknown> };
    // The name is the adapter's and comes back. Everything else the object
    // carries survives untouched, because the refresh MERGES — it never deletes
    // and re-creates (shelly's model): the recording configuration stays…
    expect(after.common.name).toMatchObject({ en: "Selected program" });
    expect((after.common as { custom?: unknown }).custom).toEqual({ "history.0": { enabled: true } });
    // …the object is never gone for a moment…
    expect(port.deleted).not.toContain(id);
    // …and the value is not dropped, so nothing has to be written back.
    expect(port.states.get(id)).toBe("hotair");
  });

  it("reports a failing metadata refresh and leaves the sync running", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available", { programs: [{ key: "P.A" }] });
    await sync.syncAppliances();
    // Only the refreshed state fails — the rest of the sync must carry on.
    const realExtend = port.extendObject.bind(port);
    port.extendObject = (objId: string, obj: ioBroker.PartialObject): Promise<unknown> =>
      objId === "oven-1.programs.selectedProgram"
        ? Promise.reject(new Error("objects db down"))
        : realExtend(objId, obj);
    port.getResponses.set("/api/homeappliances/HA-1/programs/available", {
      programs: [{ key: "P.A" }, { key: "P.B" }],
    });

    // The sync itself reached the cloud; a failing metadata refresh is reported per
    // datapoint and must not abort the pass.
    await expect(sync.syncAppliances()).resolves.toBe(true);
    expect(port.logs.some(l => l.includes("refreshing object metadata"))).toBe(true);
  });
});

describe("ApplianceSync start payload details", () => {
  it("leaves out options that carry no value or no BSH key", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.washer.programs.selectedProgram`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: { bshKey: "BSH.Common.Root.SelectedProgram", bshValues: ["LaundryCare.Washer.Program.Cotton"] },
      } as unknown as ioBroker.Object,
      [`${NS}.washer.options.hasValue`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: { bshKey: "X.Option.HasValue" },
      } as unknown as ioBroker.Object,
      [`${NS}.washer.options.neverSet`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: { bshKey: "X.Option.NeverSet" },
      } as unknown as ioBroker.Object,
      [`${NS}.washer.options.noKey`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: {},
      } as unknown as ioBroker.Object,
    };
    port.states.set("washer.programs.selectedProgram", "cotton");
    port.states.set("washer.options.hasValue", 40);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.washer.programs.start`, true);
    // Sending `null` for an option the user never touched makes the appliance
    // reject the whole start.
    expect(port.writes[0].body?.options).toEqual([{ key: "X.Option.HasValue", value: 40 }]);
  });

  it("starts with defaults when no program is selected in the tree", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.handleWrite(`${NS}.washer.programs.start`, true);
    // No program → nothing to start. Sending a start without a key 400s.
    expect(port.writes).toEqual([]);
  });

  it("reloads the option definitions after the program was changed", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.washer.programs.selectedProgram`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: { bshKey: "BSH.Common.Root.SelectedProgram", bshValues: ["LaundryCare.Washer.Program.Cotton"] },
      } as unknown as ioBroker.Object,
    };
    port.getResponses.set("/api/homeappliances/HA-1/programs/available/LaundryCare.Washer.Program.Cotton", {
      options: [{ key: "LaundryCare.Washer.Option.Temperature", type: "Int", constraints: { min: 0, max: 60 } }],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    await sync.handleWrite(`${NS}.washer.programs.selectedProgram`, "cotton");
    // Without the reload the options panel still shows the previous program's
    // options — writable, and rejected by the appliance.
    expect(port.objects.has("washer.options.temperature")).toBe(true);
  });
});

describe("ApplianceSync remaining guards", () => {
  it("ignores value and offline events for an appliance it does not know", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    for (const event of ["NOTIFY", "STATUS", "EVENT", "DISCONNECTED", "DEPAIRED"]) {
      sync.handleStreamEvent({
        event,
        id: "",
        data: JSON.stringify({ haId: "HA-GHOST", items: [{ key: "BSH.Common.Status.DoorState", value: "x" }] }),
      });
    }
    await flush();
    // Only CONNECTED/PAIRED may go and fetch. Everything else for an unknown
    // appliance would build a tree from a value frame — without name or type.
    expect(port.getCalls).toEqual([]);
    expect([...port.objects.keys()]).toEqual([]);
  });

  it("reports a broken stream frame instead of dying on it", () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const hostile = {
      event: "STATUS",
      data: "{}",
      get id(): string {
        throw new Error("frame blew up");
      },
    };
    expect(() => sync.handleStreamEvent(hostile as never)).not.toThrow();
    expect(port.logs.some(l => l.includes("handling stream event failed"))).toBe(true);
  });

  it("applies the option values a program response carries", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Washer", { status: [], available: ["P.A"] });
    port.getResponses.set("/api/homeappliances/HA-1/programs/selected", {
      key: "P.A",
      options: [{ key: "LaundryCare.Washer.Option.Temperature", value: 40, unit: "°C" }],
    });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available/P.A", { options: [] });
    await sync.syncAppliances();
    // The values of the selected program are what the user sees before pressing
    // start — dropping them leaves the panel empty until the appliance runs.
    expect(port.states.get("washer-1.options.temperature")).toBe(40);
  });

  it("does no follow-up when the write was never sent", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.washer.programs.selectedProgram`]: {
        _id: "",
        type: "state",
        common: { write: true },
        native: { bshKey: "BSH.Common.Root.SelectedProgram", bshValues: ["P.A"] },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    port.writeResult = undefined; // paused by the rate limiter / not signed in
    port.getCalls.length = 0;

    port.logs.length = 0;
    await sync.handleWrite(`${NS}.washer.programs.selectedProgram`, "a");
    expect(port.writes).toHaveLength(1);
    // Reloading the option definitions for a program change that never reached
    // the cloud spends calls from a quota that is already exhausted.
    expect(port.getCalls).toEqual([]);
    // And a not-sent write is not a failure — reading the missing result would
    // throw and turn a rate-limit pause into a warning per press.
    expect(port.logs.filter(l => l.startsWith("warn"))).toEqual([]);
  });
});

describe("ApplianceSync online/offline logging", () => {
  it("logs a reachability transition once at debug — never at info, none while nothing changes", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Waschtrockner", { type: "WasherDryer", status: [], settings: [] });
    await sync.syncAppliances();

    port.logs.length = 0;
    sync.handleStreamEvent({ event: "DISCONNECTED", id: "HA-1", data: "{}" });
    await flush();
    // Fleet convention: routine per-device connectivity is debug material — the
    // tree's green/grey dot and info.devicesOnline carry it for the user. The
    // line names the appliance as `Name (id)`.
    expect(
      port.logs.filter(l => l === "debug: Appliance Waschtrockner (waschtrockner-1) is now offline."),
    ).toHaveLength(1);
    expect(port.logs.filter(l => l.startsWith("info") && l.includes("is now"))).toHaveLength(0);

    // The same state again produces no second line.
    sync.handleStreamEvent({ event: "DISCONNECTED", id: "HA-1", data: "{}" });
    await flush();
    expect(port.logs.filter(l => l.includes("offline"))).toHaveLength(1);
  });

  it("does not flood the log with per-device lines at start — one summary line leads", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Geschirrspüler", { status: [] });
    appliance(port, "HA-2", "Waschtrockner", { type: "WasherDryer", status: [], connected: false });
    await sync.syncAppliances();

    const infos = port.logs.filter(l => l.startsWith("info"));
    // The summary is the FIRST info line — before any per-device output; the old
    // trailing "N found" after the per-device lines read like an afterthought.
    expect(infos[0]).toBe("info: Setting up 2 appliance(s) from the Home Connect account...");
    // The initial reachability stamping produces no transition lines at all.
    expect(port.logs.filter(l => l.startsWith("info") && l.includes("is now"))).toHaveLength(0);
  });
});

describe("ApplianceSync program-list flicker guard", () => {
  it("keeps the program dropdown when the available list is refused mid-run", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const base = "/api/homeappliances/HA-1";
    appliance(port, "HA-1", "Washer", {
      type: "Washer",
      status: [],
      available: ["LaundryCare.Washer.Program.Cotton"],
    });
    port.getResponses.set(`${base}/programs/available/LaundryCare.Washer.Program.Cotton`, { options: [] });
    await sync.syncAppliances();
    const before = port.objects.get("washer-1.programs.selectedProgram");
    expect((before?.native as { bshValues: string[] }).bshValues).toEqual(["LaundryCare.Washer.Program.Cotton"]);

    // While a program runs the API refuses the list ("wrong operation state").
    port.getResponses.delete(`${base}/programs/available`);
    port.extendCalls.length = 0;
    await sync.syncAppliances();
    const after = port.objects.get("washer-1.programs.selectedProgram");
    // The dropdown values survive — the cache knows the programs.
    expect((after?.native as { bshValues: string[] }).bshValues).toEqual(["LaundryCare.Washer.Program.Cotton"]);
    // And the start/stop buttons are still justified by the cached list.
    expect(port.objects.has("washer-1.programs.start")).toBe(true);
  });
});

describe("ApplianceSync definition cache across restarts", () => {
  it("restores the cache from the device object and fetches no definition again", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: {
        _id: "",
        type: "device",
        common: {},
        native: {
          haId: "HA-1",
          type: "Washer",
          programOptions: {
            "LaundryCare.Washer.Program.Cotton": {
              ids: ["spinSpeed"],
              keys: { spinSpeed: "LaundryCare.Washer.Option.SpinSpeed" },
              v: 4,
            },
          },
        },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.activateProgramOptions("washer", "HA-1", "LaundryCare.Washer.Program.Cotton");
    // No definition request — the persisted cache answers.
    expect(port.getCalls).toHaveLength(0);
  });

  it("fetches a definition of an older generation once more, and only once", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: {
        _id: "",
        type: "device",
        common: {},
        native: {
          haId: "HA-1",
          type: "Washer",
          // The pre-generation shape: a bare id list, written before option
          // objects carried the cloud's localized name.
          programOptions: { "P.A": ["one"] },
        },
      } as unknown as ioBroker.Object,
    };
    // The same device as it stands in the database, so the write really merges.
    port.objects.set("washer", {
      type: "device",
      common: {},
      native: { haId: "HA-1", type: "Washer", programOptions: { "P.A": ["one"] } },
    });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available/P.A", {
      options: [{ key: "X.Option.One", type: "Int", name: "Erste Wahl" }],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.activateProgramOptions("washer", "HA-1", "P.A");
    expect(port.getCalls).toHaveLength(1);
    // The old shape is cleared before the new one is written, because a deep
    // merge would blend a list and an object into something unreadable.
    const stored = (port.objects.get("washer")?.native as { programOptions: Record<string, unknown> }).programOptions;
    // A merge on top of the old list would leave a list carrying extra fields —
    // it must be a plain entry, not an array in disguise.
    expect(Array.isArray(stored["P.A"])).toBe(false);
    expect(stored).toEqual({ "P.A": { ids: ["one"], keys: { one: "X.Option.One" }, v: 4 } });
    expect(port.objects.get("washer")?.native).toMatchObject({ haId: "HA-1" });
    // The write gate stays armed on the same option id.
    await sync.activateProgramOptions("washer", "HA-1", "P.A");
    expect(port.getCalls).toHaveLength(1);
  });

  it("persists a freshly fetched definition on the device object", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.objects.set("washer", { type: "device", common: {}, native: { haId: "HA-1" } });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available/P.A", {
      options: [{ key: "X.Option.One", type: "Int" }],
    });
    await sync.activateProgramOptions("washer", "HA-1", "P.A");
    const device = port.objects.get("washer");
    expect((device?.native as { programOptions: Record<string, unknown> }).programOptions).toEqual({
      "P.A": { ids: ["one"], keys: { one: "X.Option.One" }, v: 4 },
    });
    // haId survived the partial native update (merge, not replace).
    expect((device?.native as { haId: string }).haId).toBe("HA-1");
  });
});

describe("ApplianceSync.migrateRenamedStates", () => {
  /**
   * Devices + states as an earlier adapter version left them in the DB.
   *
   * @param port Fake adapter port whose object store is primed
   */
  function legacyDb(port: FakePort): void {
    port.primeDevices = {
      [`${NS}.fridge`]: {
        _id: "",
        type: "device",
        common: {},
        native: { haId: "HA-F", type: "FridgeFreezer" },
      } as unknown as ioBroker.Object,
      [`${NS}.washer`]: {
        _id: "",
        type: "device",
        common: {},
        native: { haId: "HA-W", type: "WasherDryer" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      // Mis-channeled nested setting, read-only by accident, with history config.
      [`${NS}.fridge.misc.brightness`]: {
        _id: "",
        type: "state",
        common: {
          name: "brightness",
          type: "number",
          role: "value",
          unit: "%",
          write: false,
          custom: { "influxdb.0": { enabled: true } },
        },
        native: { bshKey: "Refrigeration.Common.Setting.Light.Internal.Brightness" },
      } as unknown as ioBroker.Object,
      // Mis-channeled per-compartment door (text) → boolean under status.
      [`${NS}.fridge.misc.freezer`]: {
        _id: "",
        type: "state",
        common: { name: "freezer", type: "string", role: "text", write: false },
        native: { bshKey: "Refrigeration.Common.Status.Door.Freezer" },
      } as unknown as ioBroker.Object,
      // A fridge has no programs — the whole channel goes.
      [`${NS}.fridge.programs.activeProgram`]: {
        _id: "",
        type: "state",
        common: { name: "activeProgram", type: "string", role: "text", write: false },
        native: { bshKey: "BSH.Common.Root.ActiveProgram" },
      } as unknown as ioBroker.Object,
      // Door text state of a lockable type → doorOpen + doorLocked booleans.
      [`${NS}.washer.status.doorState`]: {
        _id: "",
        type: "state",
        common: { name: "doorState", type: "string", role: "text", write: false },
        native: { bshKey: "BSH.Common.Status.DoorState" },
      } as unknown as ioBroker.Object,
      // Already in its right place — must stay untouched.
      [`${NS}.washer.status.operationState`]: {
        _id: "",
        type: "state",
        common: { name: "operationState", type: "string", role: "text", write: false },
        native: { bshKey: "BSH.Common.Status.OperationState" },
      } as unknown as ioBroker.Object,
    };
    for (const [fullId, obj] of Object.entries(port.primeStates)) {
      port.objects.set(fullId.slice(`${NS}.`.length), obj);
    }
    port.objects.set("fridge.misc", { type: "channel", common: { name: "misc" }, native: {} });
    port.states.set("fridge.misc.brightness", 70);
    port.states.set("washer.status.doorState", "locked");
  }

  it("moves mis-channeled states to their real place, carrying the value, the metadata and the recording", async () => {
    const port = new FakePort();
    legacyDb(port);
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();

    const migrated = port.objects.get("fridge.settings.lightInternalBrightness");
    expect(migrated).toBeDefined();
    expect(migrated?.common).toMatchObject({ unit: "%", write: true, custom: { "influxdb.0": { enabled: true } } });
    expect(port.states.get("fridge.settings.lightInternalBrightness")).toBe(70);
    expect(port.objects.has("fridge.misc.brightness")).toBe(false);
    // The drained misc channel object is gone too.
    expect(port.objects.has("fridge.misc")).toBe(false);
  });

  it("reshapes a door text state into the boolean pair", async () => {
    const port = new FakePort();
    legacyDb(port);
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();

    expect(port.states.get("washer.status.doorOpen")).toBe(false);
    expect(port.states.get("washer.status.doorLocked")).toBe(true);
    expect(port.objects.has("washer.status.doorState")).toBe(false);
    // The freezer door had no stored value: the datapoint moves, but no value
    // is invented for it — "false" would claim a closed door nobody reported.
    expect(port.objects.has("fridge.status.doorFreezerOpen")).toBe(true);
    expect(port.states.has("fridge.status.doorFreezerOpen")).toBe(false);
  });

  it("removes the programs channel of a program-less appliance type", async () => {
    const port = new FakePort();
    legacyDb(port);
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    expect(port.objects.has("fridge.programs.activeProgram")).toBe(false);
  });

  it("leaves states alone that are already in their place", async () => {
    const port = new FakePort();
    legacyDb(port);
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    expect(port.objects.has("washer.status.operationState")).toBe(true);
    expect(port.deleted).not.toContain("washer.status.operationState");
  });

  it("reads the value only of the datapoints that move (2026-09-15, F9)", async () => {
    const port = new FakePort();
    legacyDb(port);
    await new ApplianceSync(port).migrateRenamedStates();
    // The three that move are read once each; the one already in place never.
    expect([...port.getStateCalls].sort()).toEqual([
      "fridge.misc.brightness",
      "fridge.misc.freezer",
      "washer.status.doorState",
    ]);
    // And the moved number is still a number with its value — the expansion that
    // decides the type ran with the real value, not the value-less placement check.
    expect(port.states.get("fridge.settings.lightInternalBrightness")).toBe(70);
    expect((port.objects.get("fridge.settings.lightInternalBrightness")?.common as { type?: string }).type).toBe(
      "number",
    );
  });

  it("reports a summary instead of one line per datapoint", async () => {
    const port = new FakePort();
    legacyDb(port);
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    expect(port.logs.filter(l => l.startsWith("info") && l.includes("Migrated"))).toHaveLength(1);
  });

  it("does nothing on a tree that is already current", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    expect(port.deleted).toEqual([]);
    expect(port.logs.filter(l => l.startsWith("info"))).toEqual([]);
  });
});

describe("ApplianceSync definition-cache robustness", () => {
  it("does not cache a half-shaped definition response as 'no options'", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const base = "/api/homeappliances/HA-1";
    // A record that carries neither an options list nor the program key — a shape
    // we do not understand must be retried, not remembered as an empty program.
    port.getResponses.set(`${base}/programs/available/P.A`, { unexpected: true });
    await sync.activateProgramOptions("w", "HA-1", "P.A");
    // The endpoint recovers → the option appears (a cached failure would block this).
    port.getResponses.set(`${base}/programs/available/P.A`, { options: [{ key: "X.Option.One", type: "Int" }] });
    await sync.activateProgramOptions("w", "HA-1", "P.A");
    expect(port.objects.has("w.options.one")).toBe(true);
  });

  it("caches a well-formed program without options as empty", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const base = "/api/homeappliances/HA-1";
    port.getResponses.set(`${base}/programs/available/P.A`, { key: "P.A" });
    await sync.activateProgramOptions("w", "HA-1", "P.A");
    port.getCalls.length = 0;
    await sync.activateProgramOptions("w", "HA-1", "P.A");
    expect(port.getCalls).toHaveLength(0);
  });
});

describe("parseAppliancePath", () => {
  it("splits an appliance path into the decoded haId and the rest", () => {
    expect(parseAppliancePath("/api/homeappliances/BOSCH-HCS06COM1-A%2FB/programs/available/P.X")).toEqual({
      haId: "BOSCH-HCS06COM1-A/B",
      subpath: "/programs/available/P.X",
    });
    expect(parseAppliancePath("/api/homeappliances/015090396331005775")).toEqual({
      haId: "015090396331005775",
      subpath: "",
    });
  });
  it("answers nothing for a path that names no appliance or cannot be decoded", () => {
    expect(parseAppliancePath("/api/homeappliances")).toBeUndefined();
    expect(parseAppliancePath("/api/other/HA-1/status")).toBeUndefined();
    expect(parseAppliancePath("/api/homeappliances/%E0%A4%A/status")).toBeUndefined();
  });
});

describe("ApplianceSync appliance still initializing", () => {
  const base = "/api/homeappliances/HA-1";
  /**
   * A connected dishwasher whose status read answers "not ready yet".
   *
   * @returns the port and the sync, wired like main wires them
   */
  function initializing(): { port: FakePort; sync: ApplianceSync } {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [] });
    port.notReadyPaths.add(`${base}/status`);
    return { port, sync };
  }

  it("stops the pass at 'not ready' and reads the appliance again after 30 s", async () => {
    // Measured live (2026-09-18/20/23): the CONNECTED sync of an appliance that
    // was just switched on hit six "Connection.Initialization.Failed" answers in
    // a row, and nothing but a second online edge ever read it again.
    const { port, sync } = initializing();
    await sync.syncAppliances();
    expect(port.getCalls.filter(p => p.startsWith(base))).toEqual([`${base}/status`]);
    expect(port.pendingTimers().map(t => t.ms)).toEqual([30_000]);

    port.notReadyPaths.clear();
    port.fire();
    await flush();
    expect(port.getCalls).toContain(`${base}/settings`);
    expect(port.getCalls).toContain(`${base}/commands`);
    expect(port.pendingTimers()).toHaveLength(0);
  });

  it("backs off 30 → 60 → 120 s and then gives up quietly until the next reconnect", async () => {
    const { port, sync } = initializing();
    await sync.syncAppliances();
    const before = port.logs.length;
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      delays.push(...port.pendingTimers().map(t => t.ms));
      port.fire();
      await flush();
    }
    expect(delays).toEqual([30_000, 60_000, 120_000]);
    expect(port.pendingTimers()).toHaveLength(0);
    // An appliance that is not ready is a state, not a log line (fleet rule).
    expect(port.logs.slice(before).filter(l => !l.startsWith("debug"))).toEqual([]);
  });

  it("starts the back-off afresh after a successful read", async () => {
    const { port, sync } = initializing();
    await sync.syncAppliances();
    port.fire(); // 30 s: still not ready → 60 s armed
    await flush();
    port.notReadyPaths.clear();
    port.fire(); // ready now
    await flush();
    // Not ready again on a pass that is NOT a CONNECTED (the outage re-read):
    // only the successful read itself can have reset the back-off.
    port.notReadyPaths.add(`${base}/status`);
    await sync.syncAppliances();
    expect(port.pendingTimers().map(t => t.ms)).toEqual([30_000]);
  });

  it("keeps a single re-read per appliance when another pass meets 'not ready' meanwhile", async () => {
    const { port, sync } = initializing();
    await sync.syncAppliances();
    await sync.syncAppliances();
    expect(port.pendingTimers().map(t => t.ms)).toEqual([30_000]);
  });

  it("arms no re-read for a pass that meets 'not ready' after the stop", async () => {
    const { port, sync } = initializing();
    // The stop lands while the status read is in flight.
    port.onGet = path => {
      if (path === `${base}/status`) {
        sync.stop();
      }
    };
    await sync.syncAppliances();
    expect(port.timers).toHaveLength(0);
  });

  it("drops the pending re-read on CONNECTED, DISCONNECTED, DEPAIRED and stop", async () => {
    for (const end of ["CONNECTED", "DISCONNECTED", "DEPAIRED", "stop"]) {
      const { port, sync } = initializing();
      await sync.syncAppliances();
      const [armed] = port.pendingTimers();
      if (end === "stop") {
        sync.stop();
      } else {
        sync.handleStreamEvent({ event: end, id: "HA-1", data: JSON.stringify({ haId: "HA-1" }) });
      }
      await flush();
      expect(armed.cleared).toBe(true);
      // CONNECTED runs a fresh pass that meets "not ready" again: a NEW first stage.
      expect(port.pendingTimers().map(t => t.ms)).toEqual(end === "CONNECTED" ? [30_000] : []);
    }
  });

  it("ignores a report for a path that names no appliance, or a malformed one", async () => {
    const { port, sync } = initializing();
    await sync.syncAppliances();
    const armed = port.pendingTimers().length;
    // The appliance list itself, a foreign path and a broken escape: none may throw
    // out of the transport's report, none may touch a known appliance.
    expect(() => sync.noteNotReady("/api/homeappliances")).not.toThrow();
    expect(() => sync.noteNotReady("/api/other/HA-1/status")).not.toThrow();
    expect(() => sync.noteNotReady("/api/homeappliances/%E0%A4%A/status")).not.toThrow();
    expect(() => sync.noteUnsupportedProgram("/api/homeappliances")).not.toThrow();
    expect(port.pendingTimers()).toHaveLength(armed);
  });

  it("reads nothing once stopped, even when a re-read fires in the same moment", async () => {
    const { port, sync } = initializing();
    await sync.syncAppliances();
    const [armed] = port.pendingTimers();
    port.notReadyPaths.clear();
    sync.stop();
    port.getCalls.length = 0;
    armed.cb();
    await flush();
    expect(port.getCalls).toEqual([]);
  });
});

describe("ApplianceSync programs the API does not describe", () => {
  const base = "/api/homeappliances/HA-1";
  const auto30 = `${base}/programs/available/${encodeURIComponent("LaundryCare.WasherDryer.Program.Auto30")}`;

  it("asks for a refused program definition once per run, not on every selection", async () => {
    // Measured live (2026-09-16 → 2026-09-22): every turn of the dial to a program
    // the API does not know cost a definition request answered UnsupportedProgram.
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    port.unsupportedPaths.add(auto30);
    await sync.activateProgramOptions("w", "HA-1", "LaundryCare.WasherDryer.Program.Auto30");
    port.getResponses.set(`${base}/programs/available/P.Cotton`, { key: "P.Cotton", options: [] });
    await sync.activateProgramOptions("w", "HA-1", "P.Cotton");
    await sync.activateProgramOptions("w", "HA-1", "LaundryCare.WasherDryer.Program.Auto30");
    expect(port.getCalls.filter(p => p === auto30)).toHaveLength(1);
  });

  it("skips a refused program in the program-list sync as well", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    port.unsupportedPaths.add(auto30);
    appliance(port, "HA-1", "Waschtrockner", {
      type: "WasherDryer",
      available: ["LaundryCare.WasherDryer.Program.Auto30"],
    });
    await sync.syncAppliances();
    await sync.syncAppliances();
    expect(port.getCalls.filter(p => p === auto30)).toHaveLength(1);
  });

  it("forgets the refusals of an appliance that leaves the account", async () => {
    // A re-paired appliance may run other firmware; what was refused before is asked again.
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    port.unsupportedPaths.add(auto30);
    appliance(port, "HA-1", "Waschtrockner", {
      type: "WasherDryer",
      available: ["LaundryCare.WasherDryer.Program.Auto30"],
    });
    await sync.syncAppliances();
    sync.handleStreamEvent({ event: "DEPAIRED", data: JSON.stringify({ haId: "HA-1" }), id: "HA-1" });
    await flush();
    await sync.syncAppliances();
    expect(port.getCalls.filter(p => p === auto30)).toHaveLength(2);
  });
});

/**
 * Put objects into the fake database the way the real one holds them: by type for the typed
 * listings, all of them in the live store, rooms/functions and aliases outside the namespace.
 *
 * @param port the fake port
 * @param objects the objects, by full id
 */
function seed(port: FakePort, objects: Record<string, unknown>): void {
  for (const [fullId, raw] of Object.entries(objects)) {
    const obj = { _id: fullId, ...(raw as object) } as unknown as ioBroker.Object;
    if (!fullId.startsWith(`${NS}.`)) {
      port.foreign.set(fullId, obj);
      continue;
    }
    const rel = fullId.slice(NS.length + 1);
    port.objects.set(rel, structuredClone(obj));
    if (obj.type === "device") {
      port.primeDevices[fullId] = obj;
    } else if (obj.type === "channel") {
      port.primeChannels[fullId] = obj;
    } else if (obj.type === "state") {
      port.primeStates[fullId] = obj;
    }
  }
}

describe("ApplianceSync device ids — the model and four characters of the appliance's own number", () => {
  it("names the device folder after the model code and the haId's last four characters, the app name stays the name", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "015090396331005775", "Geschirrspüler", { enumber: "SX87TX02CE/60", vib: "SX87TX02CE" });
    await sync.syncAppliances();

    // The E-number names the MODEL — every machine of that model carries it. The last
    // four characters of the haId name THIS machine; the mutable app name stays the name.
    expect(port.objects.has("sx87tx02ce-5775")).toBe(true);
    expect(port.objects.get("sx87tx02ce-5775")?.common?.name).toBe("Geschirrspüler");
    // Decided under the current rule — the mark rides in the same write as the device object.
    expect(port.objects.get("sx87tx02ce-5775")?.native).toMatchObject({ idScheme: 3, haId: "015090396331005775" });
    expect(port.objects.has("sx87tx02ce-60")).toBe(false);
  });

  it("takes the E-number without its variant when the record has no model code", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "875070392600001079", "Waschtrockner", { type: "WasherDryer", enumber: "WN54C2A40/05" });
    await sync.syncAppliances();
    expect(port.objects.has("wn54c2a40-1079")).toBe(true);
  });

  it("gives two appliances of the identical model two trees, each named by its own number", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-AAAA1111", "Geschirrspüler", { enumber: "SX87TX02CE/60" });
    appliance(port, "HA-BBBB2222", "Geschirrspüler unten", { enumber: "SX87TX02CE/60" });
    await sync.syncAppliances();

    // Neither is "the first one" with a bare id: both carry their number.
    expect(port.objects.has("sx87tx02ce-1111")).toBe(true);
    expect(port.objects.has("sx87tx02ce-2222")).toBe(true);
    expect(port.objects.get("sx87tx02ce-2222")?.common?.name).toBe("Geschirrspüler unten");
  });

  it("gives the whole number to an appliance whose four characters another one of the model already holds", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    seed(port, {
      [`${NS}.sx87tx02ce-5775`]: {
        type: "device",
        common: { name: "Spüler oben" },
        native: { haId: "015090396331005775", vib: "SX87TX02CE", idScheme: 3 },
      },
    });
    await sync.primeFromObjects();
    appliance(port, "015090396331005775", "Spüler oben", { vib: "SX87TX02CE" });
    appliance(port, "015090396331015775", "Spüler unten", { vib: "SX87TX02CE" });
    await sync.syncAppliances();

    // The pinned one keeps its id; the newcomer gets the long form — never the same tree.
    expect(port.objects.get("sx87tx02ce-5775")?.common?.name).toBe("Spüler oben");
    expect(port.objects.get("sx87tx02ce-015090396331015775")?.common?.name).toBe("Spüler unten");
  });

  it("keeps the id when the appliance is renamed in the app — only the name follows", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "015090396331005775", "Geschirrspüler", { vib: "SX87TX02CE" });
    await sync.syncAppliances();
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "015090396331005775", name: "Spüler Küche", connected: true, vib: "SX87TX02CE" }],
    });
    await sync.syncAppliances();
    expect([...port.objects.keys()].filter(k => !k.includes("."))).toEqual(["sx87tx02ce-5775"]);
    expect(port.objects.get("sx87tx02ce-5775")?.common?.name).toBe("Spüler Küche");
  });
});

describe("ApplianceSync.migrateDeviceIds", () => {
  const OLD = `${NS}.sx87tx02ce-60`;
  const NEW = `${NS}.sx87tx02ce-5775`;

  /**
   * The dishwasher's tree as 1.23.x left it: named after the E-number, with a recording, a room,
   * an alias and a value.
   *
   * @param port the fake port to fill
   * @param root the old device id
   */
  function eNumberTree(port: FakePort, root = "sx87tx02ce-60"): void {
    const full = `${NS}.${root}`;
    seed(port, {
      [full]: {
        type: "device",
        common: { name: "Geschirrspüler", statusStates: { onlineId: `${full}.info.reachable` } },
        native: { haId: "015090396331005775", type: "Dishwasher", enumber: "SX87TX02CE/60", vib: "SX87TX02CE" },
      },
      [`${full}.settings`]: { type: "channel", common: { name: "Settings" }, native: {} },
      [`${full}.settings.childLock`]: {
        type: "state",
        common: {
          name: "Kindersicherung",
          type: "boolean",
          role: "switch",
          read: true,
          write: true,
          custom: { "influxdb.0": { enabled: true } },
        },
        native: { bshKey: "BSH.Common.Setting.ChildLock" },
      },
      "enum.rooms.kitchen": { type: "enum", common: { name: "Kitchen", members: [full, "hm-rpc.0.X.1"] }, native: {} },
      "alias.0.kitchen.childLock": {
        type: "state",
        common: { name: "Lock", alias: { id: `${full}.settings.childLock` } },
        native: {},
      },
    });
    port.states.set(`${root}.settings.childLock`, true);
    port.stateMeta.set(`${root}.settings.childLock`, { ts: 1000, lc: 900, q: 0 });
  }

  it("moves an E-number tree to the model and the number's last four characters, carrying everything attached", async () => {
    const port = new FakePort();
    eNumberTree(port);
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();

    // The journal goes on the OLD device object first — an interrupted move is finished next start.
    expect(port.extendCalls[0]).toBe("sx87tx02ce-60");
    const device = port.objects.get("sx87tx02ce-5775") as ioBroker.Object;
    expect(device.common.name).toBe("Geschirrspüler");
    expect(device.common.statusStates?.onlineId).toBe(`${NEW}.info.reachable`);
    expect(device.native).toMatchObject({ idScheme: 3, haId: "015090396331005775" });
    expect(device.native.movingTo).toBeUndefined();
    // The recording goes on in its series under the old id.
    expect(port.objects.get("sx87tx02ce-5775.settings.childLock")?.common).toMatchObject({
      name: "Kindersicherung",
      custom: { "influxdb.0": { enabled: true, aliasId: `${OLD}.settings.childLock` } },
    });
    expect(port.states.get("sx87tx02ce-5775.settings.childLock")).toBe(true);
    expect(port.stateMeta.get("sx87tx02ce-5775.settings.childLock")).toEqual({ ts: 1000, lc: 900, q: 0 });
    // Rooms and aliases follow.
    expect((port.foreign.get("enum.rooms.kitchen")?.common as { members: string[] }).members).toEqual([
      NEW,
      "hm-rpc.0.X.1",
    ]);
    expect((port.foreign.get("alias.0.kitchen.childLock")?.common as { alias: unknown }).alias).toEqual({
      id: `${NEW}.settings.childLock`,
    });
    expect([...port.objects.keys()].filter(k => k.startsWith("sx87tx02ce-60"))).toEqual([]);
    expect(port.logs.filter(l => l.startsWith("info"))).toEqual([
      'info: Appliance "Geschirrspüler": device id is now sx87tx02ce-5775 (was sx87tx02ce-60) — moved 1 datapoint(s) ' +
        "with 1 room/function entry, 1 alias(es); 1 recording(s) keep their history",
    ]);
  });

  it("moves a name-based tree of 1.12 the same way", async () => {
    const port = new FakePort();
    eNumberTree(port, "geschirrspueler");
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    expect(port.objects.has("sx87tx02ce-5775.settings.childLock")).toBe(true);
    expect(port.objects.has("geschirrspueler")).toBe(false);
  });

  it("leaves a tree alone that carries the mark", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.anything-else`]: {
        type: "device",
        common: { name: "Geschirrspüler" },
        native: { haId: "015090396331005775", vib: "SX87TX02CE", idScheme: 3 },
      },
    });
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    expect(port.deleted).toEqual([]);
    expect(port.extendCalls).toEqual([]);
    expect(port.logs.filter(l => l.startsWith("info"))).toEqual([]);
  });

  it("only marks a tree whose id already follows the rule", async () => {
    const port = new FakePort();
    seed(port, {
      [NEW]: { type: "device", common: { name: "Spüler" }, native: { haId: "015090396331005775", vib: "SX87TX02CE" } },
    });
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    expect(port.deleted).toEqual([]);
    expect(port.objects.get("sx87tx02ce-5775")?.native).toMatchObject({ idScheme: 3 });
  });

  it("keeps a tree whose stored native has no plate data yet (moves on a later start)", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.geschirrspueler`]: { type: "device", common: { name: "Geschirrspüler" }, native: { haId: "HA-1" } },
    });
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    // Guessing an id here would move the tree twice (once now, once when the model arrives).
    expect(port.deleted).toEqual([]);
    expect(port.extendCalls).toEqual([]);
  });

  it("never merges into an id another appliance holds — this one gets its whole number", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.geschirrspueler`]: {
        type: "device",
        common: { name: "Geschirrspüler" },
        native: { haId: "015090396331005775", enumber: "SX87TX02CE/60" },
      },
      // Another appliance a user happened to NAME like the dishwasher's new id.
      [NEW]: { type: "device", common: { name: "Fridge" }, native: { haId: "HA-BBBB2222", enumber: "KG49NSBBF/03" } },
    });
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();

    expect(port.objects.get("sx87tx02ce-015090396331005775")?.common?.name).toBe("Geschirrspüler");
    expect(port.objects.get("kg49nsbbf-2222")?.common?.name).toBe("Fridge");
    expect(port.objects.has("geschirrspueler")).toBe(false);
    expect(port.objects.has("sx87tx02ce-5775")).toBe(false);
  });

  it("hands out the ids in haId order, whatever order the database lists the trees in", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.sx87tx02ce-60`]: {
        type: "device",
        common: { name: "Unten" },
        native: { haId: "015090396331015775", enumber: "SX87TX02CE/60" },
      },
      [`${NS}.sx87tx02ce-60-5775`]: {
        type: "device",
        common: { name: "Oben" },
        native: { haId: "015090396331005775", enumber: "SX87TX02CE/60" },
      },
    });
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    expect(port.objects.get("sx87tx02ce-5775")?.common?.name).toBe("Oben");
    expect(port.objects.get("sx87tx02ce-015090396331015775")?.common?.name).toBe("Unten");
  });

  it("finishes a journaled move whose copy was complete, without copying again", async () => {
    const port = new FakePort();
    eNumberTree(port);
    const old = port.objects.get("sx87tx02ce-60") as ioBroker.Object;
    old.native.movingTo = "sx87tx02ce-5775";
    port.primeDevices[OLD] = structuredClone(old);
    seed(port, {
      [NEW]: {
        type: "device",
        common: { name: "Geschirrspüler" },
        native: { haId: "015090396331005775", vib: "SX87TX02CE", idScheme: 3 },
      },
      [`${NEW}.settings.childLock`]: { type: "state", common: { name: "Moved" }, native: {} },
    });
    port.states.set("sx87tx02ce-5775.settings.childLock", false);
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    expect(port.objects.get("sx87tx02ce-5775.settings.childLock")?.common?.name).toBe("Moved");
    expect(port.states.get("sx87tx02ce-5775.settings.childLock")).toBe(false);
    expect(port.objects.has("sx87tx02ce-60")).toBe(false);
    // The room follows at the delete, even on the resumed run.
    expect((port.foreign.get("enum.rooms.kitchen")?.common as { members: string[] }).members).toContain(NEW);
  });

  it("finishes a journaled move to the id it was decided for, even where the rule would give another today", async () => {
    const port = new FakePort();
    eNumberTree(port);
    // Decided in a run where another dishwasher of the model held the short id — that one is gone.
    const old = port.objects.get("sx87tx02ce-60") as ioBroker.Object;
    old.native.movingTo = "sx87tx02ce-015090396331005775";
    port.primeDevices[OLD] = structuredClone(old);
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    expect(port.objects.has("sx87tx02ce-015090396331005775.settings.childLock")).toBe(true);
    expect(port.objects.has("sx87tx02ce-5775")).toBe(false);
  });

  it("keeps the journal and the old tree when the copy fails — the next start tries again", async () => {
    const port = new FakePort();
    eNumberTree(port);
    port.getForeignStates = (): Promise<Record<string, ioBroker.State>> => Promise.reject(new Error("db busy"));
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    expect(port.objects.get("sx87tx02ce-60")?.native).toMatchObject({ movingTo: "sx87tx02ce-5775" });
    expect(port.objects.has("sx87tx02ce-60.settings.childLock")).toBe(true);
    expect(port.logs.filter(l => l.startsWith("warn"))).toEqual([
      'warn: Appliance "Geschirrspüler": could not move sx87tx02ce-60 to sx87tx02ce-5775 (db busy) — tried again on the next start',
    ]);
  });
});

describe("ApplianceSync priming around an unfinished move", () => {
  it("routes the appliance to the new tree while the old one only waits for its delete", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.sx87tx02ce-60`]: {
        type: "device",
        common: { name: "Old" },
        native: { haId: "015090396331005775", movingTo: "sx87tx02ce-5775" },
      },
      [`${NS}.sx87tx02ce-5775`]: {
        type: "device",
        common: { name: "New" },
        native: { haId: "015090396331005775", idScheme: 3 },
      },
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    sync.handleStreamEvent({ event: "DISCONNECTED", id: "015090396331005775", data: "{}" });
    await flush();
    expect(port.states.get("sx87tx02ce-5775.info.reachable")).toBe(false);
    expect(port.states.has("sx87tx02ce-60.info.reachable")).toBe(false);
  });

  it("runs under the old id when the journal names a tree that does not exist yet", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.sx87tx02ce-60`]: {
        type: "device",
        common: { name: "Old" },
        native: { haId: "015090396331005775", movingTo: "sx87tx02ce-5775" },
      },
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    sync.handleStreamEvent({ event: "DISCONNECTED", id: "015090396331005775", data: "{}" });
    await flush();
    expect(port.states.get("sx87tx02ce-60.info.reachable")).toBe(false);
  });
});

describe("ApplianceSync display names", () => {
  it("gives channels, the marker and the buttons translated names", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Washer", {
      type: "Washer",
      status: [],
      available: ["LaundryCare.Washer.Program.Cotton"],
      commands: [
        { key: "BSH.Common.Command.PauseProgram", name: "Programm pausieren" },
        { key: "BSH.Common.Command.AcknowledgeEvent", name: "OK" },
      ],
    });
    await sync.syncAppliances();
    // The adapter's own structure is translated; Admin renders the viewer's language.
    expect(port.objects.get("washer-1.events")?.common?.name).toMatchObject({ en: "Events", de: "Ereignisse" });
    expect(port.objects.get("washer-1.info")?.common?.name).toMatchObject({ en: "Information", de: "Informationen" });
    expect(port.objects.get("washer-1.programs")?.common?.name).toMatchObject({ en: "Programs", de: "Programme" });
    expect(port.objects.get("washer-1.info.reachable")?.common?.name).toMatchObject({
      en: "Connected to Home Connect",
    });
    expect(port.objects.get("washer-1.programs.start")?.common?.name).toMatchObject({ en: "Start selected program" });
    // Our own name wins over the cloud's single-language one, and the
    // EXPLANATION belongs to the BSH key either way.
    const pause = port.objects.get("washer-1.commands.pauseProgram");
    expect(pause?.common?.name).toMatchObject({ de: "Programm anhalten" });
    expect(pause?.common?.desc).toEqual(tName("cmdPauseProgramDesc"));
    // One the adapter does have texts for gets ours, not the terse cloud "OK".
    const ack = port.objects.get("washer-1.commands.acknowledgeEvent");
    expect(ack?.common?.name).toMatchObject({ de: "Meldung quittieren", en: "Acknowledge message" });
    expect(ack?.common?.desc).toMatchObject({ de: "Bestätigt eine Meldung am Gerät, wie der OK-Knopf dort." });
    expect(ack?.native).toMatchObject({ nameSource: "i18n" });
  });

  it("stores the cloud name and the technical key on every item", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", {
      status: [
        { key: "BSH.Common.Status.OperationState", name: "Betriebszustand", value: "x.EnumType.OperationState.Ready" },
      ],
      settings: [{ key: "BSH.Common.Setting.ChildLock", value: false }],
    });
    await sync.syncAppliances();
    const op = port.objects.get("oven-1.status.operationState");
    expect(op?.common?.name).toMatchObject({ de: "Betriebszustand", en: "Operating state" });
    expect(op?.common?.desc).toMatchObject({ de: "Betriebszustand: aus, bereit, läuft, pausiert, fertig, Störung." });
    // No name from the cloud → the adapter's own translated fallback, never the
    // bare id and never an English label in a German tree.
    expect(port.objects.get("oven-1.settings.childLock")?.common?.name).toEqual(tName("setChildLock"));
    // Where the name came from is remembered, so no later label replaces it.
    expect(op?.native).toMatchObject({ nameSource: "i18n" });
  });

  it("upgrades an older object that still carries the id as its name — once", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.oven`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.oven.settings.childLock`]: {
        _id: "",
        type: "state",
        common: { name: "childLock", type: "boolean", role: "switch", read: true, write: true, def: false },
        native: { bshKey: "BSH.Common.Setting.ChildLock" },
      } as unknown as ioBroker.Object,
    };
    for (const [fullId, obj] of Object.entries(port.primeStates)) {
      port.objects.set(fullId.slice(`${NS}.`.length), obj);
    }
    appliance(port, "HA-1", "Oven", {
      settings: [{ key: "BSH.Common.Setting.ChildLock", name: "Kindersicherung", value: false }],
      status: [],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();
    const obj = port.objects.get("oven.settings.childLock");
    expect(obj?.common?.name).toMatchObject({ de: "Kindersicherung" });
    expect(obj?.common?.desc).toMatchObject({ de: "Kindersicherung: Tasten am Gerät gesperrt." });

    // The second sync finds nothing to change — no object write per sync.
    port.extendCalls.length = 0;
    await sync.syncAppliances();
    expect(port.extendCalls).not.toContain("oven.settings.childLock");
  });

  it("replaces a name typed in the object browser, and never downgrades a cloud name to a derived one", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.oven`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.oven.settings.childLock`]: {
        _id: "",
        type: "state",
        common: { name: "Mein Schloss", type: "boolean", role: "switch", read: true, write: true, def: false },
        native: { bshKey: "BSH.Common.Setting.ChildLock", nameSource: "derived" },
      } as unknown as ioBroker.Object,
      [`${NS}.oven.settings.powerState`]: {
        _id: "",
        type: "state",
        common: { name: "Betriebsart", type: "string", role: "text", read: true, write: true },
        native: { bshKey: "BSH.Common.Setting.PowerState", nameSource: "api" },
      } as unknown as ioBroker.Object,
    };
    for (const [fullId, obj] of Object.entries(port.primeStates)) {
      port.objects.set(fullId.slice(`${NS}.`.length), obj);
    }
    appliance(port, "HA-1", "Oven", {
      settings: [
        { key: "BSH.Common.Setting.ChildLock", name: "Kindersicherung", value: false },
        // This sync carries no name for powerState (a value-only shape).
        { key: "BSH.Common.Setting.PowerState", value: "x.EnumType.PowerState.On" },
      ],
      status: [],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();
    // "Mein Schloss" was typed into the adapter's datapoint — the adapter's name wins.
    expect(port.objects.get("oven.settings.childLock")?.common?.name).toMatchObject({ de: "Kindersicherung" });
    // powerState has a table entry, so our own translated name wins over the
    // cloud's "Betriebsart" — one text in eleven languages instead of one.
    expect(port.objects.get("oven.settings.powerState")?.common?.name).toEqual(tName("setPowerState"));
  });

  it("keeps its own event name when the appliance sends its text over the stream", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Geschirrspüler", { status: [] });
    await sync.syncAppliances();
    const id = "geschirrspueler-1.events.saltNearlyEmpty";
    expect(port.objects.get(id)?.common?.name).toMatchObject({ de: "Salz fast leer" });
    port.extendCalls.length = 0;

    const frame = JSON.stringify({
      items: [
        {
          key: "Dishcare.Dishwasher.Event.SaltNearlyEmpty",
          name: "Salz fast leer",
          value: "BSH.Common.EnumType.EventPresentState.Present",
        },
      ],
    });
    sync.handleStreamEvent({ event: "EVENT", id: "HA-1", data: frame });
    await flush();
    // The appliance sends its own text in ONE language; ours covers eleven, so
    // ours stays (krobi 2026-09-02).
    expect(port.objects.get(id)?.common?.name).toMatchObject({ de: "Salz fast leer", en: "Salt nearly empty" });
    expect(port.states.get(id)).toBe(true);
    // The same frame again writes the value only — no object churn (#387).
    port.extendCalls.length = 0;
    sync.handleStreamEvent({ event: "EVENT", id: "HA-1", data: frame });
    await flush();
    expect(port.extendCalls).toEqual([]);
  });

  it("cleans the appliance name before it becomes the device name and the log label", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "HA-1", name: "Back\nofen", connected: false, type: { evil: true }, enumber: "HBG1" }],
    });
    await sync.syncAppliances();
    const device = port.objects.get("hbg1-1");
    expect(device?.common?.name).toBe("Back ofen");
    // Only strings reach native — the cloud's odd type object is not stored.
    expect((device?.native as { type?: unknown }).type).toBeUndefined();
    expect(port.logs.some(l => l.includes("\n"))).toBe(false);
  });
});

describe("ApplianceSync typed writes", () => {
  /** An oven primed with a boolean setting and a numeric option. */
  function oven(): { port: FakePort; sync: ApplianceSync } {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.oven`]: { _id: "", type: "device", common: {}, native: { haId: "HA-1" } } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.oven.settings.childLock`]: {
        _id: "",
        type: "state",
        common: { type: "boolean", write: true },
        native: { bshKey: "BSH.Common.Setting.ChildLock" },
      } as unknown as ioBroker.Object,
      [`${NS}.oven.settings.setpointTemperature`]: {
        _id: "",
        type: "state",
        common: { type: "number", write: true },
        native: { bshKey: "Cooking.Oven.Setting.SetpointTemperature" },
      } as unknown as ioBroker.Object,
    };
    return { port, sync: new ApplianceSync(port) };
  }

  it("sends and confirms the typed value, not the script's text", async () => {
    const { port, sync } = oven();
    await sync.primeFromObjects();
    await sync.handleWrite(`${NS}.oven.settings.childLock`, "true");
    expect(port.writes[0]?.body).toEqual({ key: "BSH.Common.Setting.ChildLock", value: true });
    // The ack carries what was sent — a string in a boolean state would be a
    // type violation the next reader trips over.
    expect(port.states.get("oven.settings.childLock")).toBe(true);

    await sync.handleWrite(`${NS}.oven.settings.setpointTemperature`, "180");
    expect(port.writes[1]?.body).toEqual({ key: "Cooking.Oven.Setting.SetpointTemperature", value: 180 });
    expect(port.states.get("oven.settings.setpointTemperature")).toBe(180);
  });

  it("does not send a value that cannot be read as the state's type", async () => {
    const { port, sync } = oven();
    await sync.primeFromObjects();
    await sync.handleWrite(`${NS}.oven.settings.setpointTemperature`, "hot");
    // "hot" would only produce a server-side error — and an ack of nonsense.
    expect(port.writes).toEqual([]);
    expect(port.states.has("oven.settings.setpointTemperature")).toBe(false);
    expect(port.logs.some(l => l.startsWith("debug") && l.includes("is not a number"))).toBe(true);
  });
});

describe("ApplianceSync.migrateRenamedStates names", () => {
  it("gives a moved state the adapter's current label, whatever stood on the old object", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.fridge`]: {
        _id: "",
        type: "device",
        common: {},
        native: { haId: "HA-F", type: "FridgeFreezer" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.fridge.misc.brightness`]: {
        _id: "",
        type: "state",
        common: { name: "Innenlicht", type: "number", role: "value", write: false },
        native: { bshKey: "Refrigeration.Common.Setting.Light.Internal.Brightness" },
      } as unknown as ioBroker.Object,
      [`${NS}.fridge.misc.freezerdoor`]: {
        _id: "",
        type: "state",
        common: { name: "freezerdoor", type: "string", role: "text", write: false },
        native: { bshKey: "Refrigeration.Common.Status.Door.Freezer" },
      } as unknown as ioBroker.Object,
    };
    for (const [fullId, obj] of Object.entries(port.primeStates)) {
      port.objects.set(fullId.slice(`${NS}.`.length), obj);
    }
    // A value makes this a same-shape (1:1) move — the path that copies the old metadata.
    port.states.set("fridge.misc.brightness", 70);
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    // "Innenlicht" was typed into the adapter's datapoint; the adapter owns the name —
    // and its own name reaches every language, which a hand-typed one never does.
    expect(port.objects.get("fridge.settings.lightInternalBrightness")?.common?.name).toEqual(
      tName("setLightInternalBrightness"),
    );
    // The old id as a name is replaced as well.
    expect(port.objects.get("fridge.status.doorFreezerOpen")?.common?.name).toMatchObject({ en: "Freezer door open" });
    expect(port.objects.get("fridge.status.doorFreezerOpen")?.common?.desc).toMatchObject({
      de: "Eigene Tür je Fach, zum Beispiel Kühlteil und Gefrierteil.",
    });
  });
});

describe("ApplianceSync gaps found by the 2026-09-02 mutation audit", () => {
  it("arms the write gate for the selected program during the sync itself", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const base = "/api/homeappliances/HA-1";
    appliance(port, "HA-1", "Washer", { type: "Washer", status: [], available: ["P.Cotton"] });
    port.getResponses.set(`${base}/programs/selected`, { key: "P.Cotton" });
    port.getResponses.set(`${base}/programs/available/P.Cotton`, {
      options: [{ key: "LaundryCare.Washer.Option.SpinSpeed", type: "Int" }],
    });
    await sync.syncAppliances();
    // The option object exists either way (union of all programs). Only the gate
    // decides whether a write is SENT — without arming it on sync, every write
    // after a restart is silently dropped until the user changes the program.
    await sync.handleWrite(`${NS}.washer-1.options.spinSpeed`, 800);
    expect(port.writes).toHaveLength(1);
  });

  it("creates the catalog events once — a re-sync rewrites no event object", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Geschirrspüler", { status: [] });
    await sync.syncAppliances();
    port.extendCalls.length = 0;
    await sync.syncAppliances();
    // Eleven event objects per dishwasher, rewritten on every CONNECTED, is the
    // object-tree churn this generation exists to avoid (#387).
    expect(port.extendCalls.filter(id => id.includes(".events."))).toEqual([]);
  });

  it("builds the program dropdown and the buttons from the cache when the list is refused", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: {
        _id: "",
        type: "device",
        common: {},
        native: {
          haId: "HA-1",
          type: "Washer",
          enumber: "WASHER",
          programOptions: { "LaundryCare.Washer.Program.Cotton": ["spinSpeed"] },
        },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    // A running washer: the API refuses /programs/available ("wrong operation
    // state") — the persisted cache knows the programs from an earlier run.
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "HA-1", name: "Washer", connected: true, type: "Washer", enumber: "WASHER" }],
    });
    port.getResponses.set("/api/homeappliances/HA-1/status", { status: [] });
    port.getResponses.set("/api/homeappliances/HA-1/programs/selected", {});
    port.getResponses.set("/api/homeappliances/HA-1/programs/active", {});
    await sync.syncAppliances();
    const selected = port.objects.get("washer.programs.selectedProgram");
    expect((selected?.native as { bshValues?: string[] })?.bshValues).toEqual(["LaundryCare.Washer.Program.Cotton"]);
    expect(port.objects.has("washer.programs.start")).toBe(true);
  });
});

describe("ApplianceSync metadata refresh without deleting (shelly model)", () => {
  it("drops a program that vanished from the dropdown and from the write candidates", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Dishwasher", { status: [] });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available", {
      programs: [{ key: "Dishcare.Dishwasher.Program.Eco50" }, { key: "Dishcare.Dishwasher.Program.Auto2" }],
    });
    await sync.syncAppliances();
    const id = "dishwasher-1.programs.selectedProgram";
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toMatchObject({
      eco50: "Eco 50 °C",
      auto2: "Auto 45-65 °C",
    });

    // A firmware update removes a program. extendObject merges key by key and
    // element by element, so without clearing first the gone program would stay
    // in the dropdown and stay resolvable on write.
    port.getResponses.set("/api/homeappliances/HA-1/programs/available", {
      programs: [{ key: "Dishcare.Dishwasher.Program.Eco50" }],
    });
    await sync.syncAppliances();

    const after = port.objects.get(id);
    expect((after?.common as ioBroker.StateCommon).states).toEqual({ "": "No program", eco50: "Eco 50 °C" });
    expect((after?.native as { bshValues: string[] }).bshValues).toEqual(["Dishcare.Dishwasher.Program.Eco50"]);
    // And still no delete anywhere on the way.
    expect(port.deleted).not.toContain(id);
  });

  it("keeps knowing the object carries a dropdown when a later answer brings none", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const key = "Dishcare.Dishwasher.Status.ProgramPhase";
    const phase = (v: string): string => `Dishcare.Dishwasher.EnumType.ProgramPhase.${v}`;
    appliance(port, "HA-1", "Dishwasher", {
      status: [{ key, value: phase("Drying"), constraints: { allowedvalues: [phase("Drying"), phase("Cleaning")] } }],
    });
    await sync.syncAppliances();
    const id = "dishwasher-1.status.programPhase";
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toEqual({
      drying: "Drying",
      cleaning: "Cleaning",
    });

    // The SAME status, delivered WITHOUT its constraints — a response carries
    // the subset the appliance reports right now (decision 6), and a single
    // failed `/settings/{key}` read has the same effect. The transform then has
    // no list at all: nothing is cleared, the object keeps the list it has.
    port.getResponses.set("/api/homeappliances/HA-1/status", { status: [{ key, value: phase("Drying") }] });
    await sync.syncAppliances();
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toEqual({
      drying: "Drying",
      cleaning: "Cleaning",
    });

    // …and when a real list comes back SHORTER, the clearing pass must still
    // run. Remembering "this one has no list" for the round above disarmed it:
    // the short list merged OVER the stale entries and a phase the appliance no
    // longer reports stayed in the dropdown for good.
    port.getResponses.set("/api/homeappliances/HA-1/status", {
      status: [{ key, value: phase("Drying"), constraints: { allowedvalues: [phase("Drying")] } }],
    });
    await sync.syncAppliances();
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toEqual({ drying: "Drying" });
    expect(port.deleted).toEqual([]);
  });

  it("keeps knowing the object carries write candidates when a refresh brings none", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const power = (v: string): string => `BSH.Common.EnumType.PowerState.${v}`;
    const setting = (access: string | undefined, values: string[]): unknown[] => [
      {
        key: "BSH.Common.Setting.PowerState",
        value: power("On"),
        constraints: { ...(access === undefined ? {} : { access }), allowedvalues: values },
      },
    ];
    appliance(port, "HA-1", "Dishwasher", {
      status: [],
      settings: setting(undefined, [power("On"), power("Off"), power("Standby")]),
    });
    await sync.syncAppliances();
    const id = "dishwasher-1.settings.powerState";

    // Read-only now: the transform writes no candidates, and a merge removes
    // nothing — they stand in the object untouched.
    port.getResponses.set("/api/homeappliances/HA-1/settings", {
      settings: setting("read", [power("On"), power("Off"), power("Standby")]),
    });
    await sync.syncAppliances();
    expect((port.objects.get(id)?.native as { bshValues: string[] }).bshValues).toHaveLength(3);

    // Writable again with one value gone: the clearing pass has to run, or the
    // shorter list merges over the stale one and a value the appliance no
    // longer offers stays resolvable on write.
    port.getResponses.set("/api/homeappliances/HA-1/settings", {
      settings: setting(undefined, [power("On"), power("Off")]),
    });
    await sync.syncAppliances();
    expect((port.objects.get(id)?.native as { bshValues: string[] }).bshValues).toEqual([power("On"), power("Off")]);
  });

  it("does not forget the write candidates when only the dropdown was cleared", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const power = (v: string): string => `BSH.Common.EnumType.PowerState.${v}`;
    const setting = (access: string | undefined, values: string[]): unknown[] => [
      {
        key: "BSH.Common.Setting.PowerState",
        value: power("On"),
        constraints: { ...(access === undefined ? {} : { access }), allowedvalues: values },
      },
    ];
    appliance(port, "HA-1", "Dishwasher", {
      status: [],
      settings: setting(undefined, [power("On"), power("Off"), power("Standby")]),
    });
    await sync.syncAppliances();
    const id = "dishwasher-1.settings.powerState";
    expect((port.objects.get(id)?.native as { bshValues: string[] }).bshValues).toHaveLength(3);

    // The setting turns read-only: the dropdown is replaced (cleared first),
    // the write candidates are simply not written — nothing removed them, they
    // stand in the object. The second write fails, so the refresh is not done.
    port.getResponses.set("/api/homeappliances/HA-1/settings", {
      settings: setting("read", [power("On"), power("Off"), power("Standby")]),
    });
    const real = port.extendObject.bind(port);
    port.extendObject = (oid: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      const common = (obj as { common?: Record<string, unknown> }).common;
      if (oid === id && common?.states !== null && common?.type !== undefined) {
        return Promise.reject(new Error("objects db down"));
      }
      return real(oid, obj);
    };
    await sync.syncAppliances();
    port.extendObject = real;

    // Writable again, and the appliance dropped one value. Recording "no write
    // candidates" for the failed round above disarmed the clearing pass: the
    // shorter list merged over the stale one and left a value the appliance no
    // longer offers resolvable on write.
    port.getResponses.set("/api/homeappliances/HA-1/settings", {
      settings: setting(undefined, [power("On"), power("Off")]),
    });
    await sync.syncAppliances();
    expect((port.objects.get(id)?.native as { bshValues: string[] }).bshValues).toEqual([power("On"), power("Off")]);
  });

  it("never deletes a state object to change its metadata", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", {
      status: [],
      settings: [{ key: "BSH.Common.Setting.ChildLock", value: false }],
    });
    await sync.syncAppliances();
    // A later sync brings a changed shape (the API now sends bounds).
    port.getResponses.set("/api/homeappliances/HA-1/settings", {
      settings: [{ key: "BSH.Common.Setting.ChildLock", value: false, constraints: { access: "read" } }],
    });
    await sync.syncAppliances();
    expect(port.objects.get("oven-1.settings.childLock")?.common).toMatchObject({ write: false });
    // Deleting and re-creating loses everything the object carries and leaves a
    // window in which it does not exist — the adapter merges instead.
    expect(port.deleted).toEqual([]);
  });
});

describe("ApplianceSync upgrade of a tree an older version left behind", () => {
  /**
   * The datapoints exactly as v1.13.0 wrote them, in both stores: the bare id as
   * name, no desc, no name source — and the user's recording configuration on
   * them, which no repair is allowed to touch.
   *
   * @param port the fake adapter port to seed
   */
  function legacyTree(port: FakePort): void {
    const custom = { "influxdb.0": { enabled: true } };
    const device = {
      _id: "",
      type: "device",
      common: { name: "Waschtrockner" },
      native: { haId: "HA-W", type: "WasherDryer", programOptions: { "P.A": ["one"] } },
    } as unknown as ioBroker.Object;
    port.primeDevices = { [`${NS}.washer`]: device };
    port.objects.set("washer", device);
    const states: Record<string, ioBroker.Object> = {
      // A catalog event: created upfront, never part of a REST answer.
      [`${NS}.washer.events.programFinished`]: {
        _id: "",
        type: "state",
        common: { name: "programFinished", type: "boolean", role: "indicator.alarm", read: true, write: false, custom },
        native: { bshKey: "BSH.Common.Event.ProgramFinished" },
      } as unknown as ioBroker.Object,
      // An option of a program that is not selected — the appliance does not
      // report it, so no sync ever passes by it again.
      [`${NS}.washer.options.spinSpeed`]: {
        _id: "",
        type: "state",
        common: { name: "spinSpeed", type: "string", role: "text", read: true, write: false, custom },
        native: { bshKey: "LaundryCare.Washer.Option.SpinSpeed" },
      } as unknown as ioBroker.Object,
      // An option the cloud had already named back then.
      [`${NS}.washer.options.intensivePlus`]: {
        _id: "",
        type: "state",
        common: { name: "Intensiv Plus", type: "boolean", role: "switch", read: true, write: true },
        native: { bshKey: "LaundryCare.Washer.Option.IntensivePlus" },
      } as unknown as ioBroker.Object,
      // The online marker: the adapter's own datapoint, without a BSH key.
      [`${NS}.washer.info.reachable`]: {
        _id: "",
        type: "state",
        common: { name: "reachable", type: "boolean", role: "indicator.reachable", read: true, write: false },
        native: {},
      } as unknown as ioBroker.Object,
    };
    port.primeStates = states;
    for (const [full, obj] of Object.entries(states)) {
      port.objects.set(full.slice(`${NS}.`.length), obj);
    }
    const channels: Record<string, ioBroker.Object> = {
      // The instance's own channels from the manifest stand FIRST, as they do in
      // the database: a repair that does not skip them stumbles over them before
      // it ever reaches the appliance's channels.
      [`${NS}.auth`]: {
        _id: "",
        type: "channel",
        common: { name: "Auth Information" },
        native: {},
      } as unknown as ioBroker.Object,
      [`${NS}.washer.events`]: {
        _id: "",
        type: "channel",
        common: { name: "events" },
        native: {},
      } as unknown as ioBroker.Object,
      [`${NS}.washer.options`]: {
        _id: "",
        type: "channel",
        common: { name: "options" },
        native: {},
      } as unknown as ioBroker.Object,
      // The instance's own channel from the manifest — must stay untouched.
      [`${NS}.info`]: {
        _id: "",
        type: "channel",
        common: { name: "Information" },
        native: {},
      } as unknown as ioBroker.Object,
    };
    port.primeChannels = channels;
    for (const [full, obj] of Object.entries(channels)) {
      port.objects.set(full.slice(`${NS}.`.length), obj);
    }
  }

  it("gives every stale datapoint a readable name and explanation, without a cloud request", async () => {
    const port = new FakePort();
    legacyTree(port);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    expect(port.getCalls).toEqual([]);
    expect(port.objects.get("washer.events.programFinished")?.common).toMatchObject({
      name: { de: "Programm beendet", en: "Program finished" },
      desc: { de: "Das laufende Programm ist fertig." },
    });
    // An option the cloud never named (the appliance was off when the tree was
    // built): the adapter's own translated name, not an English auto-label,
    // and its own explanation next to it.
    expect(port.objects.get("washer.options.spinSpeed")?.common).toMatchObject({
      name: { de: "Schleuderdrehzahl", en: "Spin speed" },
    });
    expect(port.objects.get("washer.options.spinSpeed")?.common?.desc).toMatchObject({
      en: "How fast the drum spins at the end — faster leaves the laundry drier.",
    });
    expect(port.objects.get("washer.events.programFinished")?.native).toMatchObject({ nameSource: "i18n" });
  });

  it("replaces a legacy cloud label with our own, and keeps the explanation", async () => {
    const port = new FakePort();
    legacyTree(port);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    const obj = port.objects.get("washer.options.intensivePlus");
    // The old tree carried the cloud's single-language text; ours reaches eleven.
    expect(obj?.common?.name).toEqual(tName("optIntensivePlus"));
    expect(obj?.common?.desc).toMatchObject({ en: "Washes longer and harder for heavily soiled laundry." });
    expect(obj?.native).toMatchObject({ nameSource: "i18n" });
  });

  it("still never downgrades a cloud name to a derived one, where we have no text", async () => {
    // The rule from decision 12 is unchanged for every key the text table does
    // NOT cover: there the cloud's name is the best there is, and the English
    // label `humanizeId` derives must not push it out.
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.washer`]: {
        _id: `${NS}.washer`,
        type: "device",
        common: { name: "Washer" },
        native: { haId: "HA-W", type: "Washer", enumber: "washer" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.washer.status.someKeyNoSourceDocuments`]: {
        _id: `${NS}.washer.status.someKeyNoSourceDocuments`,
        type: "state",
        common: { name: "Trommelauswuchtung", type: "string", role: "text", read: true, write: false },
        native: { bshKey: "LaundryCare.Washer.Status.SomeKeyNoSourceDocuments", nameSource: "api" },
      } as unknown as ioBroker.Object,
    };
    await new ApplianceSync(port).primeFromObjects();
    // Untouched: the label repair wrote nothing at all, so the cloud name and its
    // "api" stamp stand exactly as they were.
    expect(port.extendCalls).not.toContain("washer.status.someKeyNoSourceDocuments");
  });

  it("replaces a label derived from the id once the catalog learns the key", async () => {
    // Measured on a live tree (2026-09-12): a dishwasher reports
    // `BSH.Common.Status.Program.All.Count.Started`, no cloud source documents it,
    // and a status never carries a name over REST — so the datapoint wore the
    // English label `humanizeId` derives, in every language. A derived name is
    // silent by design: no static gate sees it, only the real tree does.
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.dishwasher`]: {
        _id: `${NS}.dishwasher`,
        type: "device",
        common: { name: "Geschirrspüler" },
        native: { haId: "HA-D", type: "Dishwasher", enumber: "dishwasher" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.dishwasher.status.programAllCountStarted`]: {
        _id: `${NS}.dishwasher.status.programAllCountStarted`,
        type: "state",
        common: {
          name: "Program all count started",
          type: "number",
          role: "value",
          read: true,
          write: false,
          custom: { "influxdb.0": { enabled: true } },
        },
        native: { bshKey: "BSH.Common.Status.Program.All.Count.Started", nameSource: "derived" },
      } as unknown as ioBroker.Object,
    };
    for (const [full, obj] of Object.entries(port.primeStates)) {
      port.objects.set(full.slice(`${NS}.`.length), obj);
    }
    await new ApplianceSync(port).primeFromObjects();

    const obj = port.objects.get("dishwasher.status.programAllCountStarted");
    // The catalog entry wins over the derived string — in all eleven languages,
    // with the explanation next to it and the recording configuration untouched.
    expect(obj?.common?.name).toEqual(tName("stProgramAllCountStarted"));
    expect(obj?.common?.desc).toMatchObject({ de: expect.stringContaining("Programme") });
    expect(obj?.native).toMatchObject({ nameSource: "i18n" });
    expect(obj?.common).toMatchObject({ custom: { "influxdb.0": { enabled: true } } });
    // Repairing a label is a merge, never a delete — and it costs no request.
    expect(port.deleted).toEqual([]);
    expect(port.getCalls).toEqual([]);
  });

  it("keeps the user's recording configuration through the repair", async () => {
    const port = new FakePort();
    legacyTree(port);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    expect(port.objects.get("washer.events.programFinished")?.common).toMatchObject({
      custom: { "influxdb.0": { enabled: true } },
    });
    expect(port.objects.get("washer.options.spinSpeed")?.common).toMatchObject({
      custom: { "influxdb.0": { enabled: true } },
    });
    expect(port.deleted).toEqual([]);
  });

  it("names the appliance channels and leaves the instance's own alone", async () => {
    const port = new FakePort();
    legacyTree(port);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    expect((port.objects.get("washer.events")?.common as { name: Record<string, string> }).name.en).toBe("Events");
    expect((port.objects.get("washer.options")?.common as { name: Record<string, string> }).name.en).toBe(
      "Program options",
    );
    expect(port.objects.get("info")?.common).toMatchObject({ name: "Information" });
    expect(port.objects.get("auth")?.common).toMatchObject({ name: "Auth Information" });
    // Only the two appliance channels were written at all.
    expect(port.extendCalls.filter(id => id.endsWith("events") || id.endsWith("options"))).toEqual([
      "washer.events",
      "washer.options",
    ]);
  });

  it("names an event datapoint that has no technical key stored on it either", async () => {
    const port = new FakePort();
    legacyTree(port);
    // A version old enough that it did not even remember the BSH key: the label
    // repair has nothing to go by, the type catalog is the only source left.
    const stale = {
      _id: "",
      type: "state",
      common: { name: "programAborted", type: "boolean", role: "indicator.alarm", read: true, write: false },
      native: {},
    } as unknown as ioBroker.Object;
    port.primeStates[`${NS}.washer.events.programAborted`] = stale;
    port.objects.set("washer.events.programAborted", stale);
    appliance(port, "HA-W", "Waschtrockner", { type: "WasherDryer", connected: true });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();

    expect(port.objects.get("washer.events.programAborted")?.common).toMatchObject({
      name: { de: "Programm abgebrochen" },
      desc: { de: "Das Programm wurde vorzeitig beendet." },
    });
  });

  it("does not re-stamp an object this version already repaired", async () => {
    const port = new FakePort();
    legacyTree(port);
    // Repaired by a current version: it carries OUR translated name and the stamp
    // that says where the name came from.
    const stamped = {
      _id: "",
      type: "state",
      common: {
        name: { de: "Schleuderdrehzahl", en: "Spin speed" },
        type: "string",
        role: "text",
        read: true,
        write: false,
      },
      native: { bshKey: "LaundryCare.Washer.Option.SpinSpeed", nameSource: "derived" },
    } as unknown as ioBroker.Object;
    port.primeStates[`${NS}.washer.options.spinSpeed`] = stamped;
    port.objects.set("washer.options.spinSpeed", stamped);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    // Without the "already stamped" branch the pre-1.15 path runs again: it reads
    // the translated name as one the cloud once delivered and freezes it as "api",
    // so no later name of ours could ever replace it.
    expect(port.objects.get("washer.options.spinSpeed")?.native).toMatchObject({ nameSource: "i18n" });
  });

  it("removes a technical description an older version left behind", async () => {
    const port = new FakePort();
    legacyTree(port);
    // v1.14.0 wrote the manufacturer's key into desc; for an option the adapter
    // does not know, nothing at all may stand there — an invented sentence would
    // be worse than none.
    const stale = {
      _id: "",
      type: "state",
      common: {
        name: "Sensitive",
        type: "string",
        role: "text",
        read: true,
        write: false,
        desc: "LaundryCare.Washer.Option.Sensitive",
      },
      native: { bshKey: "LaundryCare.Washer.Option.Sensitive", nameSource: "api" },
    } as unknown as ioBroker.Object;
    port.primeStates[`${NS}.washer.options.sensitive`] = stale;
    port.objects.set("washer.options.sensitive", stale);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    const obj = port.objects.get("washer.options.sensitive");
    expect(obj?.common?.desc ?? undefined).toBeUndefined();
    // The cloud name stays — only the key goes.
    expect(obj?.common?.name).toBe("Sensitive");
  });

  it("replaces a technical description with the adapter's explanation", async () => {
    const port = new FakePort();
    legacyTree(port);
    const stale = {
      _id: "",
      type: "state",
      common: {
        name: "Betriebszustand",
        type: "string",
        role: "text",
        read: true,
        write: false,
        desc: "BSH.Common.Status.OperationState",
      },
      native: { bshKey: "BSH.Common.Status.OperationState", nameSource: "api" },
    } as unknown as ioBroker.Object;
    port.primeStates[`${NS}.washer.status.operationState`] = stale;
    port.objects.set("washer.status.operationState", stale);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    const obj = port.objects.get("washer.status.operationState");
    expect(obj?.common?.desc).toMatchObject({
      de: "Betriebszustand: aus, bereit, läuft, pausiert, fertig, Störung.",
    });
    expect(obj?.common?.name).toEqual(tName("stOperationState"));
  });

  it("puts its own event name over one the cloud left on an older tree", async () => {
    const port = new FakePort();
    legacyTree(port);
    const stale = {
      _id: "",
      type: "state",
      common: { name: "Programm beendet!", type: "boolean", role: "indicator.alarm", read: true, write: false },
      native: { bshKey: "BSH.Common.Event.ProgramFinished" },
    } as unknown as ioBroker.Object;
    port.primeStates[`${NS}.washer.events.programFinished`] = stale;
    port.objects.set("washer.events.programFinished", stale);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    // Ours covers eleven languages, the old cloud text only one.
    expect(port.objects.get("washer.events.programFinished")?.common?.name).toMatchObject({
      de: "Programm beendet",
      en: "Program finished",
    });
  });

  it("names the online marker, which carries no technical key of its own", async () => {
    const port = new FakePort();
    legacyTree(port);
    appliance(port, "HA-W", "Waschtrockner", { type: "WasherDryer", connected: true });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();

    const common = port.objects.get("washer.info.reachable")?.common as {
      name: Record<string, string>;
      desc: Record<string, string>;
    };
    expect(common.name.en).toBe("Connected to Home Connect");
    expect(common.desc.de).toBe("Falsch, wenn das Gerät aus oder vom Netz getrennt ist.");
    expect(port.states.get("washer.info.reachable")).toBe(true);
  });

  it("repairs once and stays quiet on the next start", async () => {
    const port = new FakePort();
    legacyTree(port);
    await new ApplianceSync(port).primeFromObjects();
    // Second start on the now repaired tree: the objects are the primed ones.
    port.primeStates = Object.fromEntries(
      Object.keys(port.primeStates).map(id => [id, port.objects.get(id.slice(`${NS}.`.length)) as ioBroker.Object]),
    );
    port.primeChannels = Object.fromEntries(
      Object.keys(port.primeChannels).map(id => [id, port.objects.get(id.slice(`${NS}.`.length)) as ioBroker.Object]),
    );
    port.extendCalls.length = 0;
    await new ApplianceSync(port).primeFromObjects();
    expect(port.extendCalls).toEqual([]);
  });
});

describe("ApplianceSync findings of the 2026-09-04 audit", () => {
  /**
   * One appliance whose tree carries the datapoints a BSH key EXPANDS into:
   * a door status becomes `doorOpen` + `doorLocked`, the operation state
   * additionally feeds `programRunning`. All three store the key of the source
   * item, so a repair that assumes one key = one datapoint mislabels them.
   *
   * @param port the fake adapter port to seed
   * @param opts what the fixture should look like
   * @param opts.type the appliance type stored in the device native ("" = none yet)
   * @param opts.damaged seed the WRONG labels the previous version wrote
   */
  function expandedTree(port: FakePort, opts: { type?: string; damaged?: boolean } = {}): void {
    const type = opts.type ?? "WasherDryer";
    const device = {
      _id: "",
      type: "device",
      common: { name: "Waschtrockner" },
      native: { haId: "HA-W", ...(type ? { type } : {}), enumber: "washer" },
    } as unknown as ioBroker.Object;
    port.primeDevices = { [`${NS}.washer`]: device };
    port.objects.set("washer", device);
    const state = (id: string, common: Record<string, unknown>, bshKey: string): ioBroker.Object =>
      ({
        _id: "",
        type: "state",
        common: { type: "boolean", role: "indicator", read: true, write: false, ...common },
        native: { bshKey, nameSource: opts.damaged ? "derived" : "i18n" },
      }) as unknown as ioBroker.Object;
    // Damaged = what the label repair wrote before this fix: the name of the
    // SOURCE item on every expanded datapoint, and no explanation left.
    const states: Record<string, ioBroker.Object> = {
      [`${NS}.washer.status.doorOpen`]: state(
        "doorOpen",
        opts.damaged ? { name: "Door state" } : { name: tName("doorOpen"), desc: tName("doorOpenDesc") },
        "BSH.Common.Status.DoorState",
      ),
      [`${NS}.washer.status.doorLocked`]: state(
        "doorLocked",
        opts.damaged ? { name: "Door state" } : { name: tName("doorLocked"), desc: tName("doorLockedDesc") },
        "BSH.Common.Status.DoorState",
      ),
      [`${NS}.washer.status.programRunning`]: state(
        "programRunning",
        opts.damaged
          ? { name: "Operation state" }
          : { name: tName("programRunning"), desc: tName("programRunningDesc") },
        "BSH.Common.Status.OperationState",
      ),
      [`${NS}.washer.status.operationState`]: {
        _id: "",
        type: "state",
        common: { name: "Betriebszustand", desc: tName("operationStateDesc"), type: "string", role: "text" },
        native: { bshKey: "BSH.Common.Status.OperationState", nameSource: "api" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = states;
    for (const [full, obj] of Object.entries(states)) {
      port.objects.set(full.slice(`${NS}.`.length), obj);
    }
  }

  /**
   * The English rendering of a name/desc, whichever form it is stored in.
   *
   * @param value a plain string or a translation object
   * @returns the English text
   */
  function en(value: unknown): unknown {
    return value !== null && typeof value === "object" ? (value as Record<string, string>).en : value;
  }

  it("keeps every expanded datapoint's own name — one BSH key, several datapoints", async () => {
    const port = new FakePort();
    expandedTree(port);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    // Going through the 1:1 transform gave all three the source item's label:
    // doorOpen AND doorLocked both became "Door state", programRunning became
    // "Operation state" — and their explanations were removed as unexplainable.
    expect(en(port.objects.get("washer.status.doorOpen")?.common?.name)).toBe("Door open");
    expect(en(port.objects.get("washer.status.doorLocked")?.common?.name)).toBe("Door locked");
    expect(en(port.objects.get("washer.status.programRunning")?.common?.name)).toBe("Program running");
    expect(en(port.objects.get("washer.status.doorOpen")?.common?.desc)).toBe("True while the door stands open.");
    // operationState carried the cloud's single-language "Betriebszustand"; our
    // own text replaces it ONCE — every key we have a name for reaches all eleven
    // languages, and the cloud answers the same key differently per appliance.
    expect(port.objects.get("washer.status.operationState")?.common?.name).toEqual(tName("stOperationState"));
    // The second write is its list: the old tree stored the enum without one, and the catalogue knows it.
    expect(port.extendCalls).toEqual(["washer.status.operationState", "washer.status.operationState"]);
    expect((port.objects.get("washer.status.operationState")?.common as ioBroker.StateCommon).states).toMatchObject({
      run: "Running",
    });

    // And it really is once. A RESTART primes from the repaired objects, so there
    // must be nothing left to write — otherwise every start would rewrite every
    // datapoint that has a table entry (220 of them).
    const restarted = new FakePort();
    restarted.primeDevices = { [`${NS}.washer`]: port.objects.get("washer") as ioBroker.Object };
    restarted.primeChannels = { [`${NS}.washer.status`]: port.objects.get("washer.status") as ioBroker.Object };
    restarted.primeStates = Object.fromEntries(
      [...port.objects.entries()]
        .filter(([id, o]) => id.startsWith("washer.status.") && o.type === "state")
        .map(([id, o]) => [`${NS}.${id}`, { ...o, _id: `${NS}.${id}` } as ioBroker.Object]),
    );
    await new ApplianceSync(restarted).primeFromObjects();
    expect(restarted.extendCalls).toEqual([]);
  });

  it("heals a tree the previous version mislabelled — once", async () => {
    const port = new FakePort();
    expandedTree(port, { damaged: true });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    expect(en(port.objects.get("washer.status.doorOpen")?.common?.name)).toBe("Door open");
    expect(en(port.objects.get("washer.status.doorLocked")?.common?.name)).toBe("Door locked");
    expect(en(port.objects.get("washer.status.programRunning")?.common?.name)).toBe("Program running");
    expect(en(port.objects.get("washer.status.programRunning")?.common?.desc)).toBe(
      "Derived from the operation state, for scripts and visualisation.",
    );
    expect(port.objects.get("washer.status.doorOpen")?.native).toMatchObject({ nameSource: "i18n" });
    const repairs = port.extendCalls.length;
    expect(repairs).toBeGreaterThan(0);

    // Second start on the repaired tree: the objects are the primed ones, and
    // not a single object write is left — the repair is memory-guarded, so an
    // installation does not rewrite the same labels on every start.
    port.primeStates = Object.fromEntries(
      Object.keys(port.primeStates).map(id => [id, port.objects.get(id.slice(`${NS}.`.length)) as ioBroker.Object]),
    );
    port.extendCalls.length = 0;
    await new ApplianceSync(port).primeFromObjects();
    expect(port.extendCalls).toEqual([]);
  });

  it("leaves a datapoint alone when the device does not know its appliance type yet", async () => {
    const port = new FakePort();
    // No type in the device native (an early tree whose appliance has been
    // offline since): without it the adapter cannot know the door locks, so
    // doorLocked is not among the expanded states and must not be relabelled
    // with the source item's name.
    expandedTree(port, { type: "", damaged: true });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();

    expect(port.objects.get("washer.status.doorLocked")?.common?.name).toBe("Door state");
    expect(port.extendCalls).not.toContain("washer.status.doorLocked");
    // The door itself and programRunning need no type — they are repaired.
    expect(en(port.objects.get("washer.status.doorOpen")?.common?.name)).toBe("Door open");
    expect(en(port.objects.get("washer.status.programRunning")?.common?.name)).toBe("Program running");
  });

  it("does not remember a metadata refresh that failed halfway", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Dishwasher", {
      settings: [
        {
          key: "BSH.Common.Setting.PowerState",
          name: "Power",
          value: "BSH.Common.EnumType.PowerState.On",
          constraints: { allowedvalues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Off"] },
        },
      ],
      status: [],
    });
    await sync.syncAppliances();

    // A wider set of allowed values arrives → the refresh clears the two
    // merge-proof fields and writes them back. Let the WRITE-BACK fail.
    port.getResponses.set("/api/homeappliances/HA-1/settings", {
      settings: [
        {
          key: "BSH.Common.Setting.PowerState",
          name: "Power",
          value: "BSH.Common.EnumType.PowerState.On",
          constraints: {
            allowedvalues: [
              "BSH.Common.EnumType.PowerState.On",
              "BSH.Common.EnumType.PowerState.Off",
              "BSH.Common.EnumType.PowerState.Standby",
            ],
          },
        },
      ],
    });
    const real = port.extendObject.bind(port);
    port.extendObject = (id: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      const common = (obj as { common?: Record<string, unknown> }).common;
      if (id === "dishwasher-1.settings.powerState" && common?.states !== null && common?.type !== undefined) {
        return Promise.reject(new Error("objects db down"));
      }
      return real(id, obj);
    };
    await sync.syncAppliances();

    // Halfway: the selection list and the write candidates are gone.
    expect((port.objects.get("dishwasher-1.settings.powerState")?.common as ioBroker.StateCommon).states).toBeNull();

    // The next sync of the SAME run must put them back — remembering the new
    // signature for a failed refresh left the datapoint unusable until a restart.
    port.extendObject = real;
    await sync.syncAppliances();
    expect((port.objects.get("dishwasher-1.settings.powerState")?.common as ioBroker.StateCommon).states).toMatchObject(
      {
        on: "On",
        off: "Off",
        standby: "Standby",
      },
    );
    expect(
      (port.objects.get("dishwasher-1.settings.powerState")?.native as { bshValues: string[] }).bshValues,
    ).toContain("BSH.Common.EnumType.PowerState.Standby");
  });

  it("does not remember a failed refresh of an option definition either", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Dishwasher", { status: [], available: ["Dishcare.Dishwasher.Program.Eco50"] });
    const definition = (values: string[]): unknown => ({
      key: "Dishcare.Dishwasher.Program.Eco50",
      options: [
        {
          key: "Dishcare.Dishwasher.Option.IntensivZone",
          name: "Intensive zone",
          type: "Dishcare.Dishwasher.EnumType.IntensivZone",
          constraints: { allowedvalues: values },
        },
      ],
    });
    port.getResponses.set(
      "/api/homeappliances/HA-1/programs/available/Dishcare.Dishwasher.Program.Eco50",
      definition(["Dishcare.Dishwasher.EnumType.IntensivZone.Off"]),
    );
    await sync.syncAppliances();
    const id = "dishwasher-1.options.intensivZone";
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toMatchObject({ off: "Off" });

    // A newer definition generation brings a second allowed value; let the
    // write-back of the two merge-proof fields fail.
    port.getResponses.set(
      "/api/homeappliances/HA-1/programs/available/Dishcare.Dishwasher.Program.Eco50",
      definition(["Dishcare.Dishwasher.EnumType.IntensivZone.Off", "Dishcare.Dishwasher.EnumType.IntensivZone.On"]),
    );
    const device = port.objects.get("dishwasher-1") as { native?: Record<string, unknown> };
    device.native = { ...device.native, programOptions: {} };
    port.primeDevices = { [`${NS}.dishwasher-1`]: device as unknown as ioBroker.Object };
    const real = port.extendObject.bind(port);
    port.extendObject = (oid: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      const common = (obj as { common?: Record<string, unknown> }).common;
      if (oid === id && common?.states !== null && common?.type !== undefined) {
        return Promise.reject(new Error("objects db down"));
      }
      return real(oid, obj);
    };
    await sync.primeFromObjects();
    await sync.syncAppliances();
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toBeNull();

    // The next sync must put the selection list back instead of treating the
    // half-done refresh as the current state.
    port.extendObject = real;
    device.native = { ...device.native, programOptions: {} };
    port.primeDevices = { [`${NS}.dishwasher-1`]: device as unknown as ioBroker.Object };
    await sync.primeFromObjects();
    await sync.syncAppliances();
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toMatchObject({ off: "Off", on: "On" });
  });

  it("keeps every tree when the account answers with no appliance at all", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    appliance(port, "HA-2", "Dishwasher", { status: [] });
    await sync.syncAppliances();

    // HTTP 200 with an empty list takes the same path as "an appliance was
    // removed" — but a token that lost its appliance scope, an account move or a
    // cloud hiccup look exactly like this, and it would delete everything at once.
    port.getResponses.set("/api/homeappliances", { homeappliances: [] });
    await sync.syncAppliances();

    expect(port.objects.has("oven-1")).toBe(true);
    expect(port.objects.has("dishwasher-2")).toBe(true);
    expect(port.logs.some(l => l.startsWith("warn") && l.includes("no appliances at all"))).toBe(true);
  });
});

describe("ApplianceSync findings of the 2026-09-07 audit", () => {
  /**
   * Set up one dishwasher with two programs that each declare a DIFFERENT option,
   * program A selected in the cloud.
   *
   * @param port the fake adapter port to prime
   */
  function twoProgramDishwasher(port: FakePort): { haId: string; deviceId: string; a: string; b: string } {
    const haId = "HA-1";
    const base = `/api/homeappliances/${haId}`;
    const a = "Dishcare.Dishwasher.Program.Eco50";
    const b = "Dishcare.Dishwasher.Program.Intensiv70";
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId, name: "Geschirrspüler", connected: true, type: "Dishwasher", enumber: "SX87/60" }],
    });
    port.getResponses.set(`${base}/status`, { status: [] });
    port.getResponses.set(`${base}/settings`, { settings: [] });
    port.getResponses.set(`${base}/commands`, { commands: [] });
    port.getResponses.set(`${base}/programs/available`, { programs: [{ key: a }, { key: b }] });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(a)}`, {
      key: a,
      options: [
        { key: "BSH.Common.Option.StartInRelative", type: "Int", unit: "seconds", constraints: { min: 0, max: 86400 } },
      ],
    });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(b)}`, {
      key: b,
      options: [{ key: "Dishcare.Dishwasher.Option.IntensivZone", type: "Boolean", constraints: {} }],
    });
    port.getResponses.set(`${base}/programs/selected`, { key: a, options: [] });
    port.getResponses.set(`${base}/programs/active`, {});
    return { haId, deviceId: "sx87-1", a, b };
  }

  it("re-arms the option gate for a program selected AT THE APPLIANCE", async () => {
    const port = new FakePort();
    const { deviceId, b } = twoProgramDishwasher(port);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();

    // The user turns the knob on the machine: the selection arrives over the
    // stream, which carries the FULL program key.
    sync.handleStreamEvent({
      event: "NOTIFY",
      data: JSON.stringify({ haId: "HA-1", items: [{ key: "BSH.Common.Root.SelectedProgram", value: b }] }),
      id: undefined,
    });
    await flush();
    expect(port.states.get(`${deviceId}.programs.selectedProgram`)).toBe("intensiv70");

    // The gate must now belong to program B: its own option is writable …
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.${deviceId}.options.intensivZone`, true);
    expect(port.writes.map(w => w.path)).toEqual([
      "/api/homeappliances/HA-1/programs/selected/options/Dishcare.Dishwasher.Option.IntensivZone",
    ]);

    // … and a start carries B's options, not the ones of the program that was
    // selected before (the appliance rejects those, and the retry-with-defaults
    // silently drops whatever the user had configured).
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.${deviceId}.programs.start`, true);
    const start = port.writes.at(-1);
    expect(start?.body?.key).toBe(b);
    expect((start?.body?.options ?? []).map(o => o.key)).toEqual(["Dishcare.Dishwasher.Option.IntensivZone"]);
  });

  it("costs nothing when the same program is reported again", async () => {
    const port = new FakePort();
    const { a } = twoProgramDishwasher(port);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    port.getCalls.length = 0;

    for (let i = 0; i < 3; i++) {
      sync.handleStreamEvent({
        event: "NOTIFY",
        data: JSON.stringify({ haId: "HA-1", items: [{ key: "BSH.Common.Root.SelectedProgram", value: a }] }),
        id: undefined,
      });
      await flush();
    }
    // The daily request quota is 1000 — a repeated NOTIFY must not spend any of it.
    expect(port.getCalls.filter(p => p.includes("/programs/available/"))).toEqual([]);
  });

  it("retries a label write that failed, in the same run", async () => {
    const port = new FakePort();
    const haId = "HA-1";
    const base = `/api/homeappliances/${haId}`;
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId, name: "Geschirrspüler", connected: false, type: "Dishwasher", enumber: "SX87/60" }],
    });
    const deviceId = "sx87-60";
    const eventId = `${deviceId}.events.programFinished`;
    port.getResponses.set(`${base}/programs/available`, { programs: [] });

    // A tree an older version left behind: the datapoint carries the bare id.
    const legacy = {
      type: "state",
      common: { name: "programFinished", type: "boolean", role: "indicator.alarm", read: true, write: false },
      native: { bshKey: "BSH.Common.Event.ProgramFinished" },
    } as unknown as ioBroker.Object;
    port.primeDevices = {
      [`${NS}.${deviceId}`]: {
        type: "device",
        common: { name: "Geschirrspüler" },
        native: { haId, type: "Dishwasher", enumber: "SX87/60" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = { [`${NS}.${eventId}`]: legacy };
    port.objects.set(eventId, legacy);

    // The repair at priming fails: only this datapoint, only while the flag is on.
    const realExtend = port.extendObject.bind(port);
    let extendBroken = true;
    port.extendObject = (objId: string, obj: ioBroker.PartialObject): Promise<unknown> =>
      extendBroken && objId === eventId ? Promise.reject(new Error("objects db down")) : realExtend(objId, obj);
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    expect((port.objects.get(eventId)?.common as { name?: unknown })?.name).toBe("programFinished");

    // The database recovers. The same run reaches this datapoint again through
    // ensureEventStates — and it must actually write, not skip it because the
    // in-memory record was left claiming the failed write had landed.
    extendBroken = false;
    await sync.syncAppliances();
    const repaired = port.objects.get(eventId)?.common as { name?: Record<string, string>; desc?: unknown };
    expect(repaired?.name).toEqual(tName("evProgramFinished"));
    expect(repaired?.desc).toEqual(tName("evProgramFinishedDesc"));
  });
});

describe("ApplianceSync command descriptions", () => {
  it("keeps the explanation whatever path the command's NAME took", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Geschirrspüler", {
      status: [],
      settings: [],
      commands: [
        // Named from the cloud …
        { key: "BSH.Common.Command.PauseProgram", name: "Pause" },
        // … and named from the adapter's own fallback table.
        { key: "BSH.Common.Command.ResumeProgram" },
      ],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    // The explanation belongs to the BSH key, not to where the name came from —
    // it sits next to that name in the very same table.
    expect(port.objects.get("geschirrspueler-1.commands.pauseProgram")?.common?.desc).toEqual(
      tName("cmdPauseProgramDesc"),
    );
    expect(port.objects.get("geschirrspueler-1.commands.resumeProgram")?.common?.desc).toEqual(
      tName("cmdResumeProgramDesc"),
    );
    // And our own name wins over the terse cloud "Pause".
    expect(port.objects.get("geschirrspueler-1.commands.pauseProgram")?.common?.name).toEqual(tName("cmdPauseProgram"));
  });
});

describe("ApplianceSync settings definitions (the single-setting endpoint)", () => {
  const POWER = "BSH.Common.Setting.PowerState";
  const TEMP = "Refrigeration.FridgeFreezer.Setting.SetpointTemperatureFreezer";

  /**
   * A fridge whose settings LIST answers the way the cloud really does — values
   * and units, no constraints — while the single-setting endpoint carries the
   * type, the allowed values and the bounds.
   *
   * @param port the recording port to arm
   */
  function fridge(port: FakePort): void {
    appliance(port, "HA-1", "Kuehlschrank", {
      type: "FridgeFreezer",
      // Measured list shape: {key, name, value, unit} — NO constraints.
      settings: [
        { key: POWER, value: "BSH.Common.EnumType.PowerState.Off" },
        { key: TEMP, value: -18, unit: "°C" },
      ],
    });
    port.getResponses.set(`/api/homeappliances/HA-1/settings/${encodeURIComponent(POWER)}`, {
      key: POWER,
      value: "BSH.Common.EnumType.PowerState.Off",
      type: "String",
      constraints: {
        allowedvalues: ["BSH.Common.EnumType.PowerState.Off", "BSH.Common.EnumType.PowerState.On"],
        access: "readWrite",
      },
    });
    port.getResponses.set(`/api/homeappliances/HA-1/settings/${encodeURIComponent(TEMP)}`, {
      key: TEMP,
      value: -18,
      unit: "°C",
      type: "Int",
      constraints: { min: -24, max: -16, stepsize: 1, access: "readWrite" },
    });
  }

  it("makes an appliance sitting at 'off' switchable — the list alone cannot", async () => {
    const port = new FakePort();
    fridge(port);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();

    // Without the single-setting fetch the ONLY write candidate is the current
    // value, so `off` would be the only resolvable one and the appliance could
    // never be turned on through the adapter.
    expect(
      (port.objects.get("kuehlschrank-1.settings.powerState")?.native as { bshValues?: string[] }).bshValues,
    ).toEqual(["BSH.Common.EnumType.PowerState.Off", "BSH.Common.EnumType.PowerState.On"]);

    // And the write really leaves as the full BSH value.
    await sync.handleWrite(`${NS}.kuehlschrank-1.settings.powerState`, "on");
    expect(port.writes).toEqual([
      {
        method: "PUT",
        path: "/api/homeappliances/HA-1/settings/BSH.Common.Setting.PowerState",
        body: { key: POWER, value: "BSH.Common.EnumType.PowerState.On" },
      },
    ]);
  });

  it("gives a numeric setting the bounds the device declares", async () => {
    const port = new FakePort();
    fridge(port);
    await new ApplianceSync(port).syncAppliances();
    const common = port.objects.get("kuehlschrank-1.settings.setpointTemperatureFreezer")?.common;
    expect(common).toMatchObject({ type: "number", unit: "°C", min: -24, max: -16, step: 1 });
  });

  it("fetches each definition once and never again, across restarts", async () => {
    const port = new FakePort();
    fridge(port);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const single = (p: FakePort): string[] => p.getCalls.filter(c => c.includes("/settings/"));
    expect(single(port)).toHaveLength(2);

    // Second sync of the SAME run: served from memory.
    await sync.syncAppliances();
    expect(single(port)).toHaveLength(2);

    // The cache is persisted on the device object, so it survives a restart.
    const persisted = port.objects.get("kuehlschrank-1")?.native as { settingDefs?: Record<string, unknown> };
    expect(Object.keys(persisted.settingDefs ?? {})).toEqual([POWER, TEMP]);

    const restarted = new FakePort();
    fridge(restarted);
    restarted.primeDevices = { [`${NS}.kuehlschrank-1`]: port.objects.get("kuehlschrank-1") as ioBroker.Object };
    const after = new ApplianceSync(restarted);
    await after.primeFromObjects();
    await after.syncAppliances();
    expect(single(restarted)).toHaveLength(0);
  });

  it("retries a definition the cloud did not answer, instead of caching 'has none'", async () => {
    const port = new FakePort();
    fridge(port);
    port.getResponses.delete(`/api/homeappliances/HA-1/settings/${encodeURIComponent(POWER)}`);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    // The datapoint exists and still works on its current value — just without candidates.
    expect(port.objects.has("kuehlschrank-1.settings.powerState")).toBe(true);

    fridge(port); // the endpoint answers again
    await sync.syncAppliances();
    expect(
      (port.objects.get("kuehlschrank-1.settings.powerState")?.native as { bshValues?: string[] }).bshValues,
    ).toHaveLength(2);
  });
});

describe("ApplianceSync metadata refresh that fails halfway", () => {
  it("writes nothing fresh over a list the clearing pass failed to clear", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Geschirrspueler", {
      available: ["Dishcare.Dishwasher.Program.Eco50", "Dishcare.Dishwasher.Program.Auto2"],
    });
    port.getResponses.set("/api/homeappliances/HA-1/programs/selected", {
      key: "Dishcare.Dishwasher.Program.Eco50",
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const id = "geschirrspueler-1.programs.selectedProgram";
    expect((port.objects.get(id)?.native as { bshValues?: string[] }).bshValues).toHaveLength(2);

    // A program DISAPPEARS. This is the case the clearing pass exists for: the
    // deep merge can only add, never remove, so without a successful clearing
    // the gone program stays selectable and stays resolvable on a write.
    // (A program being ADDED would not prove anything — there the merge happens
    // to produce the right list on its own.)
    port.getResponses.set("/api/homeappliances/HA-1/programs/available", {
      programs: [{ key: "Dishcare.Dishwasher.Program.Eco50" }],
    });
    const real = port.extendObject.bind(port);
    let failures = 0;
    let writesWhileStale = 0;
    port.extendObject = (oid: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      const asRec = obj as unknown as { common?: { states?: unknown }; native?: { bshValues?: unknown } };
      const isClearing = asRec.common?.states === null || asRec.native?.bshValues === null;
      if (oid.endsWith("selectedProgram") && isClearing) {
        failures++;
        return Promise.reject(new Error("db refused"));
      }
      if (oid.endsWith("selectedProgram") && !isClearing) {
        writesWhileStale++;
      }
      return real(oid, obj);
    };
    await sync.syncAppliances();
    // More than once is CORRECT and is half the point: an incomplete refresh is
    // not remembered as done, so every later pass of the same run tries again.
    expect(failures).toBeGreaterThan(0);
    // And NOT ONE fresh write went out while the stale list was still standing.
    // That write is the actual damage: extendObject can only merge, so writing
    // the new list over an uncleared one leaves a removed program selectable AND
    // resolvable on a write. Measured: the fix turns "clear, write" into
    // "clear, clear" — the refresh is retried, never half-applied.
    expect(writesWhileStale).toBe(0);

    // The refresh did not complete, so it must NOT count as done: the retry in the
    // same run has to clear the stale list again and put the fresh one in. A
    // swallowed failure left the datapoint offering a program the appliance no
    // longer has — and nothing tried again until the next adapter start.
    port.extendObject = real;
    await sync.syncAppliances();
    expect((port.objects.get(id)?.native as { bshValues?: string[] }).bshValues).toEqual([
      "Dishcare.Dishwasher.Program.Eco50",
    ]);
  });
});

describe("ApplianceSync value-less items", () => {
  it("leaves the stored reading alone when an item carries no value", async () => {
    const port = new FakePort();
    const KEY = "Dishcare.Dishwasher.Status.ProgramPhase";
    appliance(port, "HA-1", "Geschirrspueler", { status: [{ key: KEY, value: "Drying" }] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const id = "geschirrspueler-1.status.programPhase";
    expect(port.states.get(id)).toBe("Drying");

    // The cloud sends key-only items: a response carries only the subset the
    // appliance reports right now (decision 6), and an undocumented key can
    // arrive with no value at all. Writing that emptied the datapoint —
    // `JSON.stringify(undefined)` is `undefined`, which went straight through.
    const writesBefore = port.stateWrites.length;
    port.getResponses.set("/api/homeappliances/HA-1/status", { status: [{ key: KEY }] });
    await sync.syncAppliances();
    expect(port.states.get(id)).toBe("Drying");
    expect(port.stateWrites.slice(writesBefore).filter(w => w.id === id)).toEqual([]);
  });

  it("does not turn a null value into the text 'null'", async () => {
    const port = new FakePort();
    const KEY = "Dishcare.Dishwasher.Status.ProgramPhase";
    appliance(port, "HA-1", "Geschirrspueler", { status: [{ key: KEY, value: "Drying" }] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const id = "geschirrspueler-1.status.programPhase";

    // An explicit null is "no reading", not the four-letter word: JSON.stringify
    // turned it into the TEXT "null", which then sat in the tree as a value.
    port.getResponses.set("/api/homeappliances/HA-1/status", { status: [{ key: KEY, value: null }] });
    await sync.syncAppliances();
    expect(port.states.get(id)).toBe("Drying");
  });
});

describe("ApplianceSync rollup, gate and device object", () => {
  it("never publishes a devicesAllOnline that was not true", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Spueler", { connected: true });
    appliance(port, "HA-2", "Trockner", { connected: false, type: "Dryer", enumber: "dryer-2" });
    appliance(port, "HA-3", "Kuehler", { connected: true, type: "FridgeFreezer", enumber: "fridge-3" });
    await new ApplianceSync(port).syncAppliances();

    const sums = (id: string): ioBroker.StateValue[] => port.stateWrites.filter(w => w.id === id).map(w => w.val);
    // Flushed once at the end of the pass. Per appliance, the first (online) one
    // made "all connected" true — a value that never held, and a script watching
    // it fired on it.
    expect(sums("info.devicesAllOnline")).toEqual([false]);
    expect(sums("info.devicesTotal")).toEqual([3]);
    expect(sums("info.devicesOnline")).toEqual([2]);
  });

  it("disarms the option gate when the program is deselected at the appliance", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Spueler", { available: ["Dishcare.Dishwasher.Program.Eco50"] });
    port.getResponses.set("/api/homeappliances/HA-1/programs/available/Dishcare.Dishwasher.Program.Eco50", {
      key: "Dishcare.Dishwasher.Program.Eco50",
      options: [
        { key: "BSH.Common.Option.StartInRelative", type: "Int", unit: "seconds", constraints: { min: 0, max: 86400 } },
      ],
    });
    port.getResponses.set("/api/homeappliances/HA-1/programs/selected", {
      key: "Dishcare.Dishwasher.Program.Eco50",
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    // Armed: the option is writable.
    await sync.handleWrite(`${NS}.spueler-1.options.startInRelative`, 600);
    expect(port.writes).toHaveLength(1);

    // Deselected AT THE APPLIANCE — arrives as a value item with an empty key.
    sync.handleStreamEvent({
      event: "NOTIFY",
      id: "HA-1",
      data: JSON.stringify({ items: [{ key: "BSH.Common.Root.SelectedProgram", value: "" }] }),
    });
    await flush();

    // With no program selected, sending its options is a wasted request that the
    // cloud answers `SDK.Error.NoProgramSelected` — and apiWrite reports that as
    // a warning for a situation the adapter could have known itself.
    await sync.handleWrite(`${NS}.spueler-1.options.startInRelative`, 900);
    expect(port.writes).toHaveLength(1);
  });

  it("writes the device object once, not on every pass", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Spueler");
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    expect(port.extendCalls.filter(c => c === "spueler-1")).toHaveLength(1);

    // An identical extendObject is a real write plus an objectChange to every
    // subscriber — js-controller stamps obj.ts and never short-circuits.
    await sync.syncAppliances();
    expect(port.extendCalls.filter(c => c === "spueler-1")).toHaveLength(1);

    // A rename in the Home Connect app must still come through.
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "HA-1", name: "Kueche", connected: true, type: "Dishwasher", enumber: "Spueler" }],
    });
    await sync.syncAppliances();
    expect(port.extendCalls.filter(c => c === "spueler-1")).toHaveLength(2);
    expect(port.objects.get("spueler-1")?.common?.name).toBe("Kueche");
  });
});

describe("ApplianceSync markAllUnreachable", () => {
  it("resets every appliance marker and the three sums", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Spueler", { connected: true });
    appliance(port, "HA-2", "Trockner", { connected: true, type: "Dryer", enumber: "DRYER" });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    expect(port.states.get("spueler-1.info.reachable")).toBe(true);
    expect(port.states.get("info.devicesOnline")).toBe(2);

    // The ONLY writer of every appliance marker at start-up and at shutdown
    // (decisions 9 + 11). Without it the whole tree stays green while the adapter
    // is off — the incident that v1.11.0 was built for. The host does not help:
    // its own `info.connection` reset writes to the wrong id (js-controller#3472).
    await sync.markAllUnreachable();
    expect(port.states.get("spueler-1.info.reachable")).toBe(false);
    expect(port.states.get("dryer-2.info.reachable")).toBe(false);
    expect(port.states.get("info.devicesOnline")).toBe(0);
    // devicesTotal survives a stop: how many appliances are paired does not
    // change because the adapter is off, and a 0 would read as "none paired".
    expect(port.states.get("info.devicesTotal")).toBe(2);
    expect(port.states.get("info.devicesAllOnline")).toBe(false);
  });
});

describe("ApplianceSync option definition union", () => {
  /**
   * Two programs of one appliance declaring the SAME option differently — the
   * object has to carry the union, so an option keeps working whichever program
   * is selected (decision 7).
   *
   * @param port the recording port to arm
   */
  function twoPrograms(port: FakePort): void {
    const A = "LaundryCare.Washer.Program.Cotton";
    const B = "LaundryCare.Washer.Program.Delicate";
    // The COLD program is read FIRST, the hot one second: only then does widening
    // the lower bound show up. With the wide range first, the union and a plain
    // last-one-wins build the same object and nothing is proven.
    appliance(port, "HA-1", "Waschmaschine", { type: "Washer", available: [B, A], enumber: "WASHER" });
    port.getResponses.set(`/api/homeappliances/HA-1/programs/available/${B}`, {
      key: B,
      options: [
        {
          key: "LaundryCare.Washer.Option.Temperature",
          type: "Int",
          unit: "°C",
          constraints: { min: 20, max: 60, stepsize: 10 },
        },
      ],
    });
    port.getResponses.set(`/api/homeappliances/HA-1/programs/available/${A}`, {
      key: A,
      // Hotter program: HIGHER bounds, and this definition carries NO unit.
      options: [{ key: "LaundryCare.Washer.Option.Temperature", type: "Int", constraints: { min: 40, max: 90 } }],
    });
  }

  it("widens the bounds across programs and keeps a unit a later definition omits", async () => {
    const port = new FakePort();
    twoPrograms(port);
    await new ApplianceSync(port).syncAppliances();
    const common = port.objects.get("washer-1.options.temperature")?.common as ioBroker.StateCommon | undefined;
    // Union, not last-one-wins: writing 20 °C for the delicate program must stay
    // possible, and so must 90 °C for cotton.
    expect(common).toMatchObject({ min: 20, max: 90 });
    // The unit stands even though the second definition carried none. Belt AND
    // braces, measured: `extendObject` skips `undefined`, so the stored unit would
    // survive the merge anyway — this assertion does not catch its removal. It
    // holds the object the adapter BUILDS correct, which the signature depends on.
    expect(common?.unit).toBe("°C");
    // And the step size of a numeric option survives.
    expect(common?.step).toBe(10);
  });
});

describe("ApplianceSync reports whether a sync reached the cloud", () => {
  it("returns false when the appliance list does not arrive", async () => {
    const port = new FakePort();
    // No response armed at all ⇒ apiGet resolves undefined, which is what a
    // failed request looks like. Nothing was learned, so the outage catch-up
    // must not announce a re-read nor start its one-hour cooldown on it.
    await expect(new ApplianceSync(port).syncAppliances()).resolves.toBe(false);
  });

  it("returns true for an empty account — the cloud did answer", async () => {
    const port = new FakePort();
    port.getResponses.set("/api/homeappliances", { homeappliances: [] });
    await expect(new ApplianceSync(port).syncAppliances()).resolves.toBe(true);
  });
});

describe("ApplianceSync findings of the 2026-09-15 audit", () => {
  const ECO = "Dishcare.Dishwasher.Program.Eco50";
  const BASE = "/api/homeappliances/HA-1";

  /** A dishwasher with one program whose option is armed after the first sync. */
  async function armedDishwasher(): Promise<{ port: FakePort; sync: ApplianceSync }> {
    const port = new FakePort();
    appliance(port, "HA-1", "Spueler", { available: [ECO] });
    port.getResponses.set(`${BASE}/programs/available/${ECO}`, {
      key: ECO,
      options: [
        { key: "BSH.Common.Option.StartInRelative", type: "Int", unit: "seconds", constraints: { min: 0, max: 86400 } },
      ],
    });
    port.getResponses.set(`${BASE}/programs/selected`, { key: ECO });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    expect(port.states.get("spueler-1.programs.selectedProgram")).toBe("eco50");
    return { port, sync };
  }

  it("keeps the selected program and its option gate when /programs/selected does not answer", async () => {
    const { port, sync } = await armedDishwasher();
    // The answer does not arrive — a timeout, a 5xx, the rate-limit pause, a busy
    // appliance: apiGet resolves undefined. Nothing is known, so nothing may be
    // written: the previous code wrote "" over the running program and disarmed
    // the gate, and no stream event corrects that (the stream reports changes).
    port.getResponses.delete(`${BASE}/programs/selected`);
    port.getResponses.delete(`${BASE}/programs/active`);
    port.stateWrites.length = 0;
    await sync.syncAppliances();
    expect(port.stateWrites.filter(w => w.id.startsWith("spueler-1.programs."))).toEqual([]);
    expect(port.states.get("spueler-1.programs.selectedProgram")).toBe("eco50");
    // The gate still lets the option through.
    await sync.handleWrite(`${NS}.spueler-1.options.startInRelative`, 600);
    expect(port.writes).toHaveLength(1);
  });

  it("writes an idle program and disarms the gate when the cloud says there is none", async () => {
    const { port, sync } = await armedDishwasher();
    // `null` is the cloud's "no program selected" (SDK.Error.NoProgramSelected).
    port.getResponses.set(`${BASE}/programs/selected`, null);
    await sync.syncAppliances();
    expect(port.states.get("spueler-1.programs.selectedProgram")).toBe("");
    await sync.handleWrite(`${NS}.spueler-1.options.startInRelative`, 600);
    expect(port.writes).toHaveLength(0);
  });

  it("clears a stale active program on the cloud's 'none', and keeps it when nothing is known", async () => {
    const { port, sync } = await armedDishwasher();
    port.getResponses.set(`${BASE}/programs/active`, { key: ECO });
    await sync.syncAppliances();
    expect(port.states.get("spueler-1.programs.activeProgram")).toBe("eco50");

    port.getResponses.delete(`${BASE}/programs/active`);
    await sync.syncAppliances();
    expect(port.states.get("spueler-1.programs.activeProgram")).toBe("eco50");

    port.getResponses.set(`${BASE}/programs/active`, null);
    await sync.syncAppliances();
    expect(port.states.get("spueler-1.programs.activeProgram")).toBe("");
  });

  it("maps a null program value from the stream to idle and disarms the gate", async () => {
    const { port, sync } = await armedDishwasher();
    port.getResponses.set(`${BASE}/programs/active`, { key: ECO });
    await sync.syncAppliances();
    // The type source declares both program roots as `ProgramKey | null`: null
    // IS "no program". Since the null-guard of 1.18.0 it was swallowed instead —
    // the datapoint kept the old name and the gate stayed armed.
    sync.handleStreamEvent({
      event: "NOTIFY",
      id: "HA-1",
      data: JSON.stringify({
        items: [
          { key: "BSH.Common.Root.SelectedProgram", value: null },
          { key: "BSH.Common.Root.ActiveProgram", value: null },
        ],
      }),
    });
    await flush();
    expect(port.states.get("spueler-1.programs.selectedProgram")).toBe("");
    expect(port.states.get("spueler-1.programs.activeProgram")).toBe("");
    await sync.handleWrite(`${NS}.spueler-1.options.startInRelative`, 600);
    expect(port.writes).toHaveLength(0);
  });

  it("leaves no marker green when the adapter stops in the middle of a pass", async () => {
    const port = new FakePort();
    for (const [haId, name] of [
      ["HA-1", "A"],
      ["HA-2", "B"],
      ["HA-3", "C"],
      ["HA-4", "D"],
    ]) {
      appliance(port, haId, name, { status: [] });
    }
    // The third appliance's status read hangs until released — the pass is
    // mid-flight when onUnload runs (stop, then the offline stamp).
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = port.apiGet.bind(port);
    port.apiGet = async (path: string): Promise<unknown> => {
      if (path === "/api/homeappliances/HA-3/status") {
        await gate;
      }
      return original(path);
    };
    const sync = new ApplianceSync(port);
    const pass = sync.syncAppliances();
    await flush();
    sync.stop();
    await sync.markAllUnreachable();
    const objectsAtStop = port.objects.size;
    const writesAtStop = port.stateWrites.length;
    release();
    await pass;

    // Measured before the fix: the pass kept writing after the stamp — two of
    // four markers true, devicesOnline 2 with connection false.
    const marker = (id: string): ioBroker.StateValue[] =>
      port.stateWrites.filter(w => w.id === `${id}.info.reachable`).map(w => w.val);
    for (const id of ["a-1", "b-2", "c-3"]) {
      expect(marker(id).at(-1)).toBe(false);
    }
    expect(
      port.stateWrites.slice(writesAtStop).filter(w => w.id.endsWith(".info.reachable") && w.val === true),
    ).toEqual([]);
    expect(port.stateWrites.filter(w => w.id === "info.devicesOnline").at(-1)?.val).toBe(0);
    // Nothing is created after the stop either — the fourth appliance never appears.
    expect(port.objects.size).toBe(objectsAtStop);
    expect(port.objects.has("d-4")).toBe(false);
  });

  it("refuses an 'online' that lands after the offline stamp", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "A", { status: [] });
    appliance(port, "HA-2", "C", { status: [] });
    // The stop hits while appliance C is still creating its catalog events —
    // BEFORE its online marker is written. Without the refusal, that marker
    // then lands on top of the offline stamp and C stays green.
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = port.extendObject.bind(port);
    port.extendObject = async (id: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      if (id.startsWith("c-2.events.")) {
        await gate;
      }
      return original(id, obj);
    };
    const sync = new ApplianceSync(port);
    const pass = sync.syncAppliances();
    await flush();
    sync.stop();
    await sync.markAllUnreachable();
    release();
    await pass;
    expect(port.stateWrites.filter(w => w.id === "c-2.info.reachable" && w.val === true)).toEqual([]);
    expect(port.states.get("c-2.info.reachable")).toBe(false);
  });

  it("applies no further item of a step that was in flight when the adapter stopped", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "A", {
      status: [
        { key: "BSH.Common.Status.RemoteControlActive", value: true },
        { key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" },
      ],
    });
    // The stop hits while the first status item is being written; the second
    // item of the same response must not follow it into the tree.
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const original = port.setStateChanged.bind(port);
    port.setStateChanged = async (id: string, state: ioBroker.SettableState): Promise<unknown> => {
      if (id === "a-1.status.remoteControlActive") {
        await gate;
      }
      return original(id, state);
    };
    const sync = new ApplianceSync(port);
    const pass = sync.syncAppliances();
    await flush();
    sync.stop();
    await sync.markAllUnreachable();
    release();
    await pass;
    expect(port.states.has("a-1.status.operationState")).toBe(false);
    expect(port.objects.has("a-1.status.operationState")).toBe(false);
  });

  it("routes no stream event after stop()", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "A", { status: [] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    sync.stop();
    const before = port.stateWrites.length;
    sync.handleStreamEvent({
      event: "STATUS",
      id: "HA-1",
      data: JSON.stringify({
        items: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" }],
      }),
    });
    sync.handleStreamEvent({ event: "CONNECTED", id: "HA-1", data: JSON.stringify({ haId: "HA-1" }) });
    await flush();
    expect(port.stateWrites.length).toBe(before);
  });

  it("writes no false for a door, the running flag or an event when the item carries no value", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Waescher", { type: "Washer", status: [] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const send = (items: unknown[]): void =>
      sync.handleStreamEvent({ event: "STATUS", id: "HA-1", data: JSON.stringify({ items }) });
    send([
      { key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" },
      { key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" },
      { key: "LaundryCare.Washer.Event.IDos1FillLevelPoor", value: "BSH.Common.EnumType.EventPresentState.Present" },
    ]);
    await flush();
    expect(port.states.get("waescher-1.status.doorOpen")).toBe(true);
    expect(port.states.get("waescher-1.status.programRunning")).toBe(true);
    expect(port.states.get("waescher-1.events.iDos1FillLevelPoor")).toBe(true);

    // The same keys without a value: measured before the fix, doorOpen and
    // programRunning went false and the alarm was cleared by an empty frame.
    port.stateWrites.length = 0;
    send([
      { key: "BSH.Common.Status.DoorState" },
      { key: "BSH.Common.Status.OperationState" },
      { key: "LaundryCare.Washer.Event.IDos1FillLevelPoor" },
    ]);
    await flush();
    expect(port.stateWrites).toEqual([]);
    expect(port.states.get("waescher-1.status.doorOpen")).toBe(true);
    expect(port.states.get("waescher-1.status.programRunning")).toBe(true);
    expect(port.states.get("waescher-1.events.iDos1FillLevelPoor")).toBe(true);
  });

  it("reads no state value for datapoints that already sit in their place", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Waescher", {
      type: "Washer",
      status: [
        { key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Closed" },
        { key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Ready" },
        { key: "BSH.Common.Status.RemoteControlActive", value: true },
      ],
      settings: [{ key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.On" }],
    });
    await new ApplianceSync(port).syncAppliances();
    // A second start over that tree: nothing moves, so nothing is read.
    // Measured before the fix: one getState per datapoint per start (929 on
    // the full inventory) to find out that nothing was to be migrated.
    const restarted = new ApplianceSync(port);
    port.primeDevices = { [`${NS}.waescher`]: port.objects.get("waescher") as ioBroker.Object };
    port.primeStates = Object.fromEntries(
      [...port.objects.entries()]
        .filter(([, o]) => (o as { type?: string }).type === "state")
        .map(([id, o]) => [`${NS}.${id}`, o as ioBroker.Object]),
    );
    port.getStateCalls.length = 0;
    await restarted.migrateRenamedStates();
    expect(port.getStateCalls).toEqual([]);
  });

  it("still writes nothing for a null value of any other key", async () => {
    const { port, sync } = await armedDishwasher();
    sync.handleStreamEvent({
      event: "STATUS",
      id: "HA-1",
      data: JSON.stringify({
        items: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" }],
      }),
    });
    await flush();
    expect(port.states.get("spueler-1.status.operationState")).toBe("run");
    sync.handleStreamEvent({
      event: "STATUS",
      id: "HA-1",
      data: JSON.stringify({ items: [{ key: "BSH.Common.Status.OperationState", value: null }] }),
    });
    await flush();
    expect(port.states.get("spueler-1.status.operationState")).toBe("run");
  });
});

describe("ApplianceSync read-back after a rejected write (2026-09-15, F8)", () => {
  const ECO = "Dishcare.Dishwasher.Program.Eco50";
  const BASE = "/api/homeappliances/HA-1";
  async function dishwasher(): Promise<{ port: FakePort; sync: ApplianceSync }> {
    const port = new FakePort();
    appliance(port, "HA-1", "Spueler", { available: [ECO] });
    port.getResponses.set(`${BASE}/programs/available/${ECO}`, {
      key: ECO,
      options: [
        { key: "BSH.Common.Option.StartInRelative", type: "Int", unit: "seconds", constraints: { min: 0, max: 86400 } },
      ],
    });
    port.getResponses.set(`${BASE}/programs/selected`, {
      key: ECO,
      options: [{ key: "BSH.Common.Option.StartInRelative", value: 600 }],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    expect(port.states.get("spueler-1.options.startInRelative")).toBe(600);
    return { port, sync };
  }

  it("re-reads the selected program once and restores a rejected option", async () => {
    const { port, sync } = await dishwasher();
    port.writeResult = { status: 409, ok: false, data: undefined, error: "SDK.Error.WrongOperationState" };
    port.getCalls.length = 0;
    await sync.handleWrite(`${NS}.spueler-1.options.startInRelative`, 900);
    expect(port.getCalls).toEqual([`${BASE}/programs/selected`]);
    expect(port.states.get("spueler-1.options.startInRelative")).toBe(600);
    expect(port.states.get("spueler-1.programs.selectedProgram")).toBe("eco50");
  });

  it("makes no read-back for a program start the appliance rejected (retried with defaults)", async () => {
    const { port, sync } = await dishwasher();
    port.writeResult = { status: 409, ok: false, data: undefined, error: "SDK.Error.WrongOperationState" };
    port.getCalls.length = 0;
    await sync.handleWrite(`${NS}.spueler-1.programs.start`, true);
    expect(port.getCalls).toEqual([]);
    expect(port.writes).toHaveLength(2); // the start and its retry with defaults
  });

  it("makes no read-back for a write that was never sent", async () => {
    const { port, sync } = await dishwasher();
    port.writeResult = undefined; // rate pause / not signed in
    port.getCalls.length = 0;
    await sync.handleWrite(`${NS}.spueler-1.options.startInRelative`, 900);
    expect(port.getCalls).toEqual([]);
  });
});

describe("findings of the 2026-09-24 audit", () => {
  it("F2: one appliance whose objects cannot be written does not cost the others", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Oven", { status: [] });
    appliance(port, "HA-2", "Dishwasher", { status: [] });
    const real = port.extendObject.bind(port);
    let failed = false;
    port.extendObject = (id: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      if (!failed && id === "oven-1") {
        failed = true;
        return Promise.reject(new Error("objects db refused"));
      }
      return real(id, obj);
    };
    await expect(sync.syncAppliances()).resolves.toBe(true);
    // The second appliance is still read and built, and the pass completes.
    expect(port.getCalls).toContain("/api/homeappliances/HA-2/status");
    expect(port.objects.has("dishwasher-2")).toBe(true);
    // The sums are flushed (the pass completed); they count what was set up.
    expect(port.states.get("info.devicesTotal")).toBe(1);
    expect(port.logs).toContain("warn: Could not set up HA-1: objects db refused — the other appliances go on.");
  });
});

describe("findings of the 2026-09-24 audit — write path", () => {
  const base = "/api/homeappliances/HA-1";
  const dryerKey = "LaundryCare.Dryer.Option.DryingTarget";
  const wdKey = "LaundryCare.WasherDryer.Option.DryingTarget";
  const A = "LaundryCare.WasherDryer.Program.Cotton";
  const B = "LaundryCare.WasherDryer.Program.Mix";
  const dryerValues = ["IronDry", "CupboardDry"].map(v => `LaundryCare.Dryer.EnumType.DryingTarget.${v}`);
  const wdValues = ["IronDry", "CupboardDry"].map(v => `LaundryCare.WasherDryer.EnumType.DryingTargetWD.${v}`);

  /**
   * A washer-dryer whose two programs name the same option with different keys
   * (both families exist in the type source) — they share one state id.
   *
   * @param port the fake port
   */
  function washerDryer(port: FakePort): void {
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "HA-1", name: "WD", connected: true, type: "WasherDryer", enumber: "WD" }],
    });
    port.getResponses.set(`${base}/status`, { status: [] });
    port.getResponses.set(`${base}/settings`, { settings: [] });
    port.getResponses.set(`${base}/commands`, { commands: [] });
    port.getResponses.set(`${base}/programs/available`, { programs: [{ key: A }, { key: B }] });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(A)}`, {
      key: A,
      options: [{ key: dryerKey, type: "Enum", constraints: { allowedvalues: dryerValues } }],
    });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(B)}`, {
      key: B,
      options: [{ key: wdKey, type: "Enum", constraints: { allowedvalues: wdValues } }],
    });
    port.getResponses.set(`${base}/programs/selected`, { key: A, options: [] });
    port.getResponses.set(`${base}/programs/active`, {});
  }

  it("F4: a tolerant spelling is confirmed in the datapoint's form and still goes out with the next start", async () => {
    const port = new FakePort();
    washerDryer(port);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.wd-1.options.dryingTarget`, "IRONDRY");
    expect(port.writes.at(-1)?.body).toEqual({ key: dryerKey, value: dryerValues[0] });
    // Confirmed as "irondry", not verbatim — the start below matches on it.
    expect(port.states.get("wd-1.options.dryingTarget")).toBe("irondry");
    await sync.handleWrite(`${NS}.wd-1.programs.start`, true);
    expect(port.writes.at(-1)?.body).toEqual({ key: A, options: [{ key: dryerKey, value: dryerValues[0] }] });
  });

  it("F4: a full program key is confirmed as the short value, and the start sends it", async () => {
    const port = new FakePort();
    washerDryer(port);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    await sync.handleWrite(`${NS}.wd-1.programs.selectedProgram`, B);
    expect(port.states.get("wd-1.programs.selectedProgram")).toBe("mix");
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.wd-1.programs.start`, true);
    expect(port.writes.at(-1)?.body?.key).toBe(B);
  });

  it("F6: an option goes out with the selected program's own key and value family", async () => {
    const port = new FakePort();
    washerDryer(port);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    // Program B is chosen at the appliance — it names the option with the WasherDryer key.
    sync.handleStreamEvent({
      event: "NOTIFY",
      data: JSON.stringify({ haId: "HA-1", items: [{ key: "BSH.Common.Root.SelectedProgram", value: B }] }),
      id: undefined,
    });
    await flush();
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.wd-1.options.dryingTarget`, "irondry");
    // Measured before: the WasherDryer key with the Dryer family's value.
    expect(port.writes.at(-1)?.path).toBe(`${base}/programs/selected/options/${wdKey}`);
    expect(port.writes.at(-1)?.body).toEqual({ key: wdKey, value: wdValues[0] });
    await sync.handleWrite(`${NS}.wd-1.programs.start`, true);
    expect(port.writes.at(-1)?.body?.options).toEqual([{ key: wdKey, value: wdValues[0] }]);
  });

  it("F7: two programs ending in the same word stay two entries, both selectable", async () => {
    const port = new FakePort();
    const heat = "Cooking.Oven.Program.HeatingMode.DoughProving";
    const steam = "Cooking.Oven.Program.SteamModes.DoughProving";
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "HA-1", name: "Oven", connected: true, type: "Oven", enumber: "OV" }],
    });
    port.getResponses.set(`${base}/status`, { status: [] });
    port.getResponses.set(`${base}/settings`, { settings: [] });
    port.getResponses.set(`${base}/commands`, { commands: [] });
    port.getResponses.set(`${base}/programs/available`, { programs: [{ key: heat }, { key: steam }] });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(heat)}`, { key: heat, options: [] });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(steam)}`, { key: steam, options: [] });
    port.getResponses.set(`${base}/programs/selected`, null);
    port.getResponses.set(`${base}/programs/active`, null);
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const states = port.objects.get("ov-1.programs.selectedProgram")?.common as { states: Record<string, string> };
    expect(Object.keys(states.states)).toEqual(["", "heatingmode.doughproving", "steammodes.doughproving"]);

    port.writes.length = 0;
    await sync.handleWrite(`${NS}.ov-1.programs.selectedProgram`, "steammodes.doughproving");
    expect(port.writes.at(-1)?.body).toEqual({ key: steam });

    // Chosen at the appliance: the stream's value lands in the list-unique form.
    sync.handleStreamEvent({
      event: "NOTIFY",
      data: JSON.stringify({ haId: "HA-1", items: [{ key: "BSH.Common.Root.SelectedProgram", value: heat }] }),
      id: undefined,
    });
    await flush();
    expect(port.states.get("ov-1.programs.selectedProgram")).toBe("heatingmode.doughproving");

    // The bare word names neither program: not sent, and the user is told what to write.
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.ov-1.programs.selectedProgram`, "doughproving");
    expect(port.writes).toEqual([]);
    expect(
      port.logs.some(l => l.startsWith("warn:") && l.includes("heatingmode.doughproving, steammodes.doughproving")),
    ).toBe(true);
  });
});

describe("findings of the 2026-09-24 audit — re-reads", () => {
  const base = "/api/homeappliances/HA-1";
  const connected = (sync: ApplianceSync, ev = "CONNECTED"): void =>
    sync.handleStreamEvent({ event: ev, data: JSON.stringify({ haId: "HA-1" }), id: undefined });

  /**
   * Hold one path's answer until released — a read in flight.
   *
   * @param port the fake port
   * @param path the path to hold
   * @returns release() to let the held answer through
   */
  function hold(port: FakePort, path: string): { release: () => void } {
    const real = port.apiGet.bind(port);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let held = false;
    port.apiGet = (p: string): Promise<unknown> => {
      if (p === path && !held) {
        held = true;
        port.getCalls.push(p);
        return gate.then(() => {
          port.getCalls.pop();
          return real(p);
        });
      }
      return real(p);
    };
    return { release: () => release() };
  }

  /**
   * A dishwasher with an empty tree, synced once, wired like main wires the sync.
   *
   * @returns the port and the sync
   */
  async function ready(): Promise<{ port: FakePort; sync: ApplianceSync }> {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    appliance(port, "HA-1", "Spueler", {
      status: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" }],
      settings: [],
      commands: [],
    });
    await sync.syncAppliances();
    port.getCalls.length = 0;
    return { port, sync };
  }

  it("A1: a full read cancels a 'not ready' re-read that is still armed", async () => {
    const { port, sync } = await ready();
    port.notReadyPaths.add(`${base}/status`);
    connected(sync);
    await flush();
    expect(port.pendingTimers().map(t => t.ms)).toEqual([30_000]);
    port.notReadyPaths.clear();
    // Another pass (the outage re-read) reads the appliance fully in the meantime.
    await sync.syncAppliances();
    // Before: the timer fired anyway and cost a second full pass.
    expect(port.pendingTimers()).toEqual([]);
  });

  it("A2: going offline while the read is on its way arms no re-read", async () => {
    const { port, sync } = await ready();
    port.notReadyPaths.add(`${base}/status`);
    const held = hold(port, `${base}/status`);
    connected(sync);
    await flush();
    connected(sync, "DISCONNECTED");
    await flush();
    held.release();
    await flush();
    expect(port.pendingTimers()).toEqual([]);
  });

  it("A3/B7: a reconnect during a running pass is followed by one more pass", async () => {
    const { port, sync } = await ready();
    const held = hold(port, `${base}/status`);
    connected(sync);
    await flush();
    connected(sync, "DISCONNECTED");
    connected(sync);
    await flush();
    held.release();
    await flush();
    await flush();
    // Before: the second CONNECTED was dropped by the serialisation — one read only.
    expect(port.getCalls.filter(p => p === `${base}/status`)).toHaveLength(2);
  });

  it("F16: an older REST answer does not put back a value the stream already replaced", async () => {
    const { port, sync } = await ready();
    const held = hold(port, `${base}/status`);
    connected(sync);
    await flush();
    sync.handleStreamEvent({
      event: "STATUS",
      data: JSON.stringify({
        haId: "HA-1",
        items: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Finished" }],
      }),
      id: undefined,
    });
    await flush();
    expect(port.states.get("spueler-1.status.operationState")).toBe("finished");
    held.release(); // the /status answer from before the stream event: "run"
    await flush();
    expect(port.states.get("spueler-1.status.operationState")).toBe("finished");
  });

  it("A6: 'not ready' on the program list costs no request for the selected and active program", async () => {
    const { port, sync } = await ready();
    port.notReadyPaths.add(`${base}/programs/available`);
    connected(sync);
    await flush();
    expect(port.getCalls).not.toContain(`${base}/programs/selected`);
    expect(port.getCalls).not.toContain(`${base}/programs/active`);
  });
});

describe("findings of the 2026-09-24 audit — sync edges", () => {
  const base = "/api/homeappliances/HA-1";
  const connected = (sync: ApplianceSync, ev = "CONNECTED"): void =>
    sync.handleStreamEvent({ event: ev, data: JSON.stringify({ haId: "HA-1" }), id: undefined });

  it("F10: a value-less setting keeps its number type and its reading", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    const key = "BSH.Common.Setting.AmbientLightBrightness";
    appliance(port, "HA-1", "Spueler", { status: [], settings: [{ key, value: 40, type: "Double" }], commands: [] });
    port.getResponses.set(`${base}/settings/${encodeURIComponent(key)}`, { key, type: "Double", constraints: {} });
    await sync.syncAppliances();
    expect(port.objects.get("spueler-1.settings.ambientLightBrightness")?.common).toMatchObject({ type: "number" });
    // The next read carries the key only.
    port.getResponses.set(`${base}/settings`, { settings: [{ key }] });
    connected(sync);
    await flush();
    expect(port.objects.get("spueler-1.settings.ambientLightBrightness")?.common).toMatchObject({ type: "number" });
    expect(port.states.get("spueler-1.settings.ambientLightBrightness")).toBe(40);
  });

  it("F11: a re-paired appliance gets its device object again", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [] });
    await sync.syncAppliances();
    connected(sync, "DEPAIRED");
    await flush();
    expect(port.objects.has("spueler-1")).toBe(false);
    connected(sync, "PAIRED");
    await flush();
    await flush();
    expect(port.objects.get("spueler-1")?.type).toBe("device");
  });

  it("B9: a migration within one channel keeps the channel it moved into", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.fridge`]: {
        _id: "",
        type: "device",
        common: {},
        native: { haId: "HA-1", type: "FridgeFreezer" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.fridge.status.doorState`]: {
        _id: "",
        type: "state",
        common: { name: "Door", type: "string", role: "text", read: true, write: false },
        native: { bshKey: "BSH.Common.Status.DoorState" },
      } as unknown as ioBroker.Object,
    };
    port.objects.set("fridge.status", { type: "channel", common: { name: "status" }, native: {} });
    port.states.set("fridge.status.doorState", "closed");
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    expect(port.objects.has("fridge.status.doorOpen")).toBe(true);
    // Before: the old id was the channel's only state, so the channel was deleted
    // — with the new datapoint inside it.
    expect(port.objects.has("fridge.status")).toBe(true);
  });

  it("B11: a stop while a definition read is on its way writes nothing after it", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const programKey = "Dishcare.Dishwasher.Program.Eco50";
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(programKey)}`, {
      key: programKey,
      options: [{ key: "BSH.Common.Option.StartInRelative", type: "Int", constraints: { min: 0, max: 100 } }],
    });
    port.onGet = path => {
      if (path.includes("/programs/available/")) {
        sync.stop();
      }
    };
    port.extendCalls.length = 0;
    await sync.activateProgramOptions("spueler", "HA-1", programKey);
    expect(port.extendCalls).toEqual([]);
  });

  it("B12: an appliance removed during its pass leaves no orphans", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [] });
    await sync.syncAppliances();
    port.getResponses.set(`${base}/settings`, {
      settings: [{ key: "BSH.Common.Setting.ChildLock", value: true, type: "Boolean" }],
    });
    port.onGet = path => {
      if (path === `${base}/status`) {
        connected(sync, "DEPAIRED");
      }
    };
    connected(sync);
    await flush();
    await flush();
    expect(port.objects.has("spueler-1.settings.childLock")).toBe(false);
    expect([...port.objects.keys()].filter(k => k.startsWith("spueler-1"))).toEqual([]);
  });

  it("B13: a definition refused for good is not asked again on every reconnect; a transient one is", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    const refused = "BSH.Common.Setting.Refused";
    const flaky = "BSH.Common.Setting.Flaky";
    appliance(port, "HA-1", "Spueler", {
      status: [],
      settings: [
        { key: refused, value: true },
        { key: flaky, value: true },
      ],
      commands: [],
    });
    port.refusedPaths.add(`${base}/settings/${encodeURIComponent(refused)}`);
    await sync.syncAppliances();
    port.getCalls.length = 0;
    connected(sync);
    await flush();
    expect(port.getCalls).not.toContain(`${base}/settings/${encodeURIComponent(refused)}`);
    // A transient failure (no answer, no refusal) is asked again next time.
    expect(port.getCalls).toContain(`${base}/settings/${encodeURIComponent(flaky)}`);
  });
});

describe("findings of the 2026-09-24 audit — interrupted tree move (B8)", () => {
  it("resumes a move that was interrupted instead of moving to a third id", async () => {
    const port = new FakePort();
    const legacyId = "geschirrspueler";
    const schemeId = "sx87tx02ce-60";
    const native = { haId: "HA-1", type: "Dishwasher", enumber: "SX87TX02CE/60", vib: "SX87TX02CE" };
    port.primeDevices = {
      [`${NS}.${legacyId}`]: {
        _id: "",
        type: "device",
        common: { name: "Spüler" },
        native,
      } as unknown as ioBroker.Object,
      [`${NS}.${schemeId}`]: {
        _id: "",
        type: "device",
        common: { name: "Spüler" },
        native,
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.${legacyId}.settings.childLock`]: {
        _id: "",
        type: "state",
        common: { name: "Kindersicherung", type: "boolean", role: "switch", read: true, write: true },
        native: { bshKey: "BSH.Common.Setting.ChildLock" },
      } as unknown as ioBroker.Object,
    };
    for (const map of [port.primeDevices, port.primeStates]) {
      for (const [fullId, obj] of Object.entries(map)) {
        port.objects.set(fullId.slice(`${NS}.`.length), obj);
      }
    }
    port.states.set(`${legacyId}.settings.childLock`, true);
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    // The tree the interrupted 1.23 move went to is the one kept; it moves on to the current
    // rule, and what only the leftover held arrives there too.
    const finalId = "sx87tx02ce-1";
    expect(port.objects.has(`${finalId}.settings.childLock`)).toBe(true);
    expect(port.states.get(`${finalId}.settings.childLock`)).toBe(true);
    expect(port.objects.has(legacyId)).toBe(false);
    expect(port.objects.has(schemeId)).toBe(false);
    // Before: a third tree under a suffixed id — a phantom appliance offline forever.
    expect([...port.objects.keys()].filter(k => !k.includes("."))).toEqual([finalId]);
  });
});

describe("findings of the 2026-09-24 audit — program list (B10)", () => {
  it("a refused list does not widen the dropdown with programs the appliance no longer offers", async () => {
    const port = new FakePort();
    const a = "Dishcare.Dishwasher.Program.Eco50";
    const b = "Dishcare.Dishwasher.Program.Auto2";
    const gone = "Dishcare.Dishwasher.Program.Quick45";
    port.primeDevices = {
      [`${NS}.spueler`]: {
        _id: "",
        type: "device",
        common: {},
        native: {
          haId: "HA-1",
          type: "Dishwasher",
          enumber: "Spueler",
          // The cache still knows a program from an earlier firmware.
          programOptions: Object.fromEntries([a, b, gone].map(k => [k, { ids: [], keys: {}, v: 4 }])),
        },
      } as unknown as ioBroker.Object,
    };
    const sync = new ApplianceSync(port);
    port.sync = sync;
    await sync.primeFromObjects();
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [], available: [a, b] });
    await sync.syncAppliances();
    const states = (): string[] =>
      Object.keys((port.objects.get("spueler.programs.selectedProgram")?.common as { states: object }).states);
    expect(states()).toEqual(["", "eco50", "auto2"]);
    // A program runs: the list is refused, the selected program is read.
    port.getResponses.delete("/api/homeappliances/HA-1/programs/available");
    sync.handleStreamEvent({ event: "CONNECTED", data: JSON.stringify({ haId: "HA-1" }), id: undefined });
    await flush();
    expect(states()).toEqual(["", "eco50", "auto2"]);
  });
});

describe("findings of the 2026-09-24 audit — stream and catalog (D6, D7)", () => {
  it("D6: a CONNECTED without a JSON body still reads the appliance its SSE id names", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [] });
    await sync.syncAppliances();
    port.getCalls.length = 0;
    sync.handleStreamEvent({ event: "CONNECTED", data: "", id: "HA-1" });
    await flush();
    expect(port.getCalls).toContain("/api/homeappliances/HA-1/status");
  });

  it("D7: an existing misc.eventPresentState moves to events.unnamedEvent on its own", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.spueler`]: {
        _id: "",
        type: "device",
        common: {},
        native: { haId: "HA-1", type: "Dishwasher" },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.spueler.misc.eventPresentState`]: {
        _id: "",
        type: "state",
        common: { name: "Misc", type: "string", role: "text", read: true, write: false },
        native: { bshKey: "BSH.Common.EnumType.EventPresentState" },
      } as unknown as ioBroker.Object,
    };
    port.objects.set("spueler.misc", { type: "channel", common: { name: "misc" }, native: {} });
    port.states.set("spueler.misc.eventPresentState", "present");
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    expect(port.objects.get("spueler.events.unnamedEvent")?.common).toMatchObject({ type: "boolean" });
    expect(port.objects.has("spueler.misc.eventPresentState")).toBe(false);
    expect(port.objects.has("spueler.misc")).toBe(false);
  });
});

describe("findings of the 2026-09-24 audit — rules the needle run showed untested", () => {
  const base = "/api/homeappliances/HA-1";
  const connected = (sync: ApplianceSync, ev = "CONNECTED"): void =>
    sync.handleStreamEvent({ event: ev, data: JSON.stringify({ haId: "HA-1" }), id: undefined });

  /**
   * Hold one path's answer until released — a read in flight.
   *
   * @param port the fake port
   * @param path the path to hold
   * @returns release() to let the held answer through
   */
  function hold(port: FakePort, path: string): { release: () => void } {
    const real = port.apiGet.bind(port);
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let held = false;
    port.apiGet = (p: string): Promise<unknown> => {
      if (p === path && !held) {
        held = true;
        const answer = real(p);
        return gate.then(() => answer);
      }
      return real(p);
    };
    return { release: () => release() };
  }

  it("A2: a due re-read skips an appliance the account list meanwhile reported offline", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [] });
    await sync.syncAppliances();
    port.notReadyPaths.add(`${base}/status`);
    connected(sync);
    await flush();
    expect(port.pendingTimers().map(t => t.ms)).toEqual([30_000]);
    // The outage re-read lists it as switched off — no read, no cancel.
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "HA-1", name: "Spueler", connected: false, type: "Dishwasher", enumber: "Spueler" }],
    });
    await sync.syncAppliances();
    port.notReadyPaths.clear();
    port.getCalls.length = 0;
    port.fire();
    await flush();
    expect(port.getCalls).not.toContain(`${base}/status`);
  });

  it("A6: 'not ready' on one setting's definition ends the settings loop", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    const first = "BSH.Common.Setting.ChildLock";
    const second = "BSH.Common.Setting.PowerState";
    appliance(port, "HA-1", "Spueler", {
      status: [],
      settings: [
        { key: first, value: true },
        { key: second, value: "BSH.Common.EnumType.PowerState.On" },
      ],
      commands: [],
    });
    port.notReadyPaths.add(`${base}/settings/${encodeURIComponent(first)}`);
    await sync.syncAppliances();
    expect(port.getCalls).not.toContain(`${base}/settings/${encodeURIComponent(second)}`);
  });

  it("A6: 'not ready' on one program's definition ends the definition loop", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    const a = "Dishcare.Dishwasher.Program.Eco50";
    const b = "Dishcare.Dishwasher.Program.Auto2";
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [], available: [a, b] });
    port.notReadyPaths.add(`${base}/programs/available/${encodeURIComponent(a)}`);
    await sync.syncAppliances();
    expect(port.getCalls).not.toContain(`${base}/programs/available/${encodeURIComponent(b)}`);
  });

  it("B13: a program definition refused for good is not asked again on every reconnect", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    const refused = "Dishcare.Dishwasher.Program.Refused";
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [], available: [refused] });
    const defPath = `${base}/programs/available/${encodeURIComponent(refused)}`;
    port.refusedPaths.add(defPath);
    await sync.syncAppliances();
    expect(port.getCalls).toContain(defPath);
    port.getCalls.length = 0;
    connected(sync);
    await flush();
    expect(port.getCalls).toContain(`${base}/programs/available`);
    expect(port.getCalls).not.toContain(defPath);
  });

  it("F16: an older REST answer does not move the option gate back to the program it names", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    const dryerKey = "LaundryCare.Dryer.Option.DryingTarget";
    const wdKey = "LaundryCare.WasherDryer.Option.DryingTarget";
    const A = "LaundryCare.WasherDryer.Program.Cotton";
    const B = "LaundryCare.WasherDryer.Program.Mix";
    const dryerValues = ["IronDry"].map(v => `LaundryCare.Dryer.EnumType.DryingTarget.${v}`);
    const wdValues = ["IronDry"].map(v => `LaundryCare.WasherDryer.EnumType.DryingTargetWD.${v}`);
    port.getResponses.set("/api/homeappliances", {
      homeappliances: [{ haId: "HA-1", name: "WD", connected: true, type: "WasherDryer", enumber: "WD" }],
    });
    port.getResponses.set(`${base}/status`, { status: [] });
    port.getResponses.set(`${base}/settings`, { settings: [] });
    port.getResponses.set(`${base}/commands`, { commands: [] });
    port.getResponses.set(`${base}/programs/available`, { programs: [{ key: A }, { key: B }] });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(A)}`, {
      key: A,
      options: [{ key: dryerKey, type: "Enum", constraints: { allowedvalues: dryerValues } }],
    });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(B)}`, {
      key: B,
      options: [{ key: wdKey, type: "Enum", constraints: { allowedvalues: wdValues } }],
    });
    port.getResponses.set(`${base}/programs/selected`, { key: A, options: [] });
    port.getResponses.set(`${base}/programs/active`, {});
    await sync.syncAppliances();
    // A reconnect reads /programs/selected (still "A") while the stream reports B.
    const held = hold(port, `${base}/programs/selected`);
    connected(sync);
    await flush();
    sync.handleStreamEvent({
      event: "NOTIFY",
      data: JSON.stringify({ haId: "HA-1", items: [{ key: "BSH.Common.Root.SelectedProgram", value: B }] }),
      id: undefined,
    });
    await flush();
    held.release();
    await flush();
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.wd-1.options.dryingTarget`, "irondry");
    expect(port.writes.at(-1)?.body).toEqual({ key: wdKey, value: wdValues[0] });
  });

  it("B10: a refused program list still shows that nothing is selected any more", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    const a = "Dishcare.Dishwasher.Program.Eco50";
    appliance(port, "HA-1", "Spueler", { status: [], settings: [], commands: [], available: [a] });
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(a)}`, { key: a, options: [] });
    port.getResponses.set(`${base}/programs/selected`, { key: a, options: [] });
    await sync.syncAppliances();
    expect(port.states.get("spueler-1.programs.selectedProgram")).toBe("eco50");
    // The list is refused (the list keeps its entries), and nothing is selected any more.
    port.getResponses.delete(`${base}/programs/available`);
    port.getResponses.set(`${base}/programs/selected`, null);
    connected(sync);
    await flush();
    expect(port.states.get("spueler-1.programs.selectedProgram")).toBe("");
    // … and the dropdown keeps what the last list offered.
    const common = port.objects.get("spueler-1.programs.selectedProgram")?.common as { states?: object; type?: string };
    expect(Object.keys(common.states ?? {})).toEqual(["", "eco50"]);
  });

  it("B8: resuming an interrupted move keeps what already arrived, with its value", async () => {
    const port = new FakePort();
    const legacyId = "geschirrspueler";
    const schemeId = "sx87tx02ce-60";
    const native = { haId: "HA-1", type: "Dishwasher", enumber: "SX87TX02CE/60", vib: "SX87TX02CE" };
    const childLock = {
      _id: "",
      type: "state",
      common: { name: "Kindersicherung", type: "boolean", role: "switch", read: true, write: true },
      native: { bshKey: "BSH.Common.Setting.ChildLock" },
    } as unknown as ioBroker.Object;
    port.primeDevices = {
      [`${NS}.${legacyId}`]: { _id: "", type: "device", common: {}, native } as unknown as ioBroker.Object,
      [`${NS}.${schemeId}`]: { _id: "", type: "device", common: {}, native } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.${legacyId}.settings.childLock`]: childLock,
      [`${NS}.${schemeId}.settings.childLock`]: childLock,
    };
    for (const map of [port.primeDevices, port.primeStates]) {
      for (const [fullId, obj] of Object.entries(map)) {
        port.objects.set(fullId.slice(`${NS}.`.length), obj);
      }
    }
    // Moved before the interruption and changed since; the leftover holds the old value.
    port.states.set(`${schemeId}.settings.childLock`, false);
    port.states.set(`${legacyId}.settings.childLock`, true);
    const sync = new ApplianceSync(port);
    await sync.migrateDeviceIds();
    const finalId = "sx87tx02ce-1";
    expect(port.states.get(`${finalId}.settings.childLock`)).toBe(false);
    expect(port.objects.has(legacyId)).toBe(false);
    expect([...port.objects.keys()].filter(k => !k.includes("."))).toEqual([finalId]);
  });

  it("B11: a stop while the first of two expanded states is written creates no second one", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, "HA-1", "Ofen", {
      type: "Oven",
      status: [{ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Locked" }],
      settings: [],
      commands: [],
    });
    const real = port.extendObject.bind(port);
    port.extendObject = (id: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      if (id === "ofen-1.status.doorOpen") {
        sync.stop();
      }
      return real(id, obj);
    };
    await sync.syncAppliances();
    expect(port.objects.has("ofen-1.status.doorOpen")).toBe(true);
    expect(port.objects.has("ofen-1.status.doorLocked")).toBe(false);
  });

  it("B11: a stop while a setting definition is read does not persist the definition cache", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const key = "BSH.Common.Setting.ChildLock";
    appliance(port, "HA-1", "Spueler", { status: [], settings: [{ key, value: true }], commands: [] });
    port.getResponses.set(`${base}/settings/${encodeURIComponent(key)}`, { key, type: "Boolean", constraints: {} });
    const persisted: unknown[] = [];
    const real = port.extendObject.bind(port);
    port.extendObject = (id: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      if ((obj.native as { settingDefs?: unknown } | undefined)?.settingDefs !== undefined) {
        persisted.push(obj.native);
      }
      return real(id, obj);
    };
    port.onGet = path => {
      if (path === `${base}/settings/${encodeURIComponent(key)}`) {
        sync.stop();
      }
    };
    await sync.syncAppliances();
    expect(persisted).toEqual([]);
  });

  it("B11: a stop while a program definition is read seeds no option value", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    const programKey = "Dishcare.Dishwasher.Program.Eco50";
    port.getResponses.set(`${base}/programs/available/${encodeURIComponent(programKey)}`, {
      key: programKey,
      options: [
        { key: "BSH.Common.Option.StartInRelative", type: "Int", constraints: { min: 0, max: 100, default: 30 } },
      ],
    });
    port.onGet = path => {
      if (path.includes("/programs/available/")) {
        sync.stop();
      }
    };
    await sync.activateProgramOptions("spueler", "HA-1", programKey);
    expect([...port.states.keys()].filter(k => k.includes(".options."))).toEqual([]);
  });

  it("B11: a stop while the commands are read relabels no existing button", async () => {
    const key = "Cooking.Oven.Command.Unlisted";
    const id = "geschirrspueler.commands.unlisted";
    /**
     * A synced appliance whose command button carries the cloud's older name.
     *
     * @param stopOnCommands whether the stop comes while the command list is read
     * @returns the ids the sync wrote objects for
     */
    const run = async (stopOnCommands: boolean): Promise<string[]> => {
      const port = new FakePort();
      const sync = new ApplianceSync(port);
      const stale = {
        _id: "",
        type: "state",
        common: { name: "Old cloud name", type: "boolean", role: "button", read: false, write: true },
        native: { bshKey: key, nameSource: "api" },
      } as unknown as ioBroker.Object;
      port.primeDevices = {
        [`${NS}.geschirrspueler`]: {
          _id: "",
          type: "device",
          common: {},
          native: { haId: "HA-1" },
        } as unknown as ioBroker.Object,
      };
      port.primeStates = { [`${NS}.${id}`]: stale };
      port.objects.set(id, stale);
      await sync.primeFromObjects();
      appliance(port, "HA-1", "Geschirrspüler", {
        status: [],
        settings: [],
        commands: [{ key, name: "New cloud name" }],
      });
      port.onGet = path => {
        if (stopOnCommands && path === "/api/homeappliances/HA-1/commands") {
          sync.stop();
        }
      };
      port.extendCalls.length = 0;
      await sync.syncAppliances();
      return port.extendCalls;
    };
    // Without a stop the new cloud name reaches the button …
    expect(await run(false)).toContain(id);
    // … after a stop nothing is written any more.
    expect(await run(true)).not.toContain(id);
  });
});

describe("ApplianceSync trees of the previous adapter generation (community 1.6.x)", () => {
  const ROOT = "015090396331005775";
  const OLD = `${NS}.${ROOT}`;

  /**
   * The dishwasher as the community adapter 1.6.x left it: the haId as root, raw BSH keys with
   * underscores as leaves, and what a user attached to it.
   *
   * @param port the fake port
   * @param attach whether a recording, a room and an alias point into the tree
   */
  function communityTree(port: FakePort, attach = true): void {
    const recording = attach ? { custom: { "influxdb.0": { enabled: true } } } : {};
    seed(port, {
      [OLD]: { type: "device", common: { name: "Geschirrspüler" }, native: {} },
      [`${OLD}.general.connected`]: { type: "state", common: { name: "connected", type: "boolean" }, native: {} },
      [`${OLD}.status.BSH_Common_Status_OperationState`]: {
        type: "state",
        common: { name: "Operation State", type: "string", ...recording },
        native: {},
      },
      [`${OLD}.status.BSH_Common_Status_DoorState`]: {
        type: "state",
        common: { name: "Door State", type: "string", ...recording },
        native: {},
      },
      [`${OLD}.own_request.BSH_Common_Setting_Custom`]: {
        type: "state",
        common: { name: "Own", type: "string", ...recording },
        native: {},
      },
      [`${OLD}.commands.BSH_Common_Command_StopProgram`]: {
        type: "state",
        common: { name: "TRUE = Stop", type: "boolean" },
        native: {},
      },
    });
    if (attach) {
      seed(port, {
        "enum.rooms.kitchen": {
          type: "enum",
          common: { name: "Kitchen", members: [`${OLD}.status.BSH_Common_Status_DoorState`, "hm-rpc.0.X"] },
          native: {},
        },
        "alias.0.kitchen.online": {
          type: "state",
          common: { name: "Online", alias: { id: `${OLD}.general.connected` } },
          native: {},
        },
      });
    }
  }

  /**
   * The same dishwasher on the Home Connect account, read in full.
   *
   * @param port the fake port
   * @param connected whether it is switched on
   */
  function onAccount(port: FakePort, connected = true): void {
    appliance(port, ROOT, "Geschirrspüler", {
      vib: "SX87TX02CE",
      enumber: "SX87TX02CE/60",
      connected,
      status: [
        { key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Ready" },
        { key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Closed" },
      ],
      settings: [],
      commands: [],
    });
  }

  it("removes a tree nobody attached anything to right away", async () => {
    const port = new FakePort();
    communityTree(port, false);
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    expect([...port.objects.keys()].filter(k => k.startsWith(ROOT))).toEqual([]);
    expect(port.logs.filter(l => l.startsWith("info"))).toEqual([
      "info: Removed 1 object tree(s) of the previous adapter generation — the new device tree replaces them; your sign-in is kept.",
    ]);
  });

  it("never touches the sign-in or this adapter's own trees, and says nothing when there is nothing to do", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.auth.session`]: { type: "state", common: {}, native: {} },
      [`${NS}.sx87tx02ce-5775`]: { type: "device", common: {}, native: { haId: ROOT, idScheme: 3 } },
      [`${NS}.sx87tx02ce-5775.status.operationState`]: { type: "state", common: {}, native: {} },
    });
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    expect(port.deleted).toEqual([]);
    expect(port.logs).toEqual([]);
  });

  it("plans only from this instance's own objects", async () => {
    const port = new FakePort();
    port.getAdapterObjects = (): Promise<Record<string, ioBroker.Object>> =>
      // A mis-scoped listing: planning from the raw id would aim a recursive delete at another adapter.
      Promise.resolve({
        "other.0.SIEMENS-X.status.BSH_Common_Status_DoorState": { type: "state", common: {}, native: {} },
      } as unknown as Record<string, ioBroker.Object>);
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    expect(port.deleted).toEqual([]);
  });

  it("keeps going when one legacy tree cannot be deleted", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.SIEMENS-A-0011`]: { type: "folder", common: {}, native: {} },
      [`${NS}.SIEMENS-B-0022`]: { type: "folder", common: {}, native: {} },
    });
    const real = port.delObjectRecursive.bind(port);
    port.delObjectRecursive = (id: string): Promise<void> =>
      id.startsWith("SIEMENS-A") ? Promise.reject(new Error("locked")) : real(id);
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    expect(port.objects.has("SIEMENS-B-0022")).toBe(false);
    expect(port.logs).toContain("debug: legacy cleanup: could not delete SIEMENS-A-0011: locked");
  });

  it("holds a tree with a recording, a room or an alias until its appliance has been read in full", async () => {
    const port = new FakePort();
    communityTree(port);
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    expect(port.deleted).toEqual([]);
    expect(port.logs.filter(l => l.startsWith("info"))).toEqual([
      "info: 1 object tree(s) of the previous adapter generation carry recordings, rooms or aliases — they move to the new datapoints once the appliance has been read.",
    ]);
    // Switched off: no full read, so the old tree still waits.
    onAccount(port, false);
    await sync.syncAppliances();
    expect(port.objects.has(ROOT)).toBe(true);
  });

  it("carries recordings, rooms and aliases to the new datapoints and removes the old tree", async () => {
    const port = new FakePort();
    communityTree(port);
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    onAccount(port);
    port.logs.length = 0;
    await sync.syncAppliances();

    const NEW = `${NS}.sx87tx02ce-5775`;
    // Same value type: the series goes on under the old id.
    expect(port.objects.get("sx87tx02ce-5775.status.operationState")?.common?.custom).toEqual({
      "influxdb.0": { enabled: true, aliasId: `${OLD}.status.BSH_Common_Status_OperationState` },
    });
    // The operation state also feeds the running flag — a yes/no: a new series, no alias id.
    expect(port.objects.get("sx87tx02ce-5775.status.programRunning")?.common?.custom).toEqual({
      "influxdb.0": { enabled: true },
    });
    // The door text became yes/no: recorded again, as a new series.
    expect(port.objects.get("sx87tx02ce-5775.status.doorOpen")?.common?.custom).toEqual({
      "influxdb.0": { enabled: true },
    });
    // The room follows the door to its successor; the alias on the old online flag to the marker.
    expect((port.foreign.get("enum.rooms.kitchen")?.common as { members: string[] }).members).toEqual([
      `${NEW}.status.doorOpen`,
      "hm-rpc.0.X",
    ]);
    expect((port.foreign.get("alias.0.kitchen.online")?.common as { alias: unknown }).alias).toEqual({
      id: `${NEW}.info.reachable`,
    });
    expect([...port.objects.keys()].filter(k => k.startsWith(ROOT))).toEqual([]);
    expect(port.logs.filter(l => l.includes("previous adapter generation"))).toEqual([
      "info: Geschirrspüler (sx87tx02ce-5775): took over the object tree 015090396331005775 of the previous adapter generation" +
        " — 2 recording(s), 1 room/function entry, 1 alias(es) carried to the new datapoints;" +
        " 1 datapoint(s) with a recording, room or alias have no counterpart and are gone.",
    ]);
  });

  it("leaves a recording alone that the new datapoint already has", async () => {
    const port = new FakePort();
    communityTree(port);
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    onAccount(port);
    const real = port.extendObject.bind(port);
    // The new datapoint was set up for recording by hand before the old tree was taken over. Only
    // the adapter's own metadata writes restore it — a carry that writes `custom` must stay visible.
    port.extendObject = (id: string, obj: ioBroker.PartialObject): Promise<unknown> => {
      const result = real(id, obj);
      if (id === "sx87tx02ce-5775.status.operationState" && obj.common?.custom === undefined) {
        const stored = port.objects.get(id) as { common: Record<string, unknown> };
        stored.common.custom = { "history.0": { enabled: true } };
      }
      return result;
    };
    await sync.syncAppliances();
    expect(port.objects.get("sx87tx02ce-5775.status.operationState")?.common?.custom).toEqual({
      "history.0": { enabled: true },
    });
  });

  it("removes a waiting tree whose appliance is not on the account", async () => {
    const port = new FakePort();
    communityTree(port);
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    appliance(port, "HA-OTHER", "Oven", { type: "Oven", status: [], settings: [], commands: [] });
    await sync.syncAppliances();
    expect(port.objects.has(ROOT)).toBe(false);
    expect(port.logs).toContain(
      "info: Removed the object tree 015090396331005775 of the previous adapter generation — its appliance is not on the Home Connect account.",
    );
  });

  it("never hands a waiting legacy root to a new appliance, and no tree pass touches it", async () => {
    const port = new FakePort();
    communityTree(port);
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    await sync.primeFromObjects();
    // Priming and the channel naming pass over the legacy tree: it is nobody's appliance yet.
    expect(port.extendCalls.filter(id => id.startsWith(ROOT))).toEqual([]);
  });
});

describe("ApplianceSync.migrateRenamedStates carries what is attached", () => {
  it("continues the recording, and moves the room and the alias to the datapoint's new place", async () => {
    const port = new FakePort();
    const OLD = `${NS}.washer-1.misc.childLock`;
    const NEW = `${NS}.washer-1.settings.childLock`;
    seed(port, {
      [`${NS}.washer-1`]: { type: "device", common: { name: "Washer" }, native: { haId: "HA-1", type: "Washer" } },
      [`${NS}.washer-1.misc`]: { type: "channel", common: { name: "misc" }, native: {} },
      [OLD]: {
        type: "state",
        common: {
          name: "Child lock",
          type: "boolean",
          role: "switch",
          read: true,
          write: false,
          custom: { "influxdb.0": { enabled: true }, "history.0": { enabled: true, aliasId: "my.series" } },
        },
        native: { bshKey: "BSH.Common.Setting.ChildLock" },
      },
      "enum.functions.safety": { type: "enum", common: { name: "Safety", members: [OLD] }, native: {} },
      "alias.0.washer.lock": { type: "state", common: { name: "Lock", alias: { id: OLD } }, native: {} },
    });
    port.states.set("washer-1.misc.childLock", true);
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();

    expect(port.objects.get("washer-1.settings.childLock")?.common?.custom).toEqual({
      "influxdb.0": { enabled: true, aliasId: OLD },
      // An alias id the user chose stays.
      "history.0": { enabled: true, aliasId: "my.series" },
    });
    expect(port.states.get("washer-1.settings.childLock")).toBe(true);
    expect((port.foreign.get("enum.functions.safety")?.common as { members: string[] }).members).toEqual([NEW]);
    expect((port.foreign.get("alias.0.washer.lock")?.common as { alias: unknown }).alias).toEqual({ id: NEW });
    expect(port.objects.has("washer-1.misc.childLock")).toBe(false);
    expect(port.logs.filter(l => l.startsWith("info"))).toEqual([
      "info: Migrated 1 datapoint(s) to the corrected tree layout with 1 alias(es); 1 recording(s) keep their history.",
    ]);
  });

  it("gives a reshaped datapoint's room to every successor", async () => {
    const port = new FakePort();
    const OLD = `${NS}.oven-1.status.doorState`;
    seed(port, {
      [`${NS}.oven-1`]: { type: "device", common: { name: "Oven" }, native: { haId: "HA-1", type: "Oven" } },
      [OLD]: {
        type: "state",
        common: { name: "Door", type: "string", role: "text", read: true, write: false },
        native: { bshKey: "BSH.Common.Status.DoorState" },
      },
      "enum.rooms.kitchen": { type: "enum", common: { name: "Kitchen", members: [OLD] }, native: {} },
    });
    port.states.set("oven-1.status.doorState", "locked");
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    // An oven door locks: the text became two yes/no datapoints, both in the kitchen.
    expect((port.foreign.get("enum.rooms.kitchen")?.common as { members: string[] }).members).toEqual([
      `${NS}.oven-1.status.doorOpen`,
      `${NS}.oven-1.status.doorLocked`,
    ]);
  });
});

describe("ApplianceSync rules the needle run of 2026-09-26 isolates", () => {
  const ROOT = "015090396331005775";
  const OLD = `${NS}.${ROOT}`;

  it("removes a legacy tree right away whose recording settings are empty", async () => {
    const port = new FakePort();
    seed(port, {
      [OLD]: { type: "device", common: { name: "Spüler" }, native: {} },
      [`${OLD}.status.BSH_Common_Status_OperationState`]: {
        type: "state",
        common: { name: "Operation State", type: "string", custom: {} },
        native: {},
      },
    });
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    expect(port.objects.has(ROOT)).toBe(false);
  });

  it("holds a legacy tree that only a room points into", async () => {
    const port = new FakePort();
    seed(port, {
      [OLD]: { type: "device", common: { name: "Spüler" }, native: {} },
      [`${OLD}.status.BSH_Common_Status_DoorState`]: {
        type: "state",
        common: { name: "Door State", type: "string" },
        native: {},
      },
      "enum.rooms.kitchen": {
        type: "enum",
        common: { name: "Kitchen", members: [`${OLD}.status.BSH_Common_Status_DoorState`] },
        native: {},
      },
    });
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    expect(port.objects.has(ROOT)).toBe(true);
  });

  it("creates nothing for a legacy datapoint whose successor the appliance did not report", async () => {
    const port = new FakePort();
    seed(port, {
      [OLD]: { type: "device", common: { name: "Spüler" }, native: {} },
      [`${OLD}.status.BSH_Common_Status_RemoteControlActive`]: {
        type: "state",
        common: { name: "Remote", type: "boolean", custom: { "influxdb.0": { enabled: true } } },
        native: {},
      },
    });
    const sync = new ApplianceSync(port);
    await sync.sortOutLegacyTrees();
    appliance(port, ROOT, "Spüler", { vib: "SX87TX02CE", status: [], settings: [], commands: [] });
    await sync.syncAppliances();
    // No hull of a datapoint the sync never built — the recording has no counterpart and is reported.
    expect(port.objects.has("sx87tx02ce-5775.status.remoteControlActive")).toBe(false);
    expect(port.logs.some(l => l.includes("1 datapoint(s) with a recording, room or alias have no counterpart"))).toBe(
      true,
    );
  });

  it("reports no take-over for an appliance without a legacy tree", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, ROOT, "Spüler", { vib: "SX87TX02CE", status: [], settings: [], commands: [] });
    await sync.syncAppliances();
    expect(port.logs.filter(l => l.includes("previous adapter generation"))).toEqual([]);
    expect(port.enumCarries).toEqual([]);
  });

  it("writes a decided device object not again after a restart", async () => {
    const port = new FakePort();
    const sync = new ApplianceSync(port);
    appliance(port, ROOT, "Spüler", { vib: "SX87TX02CE", connected: false });
    await sync.syncAppliances();
    const stored = port.objects.get("sx87tx02ce-5775") as ioBroker.Object;
    expect(stored.native.idScheme).toBe(3);

    const restarted = new FakePort();
    seed(restarted, { [`${NS}.sx87tx02ce-5775`]: structuredClone(stored) });
    restarted.getResponses.set("/api/homeappliances", port.getResponses.get("/api/homeappliances"));
    const again = new ApplianceSync(restarted);
    await again.primeFromObjects();
    restarted.extendCalls.length = 0;
    await again.syncAppliances();
    expect(restarted.extendCalls.filter(id => id === "sx87tx02ce-5775")).toEqual([]);
  });

  it("does not name the datapoints of the old half of an unfinished move", async () => {
    const port = new FakePort();
    seed(port, {
      [`${NS}.sx87tx02ce-60`]: {
        type: "device",
        common: { name: "Old" },
        native: { haId: ROOT, movingTo: "sx87tx02ce-5775" },
      },
      [`${NS}.sx87tx02ce-60.status.operationState`]: {
        type: "state",
        common: { name: "operationState", type: "string" },
        native: { bshKey: "BSH.Common.Status.OperationState" },
      },
      [`${NS}.sx87tx02ce-5775`]: { type: "device", common: { name: "New" }, native: { haId: ROOT, idScheme: 3 } },
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    expect(port.extendCalls.filter(id => id.startsWith("sx87tx02ce-60"))).toEqual([]);
  });
});

describe("readable values (2026-09-28)", () => {
  const base = "/api/homeappliances/HA-1";
  const wd = (v: string): string => `LaundryCare.WasherDryer.Program.${v}`;

  it("writes value labels in the system language", async () => {
    const port = new FakePort();
    port.language = "de";
    appliance(port, "HA-1", "Spueler", {
      status: [{ key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Ready" }],
      available: ["Dishcare.Dishwasher.Program.Auto2", "Dishcare.Dishwasher.Program.Eco50"],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const op = port.objects.get("spueler-1.status.operationState")?.common as ioBroker.StateCommon;
    expect(op.states).toMatchObject({ ready: "Bereit", run: "Läuft", finished: "Beendet" });
    const sel = port.objects.get("spueler-1.programs.selectedProgram")?.common as ioBroker.StateCommon;
    expect(sel.states).toEqual({ "": "Kein Programm", auto2: "Auto 45-65 °C", eco50: "Eco 50 °C" });
  });

  it("gives the running program the list of the selection", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Spueler", { status: [], available: ["Dishcare.Dishwasher.Program.Auto2"] });
    port.getResponses.set(`${base}/programs/active`, { key: "Dishcare.Dishwasher.Program.Auto2" });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const active = port.objects.get("spueler-1.programs.activeProgram")?.common as ioBroker.StateCommon;
    expect(active.states).toEqual({ "": "No program", auto2: "Auto 45-65 °C" });
    expect(port.states.get("spueler-1.programs.activeProgram")).toBe("auto2");
  });

  it("adds a program chosen at the appliance to both lists — once, however often it streams", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Wt", { type: "WasherDryer", status: [], available: [wd("Cotton")] });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    port.extendCalls.length = 0;
    for (let i = 0; i < 5; i++) {
      sync.handleStreamEvent({
        event: "NOTIFY",
        id: "HA-1",
        data: JSON.stringify({
          items: [
            { key: "BSH.Common.Root.SelectedProgram", value: wd("Spin") },
            { key: "BSH.Common.Root.ActiveProgram", value: wd("Spin") },
          ],
        }),
      });
      await flush();
    }
    expect(port.extendCalls.filter(id => id === "wt-1.programs.selectedProgram")).toHaveLength(1);
    expect(port.extendCalls.filter(id => id === "wt-1.programs.activeProgram")).toHaveLength(1);
    const sel = port.objects.get("wt-1.programs.selectedProgram") as ioBroker.StateObject;
    expect(sel.common.states).toMatchObject({ cotton: "Cotton", spin: "Spin" });
    expect(sel.native.seenValues).toEqual([wd("Spin")]);
    expect(port.states.get("wt-1.programs.selectedProgram")).toBe("spin");
    // Not a write candidate: the cloud does not offer it for selection.
    expect(sel.native.bshValues).toEqual([wd("Cotton")]);
  });

  it("keeps a seen program across a restart without rewriting the object", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Wt", { type: "WasherDryer", status: [], available: [wd("Cotton")] });
    port.getResponses.set(`${base}/programs/selected`, { key: wd("Spin") });
    const first = new ApplianceSync(port);
    await first.syncAppliances();
    const sel = port.objects.get("wt-1.programs.selectedProgram") as ioBroker.StateObject;
    expect(sel.common.states).toMatchObject({ spin: "Spin" });

    // Restart: the objects are what the database holds; a sync must not rewrite them.
    for (const [id, obj] of port.objects) {
      const full = { ...(obj as object), _id: `${NS}.${id}` } as unknown as ioBroker.Object;
      if (obj.type === "device") {
        port.primeDevices[`${NS}.${id}`] = full;
      } else if (obj.type === "state") {
        port.primeStates[`${NS}.${id}`] = full;
      }
    }
    const second = new ApplianceSync(port);
    await second.primeFromObjects();
    port.extendCalls.length = 0;
    await second.syncAppliances();
    expect(port.extendCalls.filter(id => id.includes(".programs."))).toEqual([]);
  });

  it("answers a write of a program the appliance only ran on info, and sends nothing", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Wt", { type: "WasherDryer", status: [], available: [wd("Cotton")] });
    port.getResponses.set(`${base}/programs/selected`, { key: wd("Spin") });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    port.writes.length = 0;
    await sync.handleWrite(`${NS}.wt-1.programs.selectedProgram`, "spin");
    expect(port.writes).toEqual([]);
    expect(port.logs.some(l => l.startsWith("info: ") && l.includes("can only be chosen at the appliance"))).toBe(true);
    // An offered program still goes out.
    await sync.handleWrite(`${NS}.wt-1.programs.selectedProgram`, "cotton");
    expect(port.writes).toHaveLength(1);
  });

  it("does not rewrite an option that two appliance families define under one id", async () => {
    // `LaundryCare.Washer.Option.IDos1.Active` and `…IDos1Active` both land on
    // options.iDos1Active; taking each definition's key flipped the signature and
    // rewrote the object once per definition (401 times per start, measured).
    const port = new FakePort();
    const programs = [wd("Cotton"), wd("Wool"), wd("Spin")];
    appliance(port, "HA-1", "Wt", { type: "WasherDryer", status: [], available: programs });
    for (const p of programs) {
      port.getResponses.set(`${base}/programs/available/${p}`, {
        key: p,
        options: [
          { key: "LaundryCare.Washer.Option.IDos1.Active", type: "Boolean", constraints: { default: true } },
          { key: "LaundryCare.Washer.Option.IDos1Active", type: "Boolean", constraints: { default: true } },
        ],
      });
    }
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const writes = port.extendCalls.filter(id => id === "wt-1.options.iDos1Active");
    expect(writes).toHaveLength(1);
    port.extendCalls.length = 0;
    await sync.syncAppliances();
    expect(port.extendCalls.filter(id => id === "wt-1.options.iDos1Active")).toEqual([]);
  });

  it("replaces a stored cloud label with the adapter's own when an option definition merges", async () => {
    const port = new FakePort();
    port.language = "de";
    const p = "LaundryCare.Washer.Program.Cotton";
    appliance(port, "HA-1", "Wm", { type: "Washer", status: [], available: [p] });
    port.getResponses.set(`${base}/programs/available/${p}`, {
      key: p,
      options: [
        {
          key: "LaundryCare.Washer.Option.SpinSpeed",
          type: "LaundryCare.Washer.EnumType.SpinSpeed",
          constraints: {
            allowedvalues: ["LaundryCare.Washer.EnumType.SpinSpeed.RPM1400"],
            displayvalues: ["1400 rpm"],
          },
        },
      ],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    const spin = port.objects.get("wm-1.options.spinSpeed")?.common as ioBroker.StateCommon;
    expect(spin.states).toEqual({ rpm1400: "1400 U/min" });
  });

  it("reloads a definition cached by 1.24.0 once, so its options get the adapter's labels", async () => {
    // Generation 3 stood on every installation before 1.25.0: its option objects carried the cloud's labels
    // and are written only when a definition loads — without the raise they kept them for good.
    const port = new FakePort();
    port.language = "de";
    const p = "LaundryCare.Washer.Program.Cotton";
    const id = "wm-1.options.spinSpeed";
    const device = {
      _id: `${NS}.wm-1`,
      type: "device",
      common: { name: "Wm" },
      native: {
        haId: "HA-1",
        type: "Washer",
        enumber: "Wm",
        idScheme: 3,
        programOptions: {
          [p]: { ids: ["spinSpeed"], keys: { spinSpeed: "LaundryCare.Washer.Option.SpinSpeed" }, v: 3 },
        },
      },
    } as unknown as ioBroker.Object;
    port.primeDevices = { [`${NS}.wm-1`]: device };
    port.objects.set("wm-1", structuredClone(device));
    const stored = {
      _id: `${NS}.${id}`,
      type: "state",
      common: { name: "Spin", type: "string", role: "text", read: true, write: true, states: { rpm1400: "1400 rpm" } },
      native: {
        bshKey: "LaundryCare.Washer.Option.SpinSpeed",
        bshValues: ["LaundryCare.Washer.EnumType.SpinSpeed.RPM1400"],
      },
    } as unknown as ioBroker.Object;
    port.primeStates = { [`${NS}.${id}`]: stored };
    port.objects.set(id, structuredClone(stored));
    appliance(port, "HA-1", "Wm", { type: "Washer", status: [], available: [p] });
    const defPath = `${base}/programs/available/${p}`;
    port.getResponses.set(defPath, {
      key: p,
      options: [
        {
          key: "LaundryCare.Washer.Option.SpinSpeed",
          type: "LaundryCare.Washer.EnumType.SpinSpeed",
          constraints: {
            allowedvalues: ["LaundryCare.Washer.EnumType.SpinSpeed.RPM1400"],
            displayvalues: ["1400 rpm"],
          },
        },
      ],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();
    expect(port.getCalls.filter(c => c === defPath)).toHaveLength(1);
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toEqual({ rpm1400: "1400 U/min" });
    // Reloaded once: the next pass answers from the cache again.
    await sync.syncAppliances();
    expect(port.getCalls.filter(c => c === defPath)).toHaveLength(1);
  });

  it("relabels a stored cloud label even for a value the current definition no longer lists", async () => {
    // Another program of this generation brought the speed with the cloud's English label; this
    // definition brings a different one, so the union keeps the stored value — with the adapter's label.
    const port = new FakePort();
    port.language = "de";
    const p = "LaundryCare.Washer.Program.Cotton";
    const id = "wm-1.options.spinSpeed";
    port.primeDevices = {
      [`${NS}.wm-1`]: {
        _id: `${NS}.wm-1`,
        type: "device",
        common: { name: "Wm" },
        native: { haId: "HA-1", type: "Washer", enumber: "Wm", idScheme: 3 },
      } as unknown as ioBroker.Object,
    };
    const stored = {
      _id: `${NS}.${id}`,
      type: "state",
      common: { name: "Spin", type: "string", role: "text", read: true, write: true, states: { rpm1400: "1400 rpm" } },
      native: {
        bshKey: "LaundryCare.Washer.Option.SpinSpeed",
        bshValues: ["LaundryCare.Washer.EnumType.SpinSpeed.RPM1400"],
        defGeneration: 4,
      },
    } as unknown as ioBroker.Object;
    port.primeStates = { [`${NS}.${id}`]: stored };
    port.objects.set(id, structuredClone(stored));
    appliance(port, "HA-1", "Wm", { type: "Washer", status: [], available: [p] });
    port.getResponses.set(`${base}/programs/available/${p}`, {
      key: p,
      options: [
        {
          key: "LaundryCare.Washer.Option.SpinSpeed",
          type: "LaundryCare.Washer.EnumType.SpinSpeed",
          constraints: { allowedvalues: ["LaundryCare.Washer.EnumType.SpinSpeed.RPM1200"] },
        },
      ],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();
    const spin = port.objects.get(id)?.common as ioBroker.StateCommon;
    expect(spin.states).toEqual({ rpm1400: "1400 U/min", rpm1200: "1200 U/min" });
  });

  it("gives a stored value list its own labels at start, without the cloud and only once", async () => {
    // Measured 2026-09-29 on a washer-dryer: no current definition carried the temperature, so
    // the labels 1.24.0 stored ("Cold") stood on a German installation after the update.
    const port = new FakePort();
    port.language = "de";
    const id = "wm-1.options.temperature";
    const t = "LaundryCare.Washer.EnumType.Temperature";
    port.primeDevices = {
      [`${NS}.wm-1`]: {
        _id: `${NS}.wm-1`,
        type: "device",
        common: { name: "Wm" },
        native: { haId: "HA-1", type: "Washer", enumber: "Wm", idScheme: 3 },
      } as unknown as ioBroker.Object,
    };
    const stored = {
      _id: `${NS}.${id}`,
      type: "state",
      common: {
        name: "Temperature",
        type: "string",
        role: "text",
        read: true,
        write: true,
        states: { cold: "Cold", gc20: "20°C", mysteryvalue: "mysteryvalue", othervalue: "Cloud text" },
      },
      native: {
        bshKey: "LaundryCare.Washer.Option.Temperature",
        bshValues: [`${t}.Cold`, `${t}.GC20`, `${t}.MysteryValue`, `${t}.OtherValue`],
        defGeneration: 4,
      },
    } as unknown as ioBroker.Object;
    port.primeStates = { [`${NS}.${id}`]: stored };
    port.objects.set(id, structuredClone(stored));
    await new ApplianceSync(port).primeFromObjects();
    expect(port.getCalls).toEqual([]);
    // Own label where the table has one; a cloud text the table lacks stays; a bare short value never is a label.
    expect((port.objects.get(id)?.common as ioBroker.StateCommon).states).toEqual({
      cold: "Kalt",
      gc20: "20 °C",
      mysteryvalue: "Mystery value",
      othervalue: "Cloud text",
    });
    // The next start finds the labels in place and writes nothing.
    port.primeStates = { [`${NS}.${id}`]: structuredClone(port.objects.get(id)!) as ioBroker.Object };
    const before = port.extendCalls.length;
    await new ApplianceSync(port).primeFromObjects();
    expect(port.extendCalls.slice(before)).not.toContain(id);
  });

  it("the label repair at start never adds a value and leaves a label the table lacks", async () => {
    // Which values a list holds is the definitions' business: a value only the stored full values
    // name gets no label here, and a read-only list keeps what the table cannot improve.
    const port = new FakePort();
    port.language = "de";
    const t = "LaundryCare.Washer.EnumType.Temperature";
    port.primeDevices = {
      [`${NS}.wm-1`]: {
        _id: `${NS}.wm-1`,
        type: "device",
        common: { name: "Wm" },
        native: { haId: "HA-1", type: "Washer", enumber: "Wm", idScheme: 3 },
      } as unknown as ioBroker.Object,
    };
    const option = {
      _id: `${NS}.wm-1.options.temperature`,
      type: "state",
      common: { name: "T", type: "string", role: "text", read: true, write: true, states: { cold: "Kalt" } },
      native: {
        bshKey: "LaundryCare.Washer.Option.Temperature",
        bshValues: [`${t}.Cold`, `${t}.GC40`],
        nameSource: "api",
        defGeneration: 4,
      },
    } as unknown as ioBroker.Object;
    const status = {
      _id: `${NS}.wm-1.status.somePhase`,
      type: "state",
      common: {
        name: "P",
        type: "string",
        role: "text",
        read: true,
        write: false,
        states: { ready: "Bereit", weirdphase: "Seltsam" },
      },
      native: { bshKey: "LaundryCare.Washer.Status.SomePhase", nameSource: "api" },
    } as unknown as ioBroker.Object;
    port.primeStates = { [option._id]: option, [status._id]: status };
    port.objects.set("wm-1.options.temperature", structuredClone(option));
    port.objects.set("wm-1.status.somePhase", structuredClone(status));
    await new ApplianceSync(port).primeFromObjects();
    // The option's name is repaired at start as well, so only its list is looked at here.
    expect(port.extendCalls).not.toContain("wm-1.status.somePhase");
    expect((port.objects.get("wm-1.options.temperature")?.common as ioBroker.StateCommon).states).toEqual({
      cold: "Kalt",
    });
    expect((port.objects.get("wm-1.status.somePhase")?.common as ioBroker.StateCommon).states).toEqual({
      ready: "Bereit",
      weirdphase: "Seltsam",
    });
  });

  it("gives an enum an older version stored without a list the catalogue's list at start", async () => {
    // Measured 2026-09-29: eight enums of krobi's appliances carried no list after the update to
    // 1.25.0 — the definitions that would rebuild them did not name them while the appliances idled.
    const port = new FakePort();
    port.language = "de";
    port.primeDevices = {
      [`${NS}.wd-1`]: {
        _id: `${NS}.wd-1`,
        type: "device",
        common: { name: "Wd" },
        native: { haId: "HA-1", type: "WasherDryer", enumber: "Wd", idScheme: 3 },
      } as unknown as ioBroker.Object,
    };
    const text = (id: string, native: Record<string, unknown>, write = true): ioBroker.Object =>
      ({
        _id: `${NS}.${id}`,
        type: "state",
        common: { name: "X", type: "string", role: "text", read: true, write },
        native: { nameSource: "api", ...native },
      }) as unknown as ioBroker.Object;
    const objects: Record<string, ioBroker.Object> = {
      // The catalogue knows the key; a value of the other family with the same tail stays one entry,
      // and a value the catalogue lacks joins the list.
      "wd-1.options.dryingTarget": text("wd-1.options.dryingTarget", {
        bshKey: "LaundryCare.WasherDryer.Option.DryingTarget",
        seenValues: [
          "LaundryCare.Dryer.EnumType.DryingTarget.CupboardDry",
          "LaundryCare.WasherDryer.EnumType.DryingTargetWD.SuperDry",
        ],
      }),
      // Known only from the appliance descriptions: the stored value lends the prefix.
      "wd-1.settings.timeLight": text("wd-1.settings.timeLight", {
        bshKey: "Dishcare.Dishwasher.Setting.TimeLight",
        bshValues: ["Dishcare.Dishwasher.EnumType.TimeLight.Off"],
      }),
      // No value to lend a prefix: waits for its next value.
      "wd-1.status.programPhase": text(
        "wd-1.status.programPhase",
        { bshKey: "Dishcare.Dishwasher.Status.ProgramPhase" },
        false,
      ),
      // A plain text of a BSH key the catalogue does not know stays a plain text.
      "wd-1.status.someText": text("wd-1.status.someText", { bshKey: "LaundryCare.Washer.Status.SomeText" }, false),
    };
    port.primeStates = Object.fromEntries(Object.values(objects).map(o => [o._id, o]));
    for (const [id, o] of Object.entries(objects)) {
      port.objects.set(id, structuredClone(o));
    }
    await new ApplianceSync(port).primeFromObjects();
    expect(port.getCalls).toEqual([]);
    const states = (id: string): unknown => (port.objects.get(id)?.common as ioBroker.StateCommon).states;
    expect(states("wd-1.options.dryingTarget")).toEqual({
      irondry: "Bügeltrocken",
      gentledry: "Schonend trocken",
      cupboarddry: "Schranktrocken",
      cupboarddryplus: "Schranktrocken plus",
      extradry: "Extra trocken",
      superdry: "Super dry",
    });
    expect(states("wd-1.settings.timeLight")).toEqual({ off: "Aus", on: "Ein" });
    expect(states("wd-1.status.programPhase")).toBeUndefined();
    expect(states("wd-1.status.someText")).toBeUndefined();
    // The next start finds the lists in place.
    const again = new FakePort();
    again.language = "de";
    again.primeDevices = port.primeDevices;
    again.primeStates = Object.fromEntries(
      Object.keys(objects).map(id => [
        `${NS}.${id}`,
        { ...port.objects.get(id)!, _id: `${NS}.${id}` } as ioBroker.Object,
      ]),
    );
    for (const id of Object.keys(objects)) {
      again.objects.set(id, structuredClone(port.objects.get(id)!));
    }
    await new ApplianceSync(again).primeFromObjects();
    expect(again.extendCalls).toEqual([]);
  });

  it("a relabelled value list is no change for the next sync", async () => {
    // The relabelling at start keeps the remembered signature in step with the object, so the
    // first answer that carries the datapoint does not write the same labels a second time.
    const port = new FakePort();
    port.language = "de";
    const id = "wm-1.status.operationState";
    const o = "BSH.Common.EnumType.OperationState";
    port.primeDevices = {
      [`${NS}.wm-1`]: {
        _id: `${NS}.wm-1`,
        type: "device",
        common: { name: "Wm" },
        native: { haId: "HA-1", type: "Washer", enumber: "Wm", idScheme: 3 },
      } as unknown as ioBroker.Object,
    };
    appliance(port, "HA-1", "Wm", {
      type: "Washer",
      status: [{ key: "BSH.Common.Status.OperationState", value: `${o}.Ready` }],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();
    const built = structuredClone(port.objects.get(id)!);
    const english = structuredClone(built);
    const states = (english.common as ioBroker.StateCommon).states as Record<string, string>;
    for (const k of Object.keys(states)) {
      states[k] = `${k} (en)`;
    }
    const again = new FakePort();
    again.language = "de";
    again.primeDevices = port.primeDevices;
    again.primeStates = { [`${NS}.${id}`]: { ...english, _id: `${NS}.${id}` } as ioBroker.Object };
    again.objects.set(id, structuredClone(english));
    appliance(again, "HA-1", "Wm", {
      type: "Washer",
      status: [{ key: "BSH.Common.Status.OperationState", value: `${o}.Ready` }],
    });
    const next = new ApplianceSync(again);
    await next.primeFromObjects();
    expect(again.objects.get(id)?.common).toEqual(built.common);
    await next.syncAppliances();
    expect(again.extendCalls.filter(c => c === id)).toHaveLength(1);
  });

  describe("an option list of an older definition generation is rebuilt once", () => {
    const programA = "Cooking.Oven.Program.HeatingMode.HotAir";
    const programB = "Cooking.Oven.Program.HeatingMode.PizzaSetting";
    const levelKey = "Cooking.Oven.Option.Level";
    const id = "ov-1.options.level";

    /**
     * An oven whose level option an older version built with values no program offers.
     *
     * @param programs the programs the appliance lists
     * @returns the port
     */
    function oven(programs: string[]): FakePort {
      const port = new FakePort();
      port.language = "de";
      const device = {
        _id: `${NS}.ov-1`,
        type: "device",
        common: { name: "Ov" },
        native: {
          haId: "HA-O",
          type: "Oven",
          enumber: "Ov",
          idScheme: 3,
          programOptions: Object.fromEntries(
            programs.map(k => [k, { ids: ["level"], keys: { level: levelKey }, v: 3 }]),
          ),
        },
      } as unknown as ioBroker.Object;
      port.primeDevices = { [`${NS}.ov-1`]: device };
      port.objects.set("ov-1", structuredClone(device));
      const stored = {
        _id: `${NS}.${id}`,
        type: "state",
        common: {
          name: "Level",
          type: "string",
          role: "text",
          read: true,
          write: true,
          states: { level01: "Level 1", whitetea: "White tea", greentea: "Green tea" },
        },
        native: {
          bshKey: levelKey,
          bshValues: [
            "Cooking.Oven.EnumType.Level.Level01",
            "Cooking.Hob.EnumType.HotWaterTemperature.WhiteTea",
            "Cooking.Hob.EnumType.HotWaterTemperature.GreenTea",
          ],
        },
      } as unknown as ioBroker.Object;
      port.primeStates = { [`${NS}.${id}`]: stored };
      port.objects.set(id, structuredClone(stored));
      appliance(port, "HA-O", "Ov", { type: "Oven", status: [], available: programs });
      return port;
    }

    /**
     * A level definition offering the given levels.
     *
     * @param program the program key
     * @param levels the level names
     * @returns the definition
     */
    function levelDef(program: string, levels: string[]): Record<string, unknown> {
      return {
        key: program,
        options: [
          {
            key: levelKey,
            type: "Cooking.Oven.EnumType.Level",
            constraints: { allowedvalues: levels.map(l => `Cooking.Oven.EnumType.Level.${l}`) },
          },
        ],
      };
    }

    it("ends with exactly the fresh union, in the dropdown and in the resolvable values", async () => {
      const port = oven([programA, programB]);
      port.getResponses.set(`/api/homeappliances/HA-O/programs/available/${programA}`, levelDef(programA, ["Level01"]));
      port.getResponses.set(`/api/homeappliances/HA-O/programs/available/${programB}`, levelDef(programB, ["Level02"]));
      const sync = new ApplianceSync(port);
      await sync.primeFromObjects();
      await sync.syncAppliances();
      const obj = port.objects.get(id) as ioBroker.StateObject;
      expect(Object.keys(obj.common.states as Record<string, string>).sort()).toEqual(["level01", "level02"]);
      expect(obj.native.bshValues).toEqual([
        "Cooking.Oven.EnumType.Level.Level01",
        "Cooking.Oven.EnumType.Level.Level02",
      ]);
      expect(obj.native.defGeneration).toBe(4);
    });

    /**
     * The level option as a first pass over program A leaves it: rebuilt and stamped.
     *
     * @returns the stored option object
     */
    async function rebuiltByA(): Promise<ioBroker.Object> {
      const port = oven([programA]);
      port.getResponses.set(`/api/homeappliances/HA-O/programs/available/${programA}`, levelDef(programA, ["Level01"]));
      const sync = new ApplianceSync(port);
      await sync.primeFromObjects();
      await sync.syncAppliances();
      return structuredClone(port.objects.get(id) as ioBroker.Object);
    }

    /**
     * Put an option object in place of the stale one of {@link oven}.
     *
     * @param port the port of {@link oven}
     * @param obj the option object
     * @param cached the programs the definition cache holds at generation 4
     */
    function withOption(port: FakePort, obj: ioBroker.Object, cached: string[]): void {
      port.primeStates = { [`${NS}.${id}`]: obj };
      port.objects.set(id, structuredClone(obj));
      const device = port.primeDevices?.[`${NS}.ov-1`];
      const options = (device.native as { programOptions: Record<string, { v: number }> }).programOptions;
      for (const k of cached) {
        options[k] = { ...options[k], v: 4 };
      }
    }

    it("writes the stamp even when the rebuilt list equals the stored one", async () => {
      // The same list as a rebuild brings, but from before the stamp existed: without the stamp written now,
      // the next program's definition would rebuild once more and drop program A's level.
      const unstamped = await rebuiltByA();
      delete (unstamped.native as Record<string, unknown>).defGeneration;
      const port = oven([programA, programB]);
      withOption(port, unstamped, []);
      const pathB = `/api/homeappliances/HA-O/programs/available/${programB}`;
      port.getResponses.set(`/api/homeappliances/HA-O/programs/available/${programA}`, levelDef(programA, ["Level01"]));
      const sync = new ApplianceSync(port);
      await sync.primeFromObjects();
      await sync.syncAppliances();
      // A restart: the next instance knows only what the database holds.
      port.primeStates = { [`${NS}.${id}`]: structuredClone(port.objects.get(id) as ioBroker.Object) };
      port.primeDevices = { [`${NS}.ov-1`]: structuredClone(port.objects.get("ov-1") as ioBroker.Object) };
      port.getResponses.set(pathB, levelDef(programB, ["Level02"]));
      const next = new ApplianceSync(port);
      await next.primeFromObjects();
      await next.syncAppliances();
      expect((port.objects.get(id) as ioBroker.StateObject).native.bshValues).toEqual([
        "Cooking.Oven.EnumType.Level.Level01",
        "Cooking.Oven.EnumType.Level.Level02",
      ]);
    });

    it("keeps the stamp over a restart, so a new program adds to the list", async () => {
      const stamped = await rebuiltByA();
      const port = oven([programA, programB]);
      withOption(port, stamped, [programA]);
      port.getResponses.set(`/api/homeappliances/HA-O/programs/available/${programB}`, levelDef(programB, ["Level02"]));
      const sync = new ApplianceSync(port);
      await sync.primeFromObjects();
      await sync.syncAppliances();
      expect((port.objects.get(id) as ioBroker.StateObject).native.bshValues).toEqual([
        "Cooking.Oven.EnumType.Level.Level01",
        "Cooking.Oven.EnumType.Level.Level02",
      ]);
    });

    it("takes the fresh bounds of a numeric option, not the widened ones an older generation kept", async () => {
      const port = oven([programA]);
      const tempId = "ov-1.options.setpointTemperature";
      const tempKey = "Cooking.Oven.Option.SetpointTemperature";
      const stored = {
        _id: `${NS}.${tempId}`,
        type: "state",
        common: { name: "Temperature", type: "number", role: "level", read: true, write: true, min: 0, max: 500 },
        native: { bshKey: tempKey },
      } as unknown as ioBroker.Object;
      port.primeStates = { ...port.primeStates, [`${NS}.${tempId}`]: stored };
      port.objects.set(tempId, structuredClone(stored));
      port.getResponses.set(`/api/homeappliances/HA-O/programs/available/${programA}`, {
        key: programA,
        options: [
          ...(levelDef(programA, ["Level01"]).options as unknown[]),
          { key: tempKey, type: "Double", unit: "°C", constraints: { min: 30, max: 250 } },
        ],
      });
      const sync = new ApplianceSync(port);
      await sync.primeFromObjects();
      await sync.syncAppliances();
      expect(port.objects.get(tempId)?.common).toMatchObject({ min: 30, max: 250 });
    });

    it("keeps what an earlier pass rebuilt when a later pass loads the next program", async () => {
      const port = oven([programA, programB]);
      const pathA = `/api/homeappliances/HA-O/programs/available/${programA}`;
      const pathB = `/api/homeappliances/HA-O/programs/available/${programB}`;
      port.getResponses.set(pathA, levelDef(programA, ["Level01"]));
      // Program B cannot be read in the first pass.
      const sync = new ApplianceSync(port);
      await sync.primeFromObjects();
      await sync.syncAppliances();
      expect((port.objects.get(id) as ioBroker.StateObject).native.bshValues).toEqual([
        "Cooking.Oven.EnumType.Level.Level01",
      ]);
      port.getResponses.set(pathB, levelDef(programB, ["Level02"]));
      await sync.syncAppliances();
      const obj = port.objects.get(id) as ioBroker.StateObject;
      expect(obj.native.bshValues).toEqual([
        "Cooking.Oven.EnumType.Level.Level01",
        "Cooking.Oven.EnumType.Level.Level02",
      ]);
      expect(Object.keys(obj.common.states as Record<string, string>).sort()).toEqual(["level01", "level02"]);
      expect(port.getCalls.filter(c => c === pathA)).toHaveLength(1);
    });
  });
});

describe("encoded program records (2026-09-28)", () => {
  it("removes the raw datapoints an older version created for the encoded records", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.wt`]: {
        _id: `${NS}.wt`,
        type: "device",
        common: { name: "Waschtrockner" },
        native: { haId: "HA-W", type: "WasherDryer", enumber: "wt" },
      } as unknown as ioBroker.Object,
    };
    const raw = (id: string, bshKey: string): ioBroker.Object =>
      ({
        _id: `${NS}.wt.status.${id}`,
        type: "state",
        common: { name: id, type: "string", role: "text", read: true, write: false },
        native: { bshKey },
      }) as unknown as ioBroker.Object;
    port.primeStates = {
      [`${NS}.wt.status.programHistoryUid`]: raw("programHistoryUid", "LaundryCare.Common.Status.Program.History.Uid"),
      [`${NS}.wt.status.programDetailsProgram02`]: raw(
        "programDetailsProgram02",
        "LaundryCare.Common.Status.Program.Details.Program02",
      ),
      [`${NS}.wt.status.programSessionSummaryLatest`]: raw(
        "programSessionSummaryLatest",
        "BSH.Common.Status.ProgramSessionSummary.Latest",
      ),
      [`${NS}.wt.status.errorCodesList`]: raw("errorCodesList", "BSH.Common.Status.ErrorCodesList"),
    };
    const sync = new ApplianceSync(port);
    await sync.migrateRenamedStates();
    expect(port.deleted).toEqual(
      expect.arrayContaining([
        "wt.status.programHistoryUid",
        "wt.status.programDetailsProgram02",
        "wt.status.programSessionSummaryLatest",
        "wt.status.errorCodesList",
      ]),
    );
  });
});

describe("decoded program records (decision 40)", () => {
  const base = "/api/homeappliances/HA-1";
  const wd = (v: string): string => `LaundryCare.WasherDryer.Program.${v}`;
  // Real values of krobi's washer-dryer (2026-09-27); the last run: spin, 31670.
  const SUMMARY =
    '{"counter":359,"end":"2026-09-27T14:47:59.859Z","sequence":[{"configuration":{"options":[],"program":31670},"details":[{"uid":623,"value":35900},{"uid":626,"value":1},{"uid":628,"value":40},{"uid":8198,"value":21}]}],"start":"2026-09-27T14:35:55.271Z"}';
  const status = (): unknown[] => [
    { key: "LaundryCare.Common.Status.Program.History.Uid", value: "ewN7B3u2e7Y" },
    { key: "LaundryCare.Common.Status.Program.History.EffectiveTime", value: "AL0A-QAMAAw" },
    { key: "LaundryCare.Common.Status.Program.Details.Program08", value: "D3u2AAYABgAAEkg" },
    { key: "LaundryCare.Common.Status.Program.Details.Program02", value: "D3sHAF0AXwANqOA" },
    // 31673: in none of the appliance descriptions researched — stays a number until learned.
    { key: "LaundryCare.Common.Status.Program.Details.Program20", value: "D3u5AAEAAQAAFGQ" },
    { key: "BSH.Common.Status.ProgramSessionSummary.Latest", value: SUMMARY },
    { key: "BSH.Common.Status.ErrorCodesList", value: "[]" },
  ];

  it("turns the encoded records into readable datapoints and never shows the raw ones", async () => {
    const port = new FakePort();
    port.language = "de";
    // Wool is offered but not in the history: the program list the pass reads AFTER the status
    // adds it to the history's selection list — drawn before that, the history is written twice.
    appliance(port, "HA-1", "Wt", {
      type: "WasherDryer",
      status: status(),
      available: [wd("Cotton"), wd("Wool")],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    // Drawn once, after the program list of the pass is complete — not once before it and again after.
    expect(port.extendCalls.filter(id => id === "wt-1.history.program1")).toHaveLength(1);
    expect(port.extendCalls.filter(id => id === "wt-1.lastRun.program")).toHaveLength(1);
    // Numbers the appliances' own descriptions name are programs right away: 31670 is
    // spin, 31495 cotton — and cotton takes the cloud's key the program list carries.
    expect(port.states.get("wt-1.history.program1")).toBe("spin");
    const h1 = port.objects.get("wt-1.history.program1")?.common as ioBroker.StateCommon;
    expect(h1.states).toMatchObject({ spin: "Schleudern", cotton: "Baumwolle" });
    expect(h1.name).toEqual(tName("histProgram1"));
    expect(port.states.get("wt-1.history.program3")).toBe("cotton");
    expect(port.states.get("wt-1.history.duration1")).toBe(12);
    expect(port.states.get("wt-1.history.duration3")).toBe(249);
    expect(port.states.get("wt-1.statistics.cotton.completed")).toBe(93);
    expect(port.states.get("wt-1.statistics.cotton.started")).toBe(95);
    expect(port.states.get("wt-1.statistics.cotton.runtime")).toBe(248.7);
    expect(port.states.get("wt-1.statistics.spin.completed")).toBe(6);
    // A number no description names stays a number, readably labelled.
    expect(port.states.get("wt-1.statistics.program31673.completed")).toBe(1);
    expect(port.objects.get("wt-1.statistics.program31673")?.common?.name).toEqual(tName("unknownProgram", 31673));
    expect(port.objects.get("wt-1.statistics")?.type).toBe("folder");
    expect(port.states.get("wt-1.lastRun.start")).toBe(Date.parse("2026-09-27T14:35:55.271Z"));
    expect(port.states.get("wt-1.lastRun.duration")).toBe(12);
    // The run's own figures — water in litres, not the millilitres the appliance counts.
    expect(port.states.get("wt-1.lastRun.water")).toBe(35.9);
    expect(port.states.get("wt-1.lastRun.energy")).toBe(40);
    expect(port.states.get("wt-1.lastRun.detergent")).toBe(21);
    expect(port.objects.has("wt-1.lastRun.softener")).toBe(false);
    expect(port.states.get("wt-1.lastRun.endTrigger")).toBe("programabortedbyuser");
    const trigger = port.objects.get("wt-1.lastRun.endTrigger")?.common as ioBroker.StateCommon;
    expect(trigger.states).toMatchObject({ programfinished: "Programm beendet" });
    expect(port.states.get("wt-1.status.errorCodes")).toBe("");
    // The adapter's own name in every language, never an English label derived from the id.
    expect(port.objects.get("wt-1.status.errorCodes")?.common?.name).toEqual(tName("stErrorCodes"));
    expect(port.states.get("wt-1.status.faultActive")).toBe(false);
    for (const raw of [
      "programHistoryUid",
      "programHistoryEffectiveTime",
      "programSessionSummaryLatest",
      "errorCodesList",
    ]) {
      expect(port.objects.has(`wt-1.status.${raw}`)).toBe(false);
    }
    expect([...port.objects.keys()].some(id => id.includes("programDetails"))).toBe(false);
    // A decoded datapoint carries no BSH key: the start-up repairs must not take it for a mapped one.
    expect((port.objects.get("wt-1.history.program1")?.native as { bshKey?: string }).bshKey).toBeUndefined();

    // A second pass with the same records writes no object at all.
    port.extendCalls.length = 0;
    await sync.syncAppliances();
    expect(port.extendCalls.filter(id => /\.(history|statistics|lastRun)\b|errorCodes/.test(id))).toEqual([]);
  });

  it("keeps a learned program number over a restart", async () => {
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.wt-1`]: {
        _id: `${NS}.wt-1`,
        type: "device",
        common: { name: "Wt" },
        native: {
          haId: "HA-1",
          type: "WasherDryer",
          enumber: "Wt",
          idScheme: 3,
          programUids: { 31673: wd("SportShoes.SportShoes.SportShoes") },
        },
      } as unknown as ioBroker.Object,
    };
    appliance(port, "HA-1", "Wt", { type: "WasherDryer", status: [], available: [wd("Cotton")] });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();
    sync.handleStreamEvent({
      event: "STATUS",
      id: "HA-1",
      data: JSON.stringify({
        items: [{ key: "LaundryCare.Common.Status.Program.Details.Program20", value: "D3u5AAEAAQAAFGQ" }],
      }),
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(port.objects.has("wt-1.statistics.sportshoes.completed")).toBe(true);
    expect(port.objects.has("wt-1.statistics.program31673.completed")).toBe(false);
  });

  it("learns a program number from the run it saw, and moves its statistics with the recording", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-09-27T14:36:10Z"));
      const port = new FakePort();
      appliance(port, "HA-1", "Wt", { type: "WasherDryer", status: [], available: [wd("Cotton")] });
      const sync = new ApplianceSync(port);
      await sync.syncAppliances();
      // Numbers first, while nothing is learned; the user records one of them.
      sync.handleStreamEvent({
        event: "STATUS",
        id: "HA-1",
        data: JSON.stringify({
          items: [{ key: "LaundryCare.Common.Status.Program.Details.Program20", value: "D3u5AAEAAQAAFGQ" }],
        }),
      });
      await vi.advanceTimersByTimeAsync(10);
      await port.extendObject("wt-1.statistics.program31673.completed", {
        common: { custom: { "influxdb.0": { enabled: true } } },
      });
      // The sports-shoes program runs (seen at 14:36:10, inside the run) …
      sync.handleStreamEvent({
        event: "NOTIFY",
        id: "HA-1",
        data: JSON.stringify({
          items: [{ key: "BSH.Common.Root.ActiveProgram", value: wd("SportShoes.SportShoes.SportShoes") }],
        }),
      });
      await vi.advanceTimersByTimeAsync(10);
      // … and ends: the summary names number 31673.
      vi.setSystemTime(Date.parse("2026-09-27T14:48:10Z"));
      sync.handleStreamEvent({
        event: "STATUS",
        id: "HA-1",
        data: JSON.stringify({
          items: [
            {
              key: "BSH.Common.Status.ProgramSessionSummary.Latest",
              value: SUMMARY.replace('"program":31670', '"program":31673'),
            },
          ],
        }),
      });
      await vi.advanceTimersByTimeAsync(50);
      expect((port.objects.get("wt-1")?.native as { programUids?: object }).programUids).toEqual({
        31673: wd("SportShoes.SportShoes.SportShoes"),
      });
      expect(port.states.get("wt-1.lastRun.program")).toBe("sportshoes");
      expect(port.objects.has("wt-1.statistics.program31673.completed")).toBe(false);
      const moved = port.objects.get("wt-1.statistics.sportshoes.completed")?.common as ioBroker.StateCommon;
      expect(moved.custom).toMatchObject({ "influxdb.0": { enabled: true } });
      expect(port.states.get("wt-1.statistics.sportshoes.completed")).toBe(1);
      expect(port.objects.get("wt-1.statistics.sportshoes")?.common?.name).toMatchObject({
        en: "Sports shoes",
        de: "Sportschuhe",
      });
      // Every program has the same three counters — the name says which program.
      expect(moved.name).toMatchObject({
        en: "Sports shoes · Runs completed",
        de: "Sportschuhe · Abgeschlossene Läufe",
      });
      // A number keeps the program it was learned with: a later run of another
      // program under the same number teaches nothing (seen INSIDE that run's window).
      vi.setSystemTime(Date.parse("2026-09-27T15:35:00Z"));
      sync.handleStreamEvent({
        event: "NOTIFY",
        id: "HA-1",
        data: JSON.stringify({ items: [{ key: "BSH.Common.Root.ActiveProgram", value: wd("Wool") }] }),
      });
      await vi.advanceTimersByTimeAsync(10);
      vi.setSystemTime(Date.parse("2026-09-27T16:00:00Z"));
      sync.handleStreamEvent({
        event: "STATUS",
        id: "HA-1",
        data: JSON.stringify({
          items: [
            {
              key: "BSH.Common.Status.ProgramSessionSummary.Latest",
              value: SUMMARY.replace('"program":31670', '"program":31673')
                .replace("2026-09-27T14:35:55.271Z", "2026-09-27T15:30:00Z")
                .replace("2026-09-27T14:47:59.859Z", "2026-09-27T16:10:00Z"),
            },
          ],
        }),
      });
      await vi.advanceTimersByTimeAsync(50);
      expect((port.objects.get("wt-1")?.native as { programUids?: object }).programUids).toEqual({
        31673: wd("SportShoes.SportShoes.SportShoes"),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("moves statistics named from the descriptions when the appliance reports the program by another key", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.parse("2026-09-27T14:36:10Z"));
      const port = new FakePort();
      appliance(port, "HA-1", "Wt", { type: "WasherDryer", status: [], available: [wd("Cotton")] });
      const sync = new ApplianceSync(port);
      await sync.syncAppliances();
      // 31617 is "…HygieneDryLaundry.FastHygiene.FastHygiene" in the descriptions.
      sync.handleStreamEvent({
        event: "STATUS",
        id: "HA-1",
        data: JSON.stringify({
          items: [{ key: "LaundryCare.Common.Status.Program.Details.Program05", value: "D3uBAAIAAwAADhA" }],
        }),
      });
      await vi.advanceTimersByTimeAsync(10);
      expect(port.states.get("wt-1.statistics.fasthygiene.completed")).toBe(2);
      // The appliance runs it as "…HygienePlus": that is the program the number stands for here.
      sync.handleStreamEvent({
        event: "NOTIFY",
        id: "HA-1",
        data: JSON.stringify({ items: [{ key: "BSH.Common.Root.ActiveProgram", value: wd("HygienePlus") }] }),
      });
      await vi.advanceTimersByTimeAsync(10);
      vi.setSystemTime(Date.parse("2026-09-27T14:48:10Z"));
      sync.handleStreamEvent({
        event: "STATUS",
        id: "HA-1",
        data: JSON.stringify({
          items: [
            {
              key: "BSH.Common.Status.ProgramSessionSummary.Latest",
              value: SUMMARY.replace('"program":31670', '"program":31617'),
            },
          ],
        }),
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(port.objects.has("wt-1.statistics.fasthygiene.completed")).toBe(false);
      expect(port.states.get("wt-1.statistics.hygieneplus.completed")).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("learns nothing from a summary read again while another program runs", async () => {
    vi.useFakeTimers();
    try {
      // A reconnect an hour after the spin run: cotton runs now, the summary is the old one.
      vi.setSystemTime(Date.parse("2026-09-27T15:50:00Z"));
      const port = new FakePort();
      appliance(port, "HA-1", "Wt", { type: "WasherDryer", status: [], available: [wd("Cotton")] });
      port.getResponses.set(`${base}/programs/active`, { key: wd("Cotton") });
      port.getResponses.set(`${base}/status`, {
        status: [{ key: "BSH.Common.Status.ProgramSessionSummary.Latest", value: SUMMARY }],
      });
      const sync = new ApplianceSync(port);
      await sync.syncAppliances();
      // The second pass reads the summary again while cotton — seen running since
      // 15:50, long after that run ended — is still the running program.
      await sync.syncAppliances();
      expect((port.objects.get("wt-1")?.native as { programUids?: object }).programUids).toBeUndefined();
      // (31670 is spin by the appliances' descriptions — named, but nothing LEARNED.)
      expect(port.states.get("wt-1.lastRun.program")).toBe("spin");
    } finally {
      vi.useRealTimers();
    }
  });

  it("names the program of a favourite slot instead of showing its raw record", async () => {
    const port = new FakePort();
    port.language = "de";
    appliance(port, "HA-1", "Spueler", {
      type: "Dishwasher",
      status: [],
      settings: [
        {
          key: "BSH.Common.Setting.Favorite.001.Program",
          value: '{"length":1,"list":[{"program":8200,"options":[{"uid":5136,"value":false}]}]}',
        },
      ],
      available: ["Dishcare.Dishwasher.Program.Eco50"],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    // 8200 is pre-rinse by the dishwashers' own descriptions.
    expect(port.states.get("spueler-1.settings.favorite001Program")).toBe("prerinse");
    const fav = port.objects.get("spueler-1.settings.favorite001Program")?.common as ioBroker.StateCommon;
    expect(fav.states).toMatchObject({ prerinse: "Vorspülen" });
    expect(fav.write).toBe(false);
  });

  it("keeps a program's statistics under one id whether the program list is known before or after", async () => {
    // On an upgrade the program list stands in the database before the status is
    // read; two programs ending in "Cotton" then make the list's short value two
    // segments — the statistics id must not follow it.
    const port = new FakePort();
    port.primeDevices = {
      [`${NS}.wt-1`]: {
        _id: `${NS}.wt-1`,
        type: "device",
        common: { name: "Wt" },
        native: { haId: "HA-1", type: "WasherDryer", enumber: "Wt", idScheme: 3 },
      } as unknown as ioBroker.Object,
    };
    port.primeStates = {
      [`${NS}.wt-1.programs.selectedProgram`]: {
        _id: `${NS}.wt-1.programs.selectedProgram`,
        type: "state",
        common: { name: "Program", type: "string", role: "text", read: true, write: true, states: {} },
        native: {
          bshKey: "BSH.Common.Root.SelectedProgram",
          bshValues: [wd("Cotton"), wd("Cotton.Cotton.Cotton")],
        },
      } as unknown as ioBroker.Object,
    };
    appliance(port, "HA-1", "Wt", {
      type: "WasherDryer",
      status: [{ key: "LaundryCare.Common.Status.Program.Details.Program02", value: "D3sHAF0AXwANqOA" }],
      available: [wd("Cotton"), wd("Cotton.Cotton.Cotton")],
    });
    const sync = new ApplianceSync(port);
    await sync.primeFromObjects();
    await sync.syncAppliances();
    expect(port.states.get("wt-1.statistics.cotton.completed")).toBe(93);
    expect([...port.objects.keys()].filter(id => id.startsWith("wt-1.statistics.") && !id.includes(".cotton"))).toEqual(
      [],
    );
  });

  it("shows nothing for a record of a shape it cannot read, and says so once", async () => {
    const port = new FakePort();
    appliance(port, "HA-1", "Wt", {
      type: "WasherDryer",
      status: [
        { key: "BSH.Common.Status.ProgramSessionSummary.Latest", value: "ewN7e3sDewc" },
        { key: "LaundryCare.Common.Status.Program.Details.Program03", value: "AEQAGABFAAA" },
        { key: "LaundryCare.Common.Status.Program.Details.Program04", value: "AEQAGABFAAA" },
      ],
    });
    const sync = new ApplianceSync(port);
    await sync.syncAppliances();
    await sync.syncAppliances();
    expect([...port.objects.keys()].filter(id => /lastRun|statistics|programDetails|SessionSummary/.test(id))).toEqual(
      [],
    );
    const lines = port.logs.filter(l => l.startsWith("info: ") && l.includes("cannot read yet"));
    expect(lines).toHaveLength(2);
  });
});

describe("object writes per start (every fixture appliance type)", () => {
  // The fleet measured at most three writes per object and start (tooling round 60):
  // create, and at most two metadata refreshes while the pass learns lists. This
  // replays each inventory fixture the way the fixture server answers it.
  const DIR = join(__dirname, "../../test/fixtures/inventory");
  const MAX_OBJECT_WRITES = 3;
  for (const file of readdirSync(DIR).filter(f => f.endsWith(".json"))) {
    const type = file.replace(/\.json$/, "");
    it(`writes no object of a ${type} more than ${MAX_OBJECT_WRITES} times`, async () => {
      const fixture = JSON.parse(readFileSync(join(DIR, file), "utf8")) as {
        status: Array<Record<string, unknown>>;
        settings: Array<Record<string, unknown>>;
        programs: string[];
        programOptions: unknown[];
        commands: unknown[];
      };
      const port = new FakePort();
      port.language = "de";
      const base = "/api/homeappliances/HA-1";
      appliance(port, "HA-1", type, {
        type,
        status: fixture.status,
        settings: fixture.settings.map(({ constraints: _drop, ...rest }) => rest),
        available: fixture.programs,
        commands: fixture.commands,
      });
      for (const setting of fixture.settings) {
        port.getResponses.set(`${base}/settings/${String(setting.key)}`, setting);
      }
      for (const program of fixture.programs) {
        port.getResponses.set(`${base}/programs/available/${program}`, {
          key: program,
          options: fixture.programOptions,
        });
      }
      if (fixture.programs.length > 0) {
        port.getResponses.set(`${base}/programs/selected`, { key: fixture.programs[0], options: [] });
      }
      port.getResponses.set(`${base}/programs/active`, null);
      const sync = new ApplianceSync(port);
      await sync.syncAppliances();
      const counts = new Map<string, number>();
      for (const id of port.extendCalls) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const over = [...counts].filter(([, n]) => n > MAX_OBJECT_WRITES).map(([id, n]) => `${id}: ${n}`);
      expect(over).toEqual([]);
    });
  }
});
