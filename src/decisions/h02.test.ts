// Core decision H-02 (accepted 2026-10-15, rule renewed 2026-11-05 14:02, krobi: "Ja, abgenommen"): BSH reports on/off
// as On with Standby, Off or MainsOff — the adapter makes it a switch (true/false) like Home Assistant home_connect.
// Switching off sends the off value the appliance last reported itself; before it has reported one, the off value among
// those it offers that Home Connect's PowerState table lists for its appliance type (oven: Standby), Off before Standby
// where the table lists both or neither. krobi 2026-09-29 19:30: "why is powerstate a text string? … and not a
// boolean??!?!?!?!" — and the oven of forum 85641 refused Off (NotAvailableByList) while it offered Off.
import { describe, expect, it, vi } from "vitest";
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

const POWER = "BSH.Common.Setting.PowerState";
const power = (v: string): string => `BSH.Common.EnumType.PowerState.${v}`;

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
  readonly writes: WriteRequest[] = [];

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
    this.objects.delete(id);
    this.states.delete(id);
    return Promise.resolve();
  }
  delState(id: string): Promise<void> {
    this.states.delete(id);
    return Promise.resolve();
  }
  delObjectRecursive(id: string): Promise<void> {
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
    return Promise.resolve({});
  }
  getEnums(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }
  async deleteTreeCarryingEnums(root: string): Promise<number> {
    await this.delObjectRecursive(root);
    return 0;
  }
  apiGet(path: string): Promise<unknown> {
    return Promise.resolve(structuredClone(this.answers.get(path)));
  }
  errorBudgetLeft(): boolean {
    return true;
  }
  apiWrite(req: WriteRequest): Promise<JsonResult | undefined> {
    this.writes.push(structuredClone(req));
    return Promise.resolve({ status: 204, ok: true, data: null } as unknown as JsonResult);
  }
  setTimer(cb: () => void, ms: number): unknown {
    return { cb, ms };
  }
  clearTimer(): void {}

  /**
   * An appliance of the account whose settings carry the power state, switched on.
   *
   * @param haId its Home Connect id
   * @param name its name, also its model (the device id is `<name>-<last part of the haId>`)
   * @param type its appliance type
   * @param offered the power state values it offers (short names)
   */
  appliance(haId: string, name: string, type: string, offered: string[]): void {
    this.answers.set("/api/homeappliances", {
      homeappliances: [{ haId, name, type, enumber: name, connected: true }],
    });
    const base = `/api/homeappliances/${haId}`;
    this.answers.set(`${base}/status`, { status: [] });
    this.answers.set(`${base}/settings`, { settings: [{ key: POWER, value: power("On") }] });
    this.answers.set(`${base}/settings/${POWER}`, {
      key: POWER,
      value: power("On"),
      type: "BSH.Common.EnumType.PowerState",
      constraints: { allowedvalues: offered.map(power), access: "readWrite" },
    });
    this.answers.set(`${base}/commands`, { commands: [] });
    this.answers.set(`${base}/programs/available`, { programs: [] });
  }
}

/** Let the fire-and-forget chains of the sync land. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

/**
 * One appliance, read once; returns what the guard drives it with.
 *
 * @param type its appliance type
 * @param offered the power state values it offers (short names)
 * @returns the port, a stream report of a power state and a switch write with what it sent
 */
async function setUp(
  type: string,
  offered: string[],
): Promise<{
  port: MemoryPort;
  report: (v: string) => Promise<void>;
  switchTo: (on: boolean) => Promise<string | undefined>;
}> {
  const port = new MemoryPort();
  const sync = new ApplianceSync(port);
  port.appliance("HA-1", "Ap", type, offered);
  await sync.syncAppliances();
  await settle();
  return {
    port,
    report: async (v: string): Promise<void> => {
      sync.handleStreamEvent({
        event: "NOTIFY",
        id: "HA-1",
        data: JSON.stringify({ haId: "HA-1", items: [{ key: POWER, value: power(v) }] }),
      });
      await settle();
    },
    switchTo: async (on: boolean): Promise<string | undefined> => {
      port.writes.length = 0;
      await sync.handleWrite("homeconnect.0.ap-1.settings.powerState", on);
      await settle();
      return port.writes.find(w => w.body?.key === POWER)?.body?.value as string | undefined;
    },
  };
}

describe("H-02 On with Off, Standby or MainsOff is a switch", () => {
  it("shows the power state as a writable boolean switch", async () => {
    const { port, report } = await setUp("Oven", ["MainsOff", "Off", "On", "Standby"]);
    expect(port.objects.get("ap-1.settings.powerState")?.common).toMatchObject({
      type: "boolean",
      role: "switch.power",
      write: true,
    });
    expect(port.states.get("ap-1.settings.powerState")?.val).toBe(true);
    for (const off of ["Off", "Standby", "MainsOff"]) {
      await report("On");
      await report(off);
      expect(port.states.get("ap-1.settings.powerState")?.val).toBe(false);
    }
  });

  it("switches off with the off value the appliance last reported itself", async () => {
    const dishwasher = await setUp("Dishwasher", ["On", "Off", "Standby"]);
    await dishwasher.report("Standby");
    expect(await dishwasher.switchTo(false)).toBe(power("Standby"));
    await dishwasher.report("On");
    await dishwasher.report("Off");
    expect(await dishwasher.switchTo(false)).toBe(power("Off"));
    const oven = await setUp("Oven", ["MainsOff", "Off", "On", "Standby"]);
    await oven.report("Off");
    expect(await oven.switchTo(false)).toBe(power("Off"));
  });

  it("before a report, switches off with the off value Home Connect's table lists for the appliance type", async () => {
    const oven = await setUp("Oven", ["MainsOff", "Off", "On", "Standby"]);
    expect(await oven.switchTo(false)).toBe(power("Standby"));
    const dishwasher = await setUp("Dishwasher", ["On", "Off", "Standby"]);
    expect(await dishwasher.switchTo(false)).toBe(power("Off"));
  });

  it("takes Off before Standby where the table lists both or neither, and switches on with On", async () => {
    const microwave = await setUp("Microwave", ["On", "Standby", "Off"]);
    expect(await microwave.switchTo(false)).toBe(power("Off"));
    const washer = await setUp("Washer", ["On", "Standby", "Off"]);
    expect(await washer.switchTo(false)).toBe(power("Off"));
    expect(await washer.switchTo(true)).toBe(power("On"));
  });
});
