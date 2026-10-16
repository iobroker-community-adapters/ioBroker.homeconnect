// Core decision H-03 (accepted 2026-10-15): krobi's unit table — lifetime running time in hours (1 decimal), energy in
// kWh (2), water in litres and load in kg (1), durations in whole minutes, detergent and softener of the last run in ml
// like the machine's dosing; a write goes back in the appliance's unit. krobi 2026-09-29 19:44: "make it hours, that
// makes more sense here" · "and for electricity too kWh is the more sensible unit" · 19:46 "yes, your suggestions
// are absolutely great" · 2026-09-30 11:27 "detergent is given by the machine (dosing) in ML".
import { describe, expect, it, vi } from "vitest";
import { transformItem } from "../lib/value-transformer";
import { resolveWrite } from "../lib/command-dispatch";
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

const SUMMARY =
  '{"counter":359,"end":"2026-09-27T14:47:59.859Z","sequence":[{"configuration":{"options":[],"program":31670},"details":[{"uid":623,"value":35900},{"uid":626,"value":1},{"uid":628,"value":40},{"uid":8198,"value":21}]}],"start":"2026-09-27T14:35:55.271Z"}';

describe("H-03 the unit table", () => {
  const shown = (key: string, value: number, unit: string): { value: unknown; unit: unknown } => {
    const t = transformItem({ key, value, unit });
    return { value: t.value, unit: t.common.unit };
  };

  it("shows each value in the unit of the table", () => {
    // krobi's washer-dryer, 2026-09-29: 2,011,440 s and 139,858 Wh.
    expect(shown("BSH.Common.Status.Program.All.Time.Effective", 2_011_440, "seconds")).toEqual({
      value: 558.7,
      unit: "h",
    });
    expect(shown("BSH.Common.Status.Program.All.Energy.Consumed", 139_858, "Wh")).toEqual({
      value: 139.86,
      unit: "kWh",
    });
    expect(shown("BSH.Common.Status.Program.All.Water.Consumed", 12_171_000, "ml")).toEqual({
      value: 12171,
      unit: "l",
    });
    expect(shown("LaundryCare.Washer.Status.Detergent.All.Consumed", 5_450, "ml")).toEqual({ value: 5.5, unit: "l" });
    expect(shown("LaundryCare.Common.Option.LoadRecommendation", 4_500, "gram")).toEqual({ value: 4.5, unit: "kg" });
    expect(shown("BSH.Common.Option.RemainingProgramTime", 9_060, "seconds")).toEqual({ value: 151, unit: "min" });
  });

  it("writes a duration back in the appliance's unit", () => {
    const req = resolveWrite({
      haId: "HA-1",
      channel: "options",
      id: "duration",
      bshKey: "BSH.Common.Option.Duration",
      value: 30,
    });
    expect(req?.body).toEqual({ key: "BSH.Common.Option.Duration", value: 1800 });
  });

  it("shows the last run's energy in kWh, its water in litres and its detergent in ml", async () => {
    const port = new MemoryPort();
    const sync = new ApplianceSync(port);
    port.sync = sync;
    port.appliance("HA-1", "Wt", "WasherDryer", true, [
      { key: "BSH.Common.Status.ProgramSessionSummary.Latest", value: SUMMARY },
    ]);
    await sync.syncAppliances();
    await settle();
    expect(port.states.get("wt-1.lastRun.energy")?.val).toBe(0.04);
    expect(port.objects.get("wt-1.lastRun.energy")?.common).toMatchObject({ unit: "kWh" });
    expect(port.states.get("wt-1.lastRun.water")?.val).toBe(35.9);
    expect(port.objects.get("wt-1.lastRun.water")?.common).toMatchObject({ unit: "l" });
    expect(port.states.get("wt-1.lastRun.detergent")?.val).toBe(21);
    expect(port.objects.get("wt-1.lastRun.detergent")?.common).toMatchObject({ unit: "ml" });
  });
});
