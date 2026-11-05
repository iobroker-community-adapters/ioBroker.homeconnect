// Core decision H-02 (accepted 2026-10-15, changed 2026-11-05): BSH reports on/off as On with Standby, Off or MainsOff —
// the adapter makes it a switch (true/false) like Home Assistant home_connect; switching off sends the off value Home
// Connect names for the appliance type (Standby for oven, air conditioner, warming drawer, coffee machine, cleaning robot
// and cook processor, Off for dishwasher, cooktop and hood), for the microwave, which Home Connect lists under both, the
// off value the appliance last reported, and without a reported value and for every other type Off where the appliance
// offers it, else Standby.
// krobi 2026-09-29 19:30: "why is powerstate a text string? … and not a boolean??!?!?!?!"
// krobi 2026-11-05 19:11: "Yes" to "Should homeconnect send, when switching off, the off value Home Connect names for the
// appliance type, as in the table?"
import { describe, expect, it, vi } from "vitest";
import { transformItem } from "../lib/value-transformer";
import { ApplianceSync, type AdapterPort } from "../lib/appliance-sync";
import type { WriteRequest } from "../lib/command-dispatch";
import type { JsonResult } from "../lib/http";

// adapter-core's I18n needs a running adapter; a name is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

/** What main hands ApplianceSync, held in memory — this guard's own copy (a guard imports no test code). */
class MemoryPort implements AdapterPort {
  readonly namespace = "homeconnect.0";
  readonly language = "en";
  readonly logs: string[] = [];
  readonly log = {
    silly: (m: string) => this.logs.push(`silly: ${m}`),
    debug: (m: string) => this.logs.push(`debug: ${m}`),
    info: (m: string) => this.logs.push(`info: ${m}`),
    warn: (m: string) => this.logs.push(`warn: ${m}`),
    error: (m: string) => this.logs.push(`error: ${m}`),
  } as unknown as ioBroker.Logger;
  readonly objects = new Map<string, ioBroker.Object>();
  readonly states = new Map<string, { val: ioBroker.StateValue; ack: boolean }>();
  readonly foreign = new Map<string, ioBroker.Object>();
  readonly answers = new Map<string, unknown>();
  readonly notReady = new Set<string>();
  readonly timers: Array<{ cb: () => void; ms: number; live: boolean }> = [];
  readonly deleted: string[] = [];
  readonly carries: Array<ReadonlyMap<string, readonly string[]>> = [];
  readonly writes: WriteRequest[] = [];
  sync: ApplianceSync | undefined;

