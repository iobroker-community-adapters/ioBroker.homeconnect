// Core decision H-09 (accepted 2026-10-15): whoever moves from the community adapter 1.6.x keeps rooms, functions and
// aliases — they move to the successor datapoint. krobi 2026-09-26 20:34, his choice "Ja, mitnehmen (Empfohlen)" on
// "Wer heute von der Community-Version 1.6.1 umsteigt, verliert … Räume und Aliase … Sollen die mitgenommen werden?"
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

describe("H-09 a 1.6.x tree hands over its rooms, functions and aliases", () => {
  it("moves the room and the alias of a 1.6.x datapoint to its successor once the appliance is read", async () => {
    const port = new MemoryPort();
    const NS = port.namespace;
    // The 1.6.x tree: the bare haId as root, raw BSH leaves.
    const old = `${NS}.012345678901234567.settings.BSH_Common_Setting_ChildLock`;
    port.objects.set("012345678901234567", {
      type: "device",
      common: { name: "Spüler" },
      native: {},
    } as unknown as ioBroker.Object);
    port.objects.set("012345678901234567.settings", {
      type: "channel",
      common: { name: "settings" },
      native: {},
    } as unknown as ioBroker.Object);
    port.objects.set("012345678901234567.settings.BSH_Common_Setting_ChildLock", {
      type: "state",
      common: { name: "ChildLock", type: "boolean", role: "switch", read: true, write: true },
      native: {},
    } as unknown as ioBroker.Object);
    port.foreign.set("enum.rooms.kitchen", {
      type: "enum",
      common: { name: "Kitchen", members: [old] },
      native: {},
    } as unknown as ioBroker.Object);
    port.foreign.set("enum.functions.safety", {
      type: "enum",
      common: { name: "Safety", members: [old] },
      native: {},
    } as unknown as ioBroker.Object);
    port.foreign.set("alias.0.kitchen.childLock", {
      type: "state",
      common: { name: "Lock", alias: { id: old } },
      native: {},
    } as unknown as ioBroker.Object);
    const sync = new ApplianceSync(port);
    port.sync = sync;
    port.appliance("012345678901234567-001", "Spueler", "Dishwasher", true);
    port.answers.set("/api/homeappliances/012345678901234567-001/settings", {
      settings: [{ key: "BSH.Common.Setting.ChildLock", value: true }],
    });
    await sync.sortOutLegacyTrees();
    await sync.syncAppliances();
    await settle();
    const successor = `${NS}.spueler-001.settings.childLock`;
    expect(port.objects.has("spueler-001.settings.childLock")).toBe(true);
    expect((port.foreign.get("enum.rooms.kitchen")?.common as { members: string[] }).members).toEqual([successor]);
    expect((port.foreign.get("enum.functions.safety")?.common as { members: string[] }).members).toEqual([successor]);
    expect((port.foreign.get("alias.0.kitchen.childLock")?.common as { alias: unknown }).alias).toEqual({
      id: successor,
    });
    expect([...port.objects.keys()].filter(id => id.startsWith("012345678901234567"))).toEqual([]);
  });
});
