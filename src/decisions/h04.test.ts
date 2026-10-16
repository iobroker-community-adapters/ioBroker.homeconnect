// Core decision H-04 (accepted with a change 2026-10-15): the appliance's connection internals never become a datapoint
// (BackendConnected, AllowBackendConnection, DeactivateWiFi, SoftwareUpdateTransactionID); the firmware is shown under
// info as the version number of DomainFw, every other version part stays out. krobi 2026-09-29 22:06: "without a
// connection to the server the appliance would not be online … what would that bring" · 2026-10-15 19:53 "h04 ok too
// - but something like the firmware version would be interesting under info" · 20:13 his choice "DomainFw, version only".
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
  apiWrite(_req: WriteRequest): Promise<JsonResult | undefined> {
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

describe("H-04 connection internals stay out, the firmware stands under info", () => {
  it("builds no datapoint for an internal key or another version part, and info.firmware from DomainFw", async () => {
    const port = new MemoryPort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    // krobi's washer-dryer reported these on 2026-09-29.
    port.appliance("HA-1", "Wt", "WasherDryer", true, [
      { key: "BSH.Common.Status.BackendConnected", value: true },
      { key: "BSH.Common.Status.SoftwareUpdateTransactionID", value: 7 },
      { key: "LaundryCare.Common.Status.Version.Smm.DomainFw", value: "2.5.0 17.10.2024 07:55:52" },
      { key: "LaundryCare.Common.Status.Version.Smm.HcFw", value: "2.2.0" },
      { key: "LaundryCare.Common.Status.Version.Smm.UiLogicFw", value: "1.8.0" },
      { key: "LaundryCare.Common.Status.Version.Smm.OperatingSystem", value: "65.1.9" },
    ]);
    port.answers.set("/api/homeappliances/HA-1/settings", {
      settings: [{ key: "BSH.Common.Setting.AllowBackendConnection", value: true }],
    });
    port.answers.set("/api/homeappliances/HA-1/commands", {
      commands: [{ key: "BSH.Common.Command.DeactivateWiFi", name: "Deactivate Wi-Fi" }],
    });
    await sync.syncAppliances();
    await settle();
    const ids = [...port.objects.keys()].filter(id => id.startsWith("wt-1."));
    expect(ids.filter(id => /backend|softwareUpdateTransaction|deactivateWiFi|version/i.test(id))).toEqual([]);
    expect(port.states.get("wt-1.info.firmware")?.val).toBe("2.5.0");
    expect(port.objects.get("wt-1.info.firmware")?.common).toMatchObject({
      type: "string",
      role: "info.firmware",
      write: false,
    });
    expect(ids.filter(id => id.startsWith("wt-1.info.")).sort()).toEqual(["wt-1.info.firmware", "wt-1.info.reachable"]);
  });
});