  private rel(id: string): string | undefined {
    return id.startsWith(`${this.namespace}.`) ? id.slice(this.namespace.length + 1) : undefined;
  }
  extendObject(id: string, obj: ioBroker.PartialObject): Promise<unknown> {
    const old = this.objects.get(id) as Record<string, unknown> | undefined;
    const patch = structuredClone(obj) as Record<string, unknown>;
    this.objects.set(id, {
      ...old,
      ...patch,
      common: { ...(old?.common as object), ...(patch.common as object) },
      native: { ...(old?.native as object), ...(patch.native as object) },
    } as unknown as ioBroker.Object);
    return Promise.resolve();
  }
  setState(id: string, state: ioBroker.SettableState): Promise<unknown> {
    this.states.set(id, { val: state.val ?? null, ack: state.ack === true });
    return Promise.resolve();
  }
  setStateChanged(id: string, state: ioBroker.SettableState): Promise<unknown> {
    const held = this.states.get(id);
    if (held && held.val === state.val && held.ack === (state.ack === true)) {
      return Promise.resolve();
    }
    return this.setState(id, state);
  }
  getState(id: string): Promise<ioBroker.State | null | undefined> {
    const held = this.states.get(id);
    return Promise.resolve(held ? ({ ...held } as ioBroker.State) : null);
  }
  getObject(id: string): Promise<ioBroker.Object | null | undefined> {
    const obj = this.objects.get(id);
    return Promise.resolve(obj ? structuredClone(obj) : null);
  }
  delObject(id: string): Promise<void> {
    this.deleted.push(id);
    this.objects.delete(id);
    this.states.delete(id);
    return Promise.resolve();
  }
  delState(id: string): Promise<void> {
    this.states.delete(id);
    return Promise.resolve();
  }
  delObjectRecursive(id: string): Promise<void> {
    this.deleted.push(id);
    for (const map of [this.objects, this.states] as Array<Map<string, unknown>>) {
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
      Object.fromEntries(
        [...this.objects]
          .filter(([, obj]) => obj.type === type)
          .map(([id, obj]) => [`${this.namespace}.${id}`, structuredClone(obj)]),
      ),
    );
  }
  getAdapterObjects(): Promise<Record<string, ioBroker.Object | null | undefined>> {
    return Promise.resolve(
      Object.fromEntries([...this.objects].map(([id, obj]) => [`${this.namespace}.${id}`, structuredClone(obj)])),
    );
  }
  getForeignStates(pattern: string): Promise<Record<string, ioBroker.State | null | undefined>> {
    const prefix = pattern.replace(/\*$/, "");
    return Promise.resolve(
      Object.fromEntries(
        [...this.states]
          .filter(([id]) => `${this.namespace}.${id}`.startsWith(prefix))
          .map(([id, s]) => [`${this.namespace}.${id}`, { ...s } as ioBroker.State]),
      ),
    );
  }
  setForeignObject(id: string, obj: ioBroker.SettableObject): Promise<unknown> {
    const rel = this.rel(id);
    if (rel === undefined) {
      this.foreign.set(id, structuredClone(obj) as ioBroker.Object);
    } else {
      this.objects.set(rel, structuredClone(obj) as ioBroker.Object);
    }
    return Promise.resolve();
  }
  extendForeignObject(id: string, patch: ioBroker.PartialObject): Promise<unknown> {
    const rel = this.rel(id);
    if (rel !== undefined) {
      return this.extendObject(rel, patch);
    }
    const old = this.foreign.get(id) as Record<string, unknown> | undefined;
    this.foreign.set(id, { ...old, ...(structuredClone(patch) as object) } as unknown as ioBroker.Object);
    return Promise.resolve();
  }
  setForeignState(id: string, state: ioBroker.SettableState): Promise<unknown> {
    const rel = this.rel(id);
    return rel === undefined ? Promise.resolve() : this.setState(rel, state);
  }
  getAliases(): Promise<Record<string, ioBroker.Object | null | undefined>> {
    return Promise.resolve(
      Object.fromEntries(
        [...this.foreign].filter(([id]) => id.startsWith("alias.")).map(([id, o]) => [id, structuredClone(o)]),
      ),
    );
  }
  getEnums(): Promise<Record<string, unknown>> {
    return Promise.resolve(
      Object.fromEntries(
        [...this.foreign].filter(([id]) => id.startsWith("enum.")).map(([id, o]) => [id, structuredClone(o)]),
      ),
    );
  }
  async deleteTreeCarryingEnums(root: string, carry: ReadonlyMap<string, readonly string[]>): Promise<number> {
    this.carries.push(carry);
    await this.delObjectRecursive(root);
    let carried = 0;
    for (const [id, obj] of this.foreign) {
      const members = (obj.common as { members?: string[] }).members;
      if (!id.startsWith("enum.") || !Array.isArray(members)) {
        continue;
      }
      (obj.common as { members?: string[] }).members = members.flatMap(m => {
        const to = carry.get(m);
        carried += to?.length ?? 0;
        return to ? [...to] : m.startsWith(`${this.namespace}.${root}.`) ? [] : [m];
      });
    }
    return carried;
  }
  apiGet(path: string): Promise<unknown> {
    if (this.notReady.has(path)) {
      this.sync?.noteNotReady(path);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(structuredClone(this.answers.get(path)));
  }
  errorBudgetLeft(): boolean {
    return true;
  }
  apiWrite(req: WriteRequest): Promise<JsonResult | undefined> {
    this.writes.push(req);
    return Promise.resolve({ status: 204, ok: true, data: null } as unknown as JsonResult);
  }
  setTimer(cb: () => void, ms: number): unknown {
    const timer = { cb, ms, live: true };
    this.timers.push(timer);
    return timer;
  }
  clearTimer(handle: unknown): void {
    (handle as { live: boolean }).live = false;
  }

  /**
   * An appliance of the account, answering the reads the sync makes.
   *
   * @param haId its Home Connect id
   * @param name its name, also its model (the device id is `<name>-<last part of the haId>`)
   * @param type its appliance type
   * @param connected whether it is online
   * @param status what its status read answers
   */
  appliance(haId: string, name: string, type: string, connected: boolean, status: unknown[] = []): void {
    const list = (this.answers.get("/api/homeappliances") as { homeappliances: unknown[] } | undefined)?.homeappliances;
    this.answers.set("/api/homeappliances", {
      homeappliances: [...(list ?? []), { haId, name, type, enumber: name, connected }],
    });
    const base = `/api/homeappliances/${haId}`;
    this.answers.set(`${base}/status`, { status });
    this.answers.set(`${base}/settings`, { settings: [] });
    this.answers.set(`${base}/commands`, { commands: [] });
    this.answers.set(`${base}/programs/available`, { programs: [] });
  }
}

/** Let the fire-and-forget chains of the sync land. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

const POWER = "BSH.Common.Setting.PowerState";
const value = (v: string): string => `BSH.Common.EnumType.PowerState.${v}`;

type Appliance = { port: MemoryPort; sync: ApplianceSync; power: string };

/**
 * An appliance of one type, read once.
 *
 * @param type its appliance type
 * @param offered the power values it offers (tails)
 * @param reported the power value it reports (tail)
 * @returns the port, the sync and the full id of its power switch
 */
async function oneAppliance(type: string, offered: string[], reported: string): Promise<Appliance> {
  const port = new MemoryPort();
  const sync = new ApplianceSync(port);
  port.sync = sync;
  port.appliance("HA-1", type, type, true);
  const base = "/api/homeappliances/HA-1";
  port.answers.set(`${base}/settings`, { settings: [{ key: POWER, value: value(reported) }] });
  port.answers.set(`${base}/settings/${POWER}`, {
    key: POWER,
    value: value(reported),
    type: "BSH.Common.EnumType.PowerState",
    constraints: { allowedvalues: offered.map(value), access: "readWrite" },
  });
  await sync.syncAppliances();
  await settle();
  const power = [...port.objects.keys()].find(id => id.endsWith(".settings.powerState"));
  expect(power, type).toBeDefined();
  return { port, sync, power: `${port.namespace}.${power}` };
}

/**
 * What a switch write of the power sends.
 *
 * @param appliance the appliance to switch
 * @param on the written switch state
 * @returns the body of the request that went out
 */
async function sends(appliance: Appliance, on: boolean): Promise<unknown> {
  await appliance.sync.handleWrite(appliance.power, on);
  return appliance.port.writes.at(-1)?.body;
}

const ALL = ["MainsOff", "Off", "On", "Standby"];

describe("H-02 On with Off, Standby or MainsOff is a switch; switching off follows Home Connect's table", () => {
  it("S1 shows the power state as a boolean switch", () => {
    const on = transformItem({
      key: POWER,
      value: value("On"),
      constraints: { allowedvalues: [value("On"), value("Standby")] },
    });
    expect(on.common).toMatchObject({ type: "boolean", role: "switch.power", write: true });
    expect(on.value).toBe(true);
    expect(transformItem({ key: POWER, value: value("Standby") }).value).toBe(false);
    expect(transformItem({ key: POWER, value: value("Off") }).value).toBe(false);
    expect(transformItem({ key: POWER, value: value("MainsOff") }).value).toBe(false);
  });

  it("S2 switches off with the off value Home Connect names for the appliance type", async () => {
    const table: Array<[string, string]> = [
      ["Oven", "Standby"],
      ["AirConditioner", "Standby"],
      ["WarmingDrawer", "Standby"],
      ["CoffeeMaker", "Standby"],
      ["CleaningRobot", "Standby"],
      ["CookProcessor", "Standby"],
      ["Dishwasher", "Off"],
      ["Hob", "Off"],
      ["Hood", "Off"],
    ];
    for (const [type, off] of table) {
      // The appliance reports the other off value: the table decides, not the report.
      const reported = off === "Standby" ? "Off" : "Standby";
      const appliance = await oneAppliance(type, ALL, reported);
      expect(await sends(appliance, false), type).toEqual({ key: POWER, value: value(off) });
    }
  });

  it("S3 switches the microwave off with the off value it last reported", async () => {
    const offered = ["Off", "On", "Standby"];
    expect(await sends(await oneAppliance("Microwave", offered, "Standby"), false)).toEqual({
      key: POWER,
      value: value("Standby"),
    });
    expect(await sends(await oneAppliance("Microwave", offered, "Off"), false)).toEqual({
      key: POWER,
      value: value("Off"),
    });
    // The last report counts, not the first: Standby read at the start, Off reported on the stream afterwards.
    const microwave = await oneAppliance("Microwave", offered, "Standby");
    microwave.sync.handleStreamEvent({
      event: "NOTIFY",
      id: "HA-1",
      data: JSON.stringify({ haId: "HA-1", items: [{ key: POWER, value: value("Off") }] }),
    });
    await settle();
    expect(await sends(microwave, false)).toEqual({ key: POWER, value: value("Off") });
  });

  it("S4 switches off with Off where the appliance offers it, else Standby, without a report and for every other type", async () => {
    expect(await sends(await oneAppliance("Microwave", ["Off", "On", "Standby"], "On"), false)).toEqual({
      key: POWER,
      value: value("Off"),
    });
    expect(await sends(await oneAppliance("Washer", ["Off", "On"], "Off"), false)).toEqual({
      key: POWER,
      value: value("Off"),
    });
    expect(await sends(await oneAppliance("Washer", ["On", "Standby"], "Standby"), false)).toEqual({
      key: POWER,
      value: value("Standby"),
    });
    expect(await sends(await oneAppliance("Oven", ALL, "Standby"), true)).toEqual({ key: POWER, value: value("On") });
  });
});
