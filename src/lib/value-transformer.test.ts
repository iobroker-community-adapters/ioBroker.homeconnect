import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vi, describe, it, expect } from "vitest";

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

import {
  shortEnum,
  shortEnumIn,
  stateIdForKey,
  transformItem,
  transformOptionDefinition,
  parseConstraints,
  expandBshItem,
  isDoorStatusKey,
} from "./value-transformer";
import { tName } from "./i18n";

describe("parseConstraints", () => {
  it("returns undefined when there is no constraints object", () => {
    expect(parseConstraints(undefined)).toBeUndefined();
    expect(parseConstraints("nope")).toBeUndefined();
    expect(parseConstraints(["a"])).toBeUndefined();
  });

  it("parses numeric bounds, allowed + display values and passes the default through", () => {
    expect(
      parseConstraints({
        min: 0,
        max: 8,
        allowedvalues: ["A", "B"],
        displayvalues: ["a", "b"],
        default: "A",
      }),
    ).toEqual({ min: 0, max: 8, allowedvalues: ["A", "B"], displayvalues: ["a", "b"], default: "A" });
  });

  it("drops non-numeric bounds and non-array value lists (API drift safe)", () => {
    expect(parseConstraints({ min: "0", max: null, allowedvalues: "A" })).toEqual({
      min: undefined,
      max: undefined,
      allowedvalues: undefined,
      displayvalues: undefined,
      default: undefined,
    });
  });
});

describe("shortEnum", () => {
  it("takes the lower-case tail of a dotted BSH value", () => {
    expect(shortEnum("BSH.Common.EnumType.OperationState.Run")).toBe("run");
    expect(shortEnum("LaundryCare.Washer.Program.Cotton")).toBe("cotton");
  });
});

describe("stateIdForKey", () => {
  it("maps kind to channel and lower-cases the name", () => {
    expect(stateIdForKey("BSH.Common.Status.OperationState")).toEqual({ channel: "status", id: "operationState" });
    expect(stateIdForKey("Dishcare.Dishwasher.Event.SaltNearlyEmpty")).toEqual({
      channel: "events",
      id: "saltNearlyEmpty",
    });
    expect(stateIdForKey("BSH.Common.Setting.PowerState")).toEqual({ channel: "settings", id: "powerState" });
    expect(stateIdForKey("BSH.Common.Root.ActiveProgram")).toEqual({ channel: "programs", id: "activeProgram" });
  });
});

describe("transformItem", () => {
  it("turns an event's EventPresentState into a boolean", () => {
    const present = transformItem({
      key: "BSH.Common.Event.ProgramFinished",
      value: "BSH.Common.EnumType.EventPresentState.Present",
    });
    expect(present).toMatchObject({ channel: "events", id: "programFinished", value: true });
    expect(present.common).toMatchObject({ type: "boolean", read: true, write: false });

    const off = transformItem({
      key: "BSH.Common.Event.ProgramFinished",
      value: "BSH.Common.EnumType.EventPresentState.Off",
    });
    expect(off.value).toBe(false);
  });

  it("turns a known enum into a short value with curated states", () => {
    const op = transformItem({
      key: "BSH.Common.Status.OperationState",
      value: "BSH.Common.EnumType.OperationState.Run",
    });
    expect(op).toMatchObject({ channel: "status", id: "operationState", value: "run" });
    expect(op.common.type).toBe("string");
    expect(op.common.states).toMatchObject({ run: "Running", finished: "Finished" });
  });

  it("offers only the values the appliance allows, with the curated labels", () => {
    // The cloud sent allowedvalues but no displayvalues — the curated table must
    // then supply the LABELS only. Using it whole put values into common.states
    // that the appliance rejects: a dishwasher offered `standby` and `mainsoff`,
    // and picking one did nothing at all.
    const power = transformItem({
      key: "BSH.Common.Setting.PowerState",
      value: "BSH.Common.EnumType.PowerState.Off",
      constraints: {
        allowedvalues: ["BSH.Common.EnumType.PowerState.Off", "BSH.Common.EnumType.PowerState.On"],
        access: "readWrite",
      },
    });
    expect(power.common.states).toEqual({ off: "Off", on: "On" });
    expect(power.bshValues).toHaveLength(2);
  });

  it("keeps the full curated map when the appliance declares no allowed values", () => {
    // No allowedvalues at all (a plain status read): the curated map is all there
    // is, and dropping it would leave the raw short values as labels.
    const op = transformItem({
      key: "BSH.Common.Status.OperationState",
      value: "BSH.Common.EnumType.OperationState.Run",
    });
    expect(Object.keys(op.common.states ?? {}).length).toBeGreaterThan(2);
  });

  it("reports no value for a key-only item and for an explicit null", () => {
    // The cloud sends key-only items (a response holds only the subset the
    // appliance reports right now) and, for some undocumented keys, an explicit
    // null. `JSON.stringify` turned the first into `undefined` and the second
    // into the TEXT "null" — both then went straight into the datapoint, the one
    // emptying a good reading, the other storing a four-letter lie.
    const bare = transformItem({ key: "Dishcare.Dishwasher.Status.ProgramPhase", value: undefined });
    expect(bare.value).toBeUndefined();
    const nulled = transformItem({ key: "Dishcare.Dishwasher.Status.ProgramPhase", value: null });
    expect(nulled.value).toBeUndefined();
  });

  it("shortens an enum without a curated states map (still lossless)", () => {
    const door = transformItem({ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" });
    expect(door.value).toBe("open");
    expect(door.common.states).toBeUndefined();
  });

  it("keeps a number and carries unit + constraints", () => {
    const t = transformItem({
      key: "BSH.Common.Option.RemainingProgramTime",
      value: 3600,
      unit: "seconds",
      constraints: { min: 0, max: 86400 },
    });
    expect(t).toMatchObject({ channel: "options", id: "remainingProgramTime", value: 3600 });
    expect(t.common).toMatchObject({ type: "number", role: "value", unit: "seconds", min: 0, max: 86400 });
  });

  it("keeps a native boolean", () => {
    const t = transformItem({ key: "BSH.Common.Status.RemoteControlActive", value: true });
    expect(t).toMatchObject({ channel: "status", id: "remoteControlActive", value: true });
    expect(t.common.type).toBe("boolean");
  });

  it("shortens an active program key", () => {
    const t = transformItem({ key: "BSH.Common.Root.ActiveProgram", value: "LaundryCare.Washer.Program.Cotton" });
    expect(t).toMatchObject({ channel: "programs", id: "activeProgram", value: "cotton" });
  });

  it("falls back to the raw value for an unknown string, losing nothing", () => {
    const t = transformItem({ key: "Cooking.Oven.Status.SomethingNew", value: "Cooking.Oven.SomethingRaw" });
    // Contains no ".EnumType." / ".Program." → kept as-is.
    expect(t.value).toBe("Cooking.Oven.SomethingRaw");
    expect(t.common.type).toBe("string");
  });

  it("makes a setting boolean writable with a switch role", () => {
    const t = transformItem({ key: "BSH.Common.Setting.ChildLock", value: false });
    expect(t.common).toMatchObject({ type: "boolean", role: "switch", read: true, write: true });
  });

  it("makes a setting number writable with a level role", () => {
    const t = transformItem({
      key: "Refrigeration.FridgeFreezer.Setting.SetpointTemperatureRefrigerator",
      value: 4,
      unit: "°C",
      constraints: { min: 2, max: 8 },
    });
    expect(t.common).toMatchObject({ type: "number", role: "level", read: true, write: true, min: 2, max: 8 });
  });

  it("carries the constraints' step size into common.step", () => {
    const t = transformItem({
      key: "Refrigeration.FridgeFreezer.Setting.SetpointTemperatureRefrigerator",
      value: 4,
      unit: "°C",
      constraints: { min: 2, max: 8, stepsize: 1 },
    });
    expect(t.common.step).toBe(1);
  });

  it("keeps a setting the API marks access:'read' read-only", () => {
    const t = transformItem({
      key: "BSH.Common.Setting.AmbientLightBrightness",
      value: 70,
      constraints: { min: 0, max: 100, access: "read" },
    });
    expect(t.common.write).toBe(false);
    expect(t.common.role).toBe("value");
  });

  it("keeps a setting with access:'readWrite' writable", () => {
    const t = transformItem({
      key: "BSH.Common.Setting.ChildLock",
      value: false,
      constraints: { access: "readWrite" },
    });
    expect(t.common).toMatchObject({ write: true, role: "switch" });
  });

  it("makes a setting enum writable with states + candidate values from allowedvalues", () => {
    const t = transformItem({
      key: "BSH.Common.Setting.PowerState",
      value: "BSH.Common.EnumType.PowerState.On",
      constraints: { allowedvalues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Standby"] },
    });
    expect(t).toMatchObject({ channel: "settings", id: "powerState", value: "on" });
    expect(t.common).toMatchObject({ role: "text", write: true, states: { on: "On", standby: "Standby" } });
    expect(t.bshValues).toEqual(["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Standby"]);
  });

  it("makes the selected program writable and keeps the full program keys for write-back", () => {
    const t = transformItem({
      key: "BSH.Common.Root.SelectedProgram",
      value: "Dishcare.Dishwasher.Program.Eco50",
      constraints: { allowedvalues: ["Dishcare.Dishwasher.Program.Eco50", "Dishcare.Dishwasher.Program.Auto2"] },
    });
    expect(t).toMatchObject({ channel: "programs", id: "selectedProgram", value: "eco50" });
    expect(t.common.write).toBe(true);
    expect(t.bshValues).toEqual(["Dishcare.Dishwasher.Program.Eco50", "Dishcare.Dishwasher.Program.Auto2"]);
  });

  it("leaves the active program read-only with no candidate values", () => {
    const t = transformItem({ key: "BSH.Common.Root.ActiveProgram", value: "LaundryCare.Washer.Program.Cotton" });
    expect(t.common.write).toBe(false);
    expect(t.bshValues).toBeUndefined();
  });

  it("leaves a status enum read-only (no write-back candidates)", () => {
    const t = transformItem({
      key: "BSH.Common.Status.OperationState",
      value: "BSH.Common.EnumType.OperationState.Run",
    });
    expect(t.common.write).toBe(false);
    expect(t.bshValues).toBeUndefined();
  });
});

describe("transformOptionDefinition", () => {
  it("makes a Boolean option a writable switch", () => {
    const t = transformOptionDefinition({
      key: "Dishcare.Dishwasher.Option.IntensivZone",
      name: "Intensive zone",
      type: "Boolean",
    });
    // No default in the definition → no value (audit 2026-09-24, D9): an invented
    // `false` read like a measurement for a program that never ran.
    expect(t).toMatchObject({ channel: "options", id: "intensivZone", value: undefined });
    expect(t.common).toMatchObject({ type: "boolean", role: "switch", read: true, write: true });
  });

  it("derives type from option.type (Int), not from a value, with unit + bounds + default", () => {
    const t = transformOptionDefinition({
      key: "BSH.Common.Option.StartInRelative",
      name: "Start in",
      type: "Int",
      unit: "seconds",
      constraints: { min: 0, max: 86400, default: 3600 },
    });
    expect(t.common).toMatchObject({ type: "number", role: "level", write: true, unit: "seconds", min: 0, max: 86400 });
    expect(t.value).toBe(3600);
  });

  it("labels an enum option from the parallel displayvalues and keeps full values for write-back", () => {
    const t = transformOptionDefinition({
      key: "LaundryCare.Washer.Option.SpinSpeed",
      name: "Spin speed",
      type: "LaundryCare.Washer.EnumType.SpinSpeed",
      constraints: {
        allowedvalues: [
          "LaundryCare.Washer.EnumType.SpinSpeed.RPM800",
          "LaundryCare.Washer.EnumType.SpinSpeed.RPM1200",
        ],
        displayvalues: ["800 rpm", "1200 rpm"],
        default: "LaundryCare.Washer.EnumType.SpinSpeed.RPM1200",
      },
    });
    expect(t).toMatchObject({ channel: "options", id: "spinSpeed", value: "rpm1200" });
    expect(t.common).toMatchObject({ write: true, states: { rpm800: "800 rpm", rpm1200: "1200 rpm" } });
    expect(t.bshValues).toEqual([
      "LaundryCare.Washer.EnumType.SpinSpeed.RPM800",
      "LaundryCare.Washer.EnumType.SpinSpeed.RPM1200",
    ]);
  });

  it("falls back to the short value as its own label when no displayvalues are given", () => {
    const t = transformOptionDefinition({
      key: "Cooking.Oven.Option.WarmingLevel",
      type: "Cooking.Oven.EnumType.WarmingLevel",
      constraints: { allowedvalues: ["Cooking.Oven.EnumType.WarmingLevel.Low"] },
    });
    expect(t.common.states).toEqual({ low: "low" });
  });
});

describe("value-transformer edge inputs", () => {
  it("keeps a key with no dots usable", () => {
    // Anything the API adds later that does not follow the four-part shape must
    // still land somewhere addressable instead of producing an empty id.
    expect(stateIdForKey("Weird")).toEqual({ channel: "misc", id: "weird" });
    expect(shortEnum("Plain")).toBe("plain");
    expect(shortEnum("")).toBe("");
  });

  it("ignores constraint fields of the wrong type", () => {
    // These come straight off the wire. A string min would end up in common.min
    // and make the admin slider unusable.
    const c = parseConstraints({ min: "5", max: null, stepsize: "1", allowedvalues: "x", access: 7, default: 3 });
    expect(c).toMatchObject({ min: undefined, max: undefined, stepsize: undefined, allowedvalues: undefined });
    expect(c?.access).toBeUndefined();
    expect(c?.default).toBe(3);
    expect(parseConstraints(undefined)).toBeUndefined();
  });

  it("turns a value it cannot classify into a lossless string", () => {
    // Nothing may be silently dropped: an unknown shape is still shown.
    const t = transformItem({ key: "BSH.Common.Status.Something", value: { a: 1 } });
    expect(t.common.type).toBe("string");
    expect(t.value).toBe('{"a":1}');
  });

  it("gives a writable enum its candidates even without an allowed list", () => {
    // A settings enum whose constraints the API omitted still has to resolve a
    // short write back to its full BSH value.
    const t = transformItem({ key: "BSH.Common.Setting.PowerState", value: "BSH.Common.EnumType.PowerState.On" });
    expect(t.value).toBe("on");
    expect(t.bshValues).toEqual(["BSH.Common.EnumType.PowerState.On"]);
  });

  it("gives a read-only enum no candidates", () => {
    const t = transformItem({
      key: "BSH.Common.Status.OperationState",
      value: "BSH.Common.EnumType.OperationState.Run",
      constraints: { access: "read" },
    });
    expect(t.common.write).toBe(false);
    expect(t.bshValues).toBeUndefined();
  });

  it("carries unit and bounds onto a numeric item", () => {
    const t = transformItem({
      key: "Cooking.Oven.Setting.SetpointTemperature",
      value: 200,
      unit: "°C",
      constraints: { min: 30, max: 300, stepsize: 5 },
    });
    expect(t.common).toMatchObject({ type: "number", unit: "°C", min: 30, max: 300, step: 5 });
  });

  it("seeds a numeric option only from its own default (audit 2026-09-24, D9)", () => {
    const mk = (constraints: Record<string, unknown>): unknown =>
      transformOptionDefinition({ key: "X.Option.Y", type: "Int", constraints: parseConstraints(constraints) }).value;
    expect(mk({ default: 7, min: 1 })).toBe(7);
    // The minimum or a zero is no reading — nothing is seeded then.
    expect(mk({ min: 1 })).toBeUndefined();
    expect(mk({})).toBeUndefined();
  });

  it("a read-only option definition is not writable (audit 2026-09-24, D8)", () => {
    const mk = (type: string): ioBroker.StateCommon =>
      transformOptionDefinition({
        key: "LaundryCare.Common.Option.ProcessPhase",
        type,
        constraints: parseConstraints({ access: "read" }),
      }).common;
    expect(mk("Int")).toMatchObject({ write: false, role: "value" });
    expect(mk("Boolean")).toMatchObject({ write: false, role: "indicator" });
    expect(mk("String")).toMatchObject({ write: false });
  });

  it("routes the event key that names only its value type to the events channel (audit 2026-09-24, D7)", () => {
    expect(stateIdForKey("BSH.Common.EnumType.EventPresentState")).toEqual({ channel: "events", id: "unnamedEvent" });
    const t = transformItem({
      key: "BSH.Common.EnumType.EventPresentState",
      value: "BSH.Common.EnumType.EventPresentState.Present",
    });
    expect(t).toMatchObject({ channel: "events", id: "unnamedEvent", value: true, nameSource: "i18n" });
    expect(t.common).toMatchObject({ type: "boolean", write: false });
  });
});

describe("stateIdForKey — nested keys land in their real channel", () => {
  it("routes the kind segment wherever it sits in the key", () => {
    expect(stateIdForKey("Refrigeration.Common.Status.Door.Freezer")).toEqual({
      channel: "status",
      id: "doorFreezer",
    });
    expect(stateIdForKey("Refrigeration.Common.Setting.Light.Internal.Brightness")).toEqual({
      channel: "settings",
      id: "lightInternalBrightness",
    });
    expect(stateIdForKey("BSH.Common.Option.SmartEnergyService.SmartStartEnabled")).toEqual({
      channel: "options",
      id: "smartEnergyServiceSmartStartEnabled",
    });
    expect(stateIdForKey("BSH.Common.Event.Favorite.001.ExternalTrigger")).toEqual({
      channel: "events",
      id: "favorite001ExternalTrigger",
    });
    expect(stateIdForKey("ConsumerProducts.CleaningRobot.Event.DustBin.NotInstalled")).toEqual({
      channel: "events",
      id: "dustBinNotInstalled",
    });
  });

  it("keeps the simple two-segment form unchanged", () => {
    expect(stateIdForKey("BSH.Common.Status.OperationState")).toEqual({ channel: "status", id: "operationState" });
    expect(stateIdForKey("Dishcare.Dishwasher.Event.SaltNearlyEmpty")).toEqual({
      channel: "events",
      id: "saltNearlyEmpty",
    });
  });

  it("a nested SETTING is writable again (the misc mis-channeling made it read-only)", () => {
    const t = transformItem({ key: "Refrigeration.Common.Setting.Light.Internal.Brightness", value: 70 });
    expect(t.channel).toBe("settings");
    expect(t.common.write).toBe(true);
  });
});

describe("expandBshItem — doors and the derived programRunning", () => {
  it("turns the common DoorState into a doorOpen boolean", () => {
    const states = expandBshItem(
      { key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" },
      false,
    );
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ channel: "status", id: "doorOpen", value: true });
    expect(states[0]?.common.type).toBe("boolean");
  });

  it("adds doorLocked only for a lockable-door appliance type", () => {
    const locked = expandBshItem(
      { key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Locked" },
      true,
    );
    expect(locked.map(s => s.id)).toEqual(["doorOpen", "doorLocked"]);
    expect(locked[0]?.value).toBe(false);
    expect(locked[1]?.value).toBe(true);
  });

  it("maps a per-compartment door to its own <compartment>Open boolean", () => {
    const states = expandBshItem(
      { key: "Refrigeration.Common.Status.Door.Freezer", value: "BSH.Common.EnumType.DoorState.Closed" },
      false,
    );
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ channel: "status", id: "doorFreezerOpen", value: false });
  });

  it("leaves a door SETTING on the generic path", () => {
    expect(isDoorStatusKey("Refrigeration.Common.Setting.Door.AssistantFreezer")).toBe(false);
    expect(isDoorStatusKey("BSH.Common.Status.DoorState")).toBe(true);
    expect(isDoorStatusKey("Refrigeration.Common.Status.Door.Refrigerator")).toBe(true);
  });

  it("derives programRunning from the operation state", () => {
    const run = expandBshItem(
      { key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" },
      false,
    );
    expect(run.map(s => s.id)).toEqual(["operationState", "programRunning"]);
    expect(run[1]?.value).toBe(true);
    const ready = expandBshItem(
      { key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Ready" },
      false,
    );
    expect(ready[1]?.value).toBe(false);
  });

  it("passes every other item through 1:1", () => {
    const states = expandBshItem({ key: "BSH.Common.Setting.ChildLock", value: true }, true);
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ channel: "settings", id: "childLock", value: true });
  });
});

describe("display names and descriptions", () => {
  it("prefers the adapter's own name over the cloud's and explains the state in desc", () => {
    const t = transformItem({
      key: "BSH.Common.Status.OperationState",
      name: "Betriebszustand",
      value: "BSH.Common.EnumType.OperationState.Run",
    });
    // Our own name wins over the cloud's — same German wording here, but in all
    // eleven languages instead of the one the cloud happened to answer in. (The
    // very same key came back "Operation state" on another appliance, measured
    // 2026-09-12 with Accept-Language: de-DE.)
    expect(t.common.name).toMatchObject({ de: "Betriebszustand", en: "Operating state" });
    expect(t.common.desc).toMatchObject({ en: "Operating state: off, ready, running, paused, finished, fault." });
    expect(t.nameSource).toBe("i18n");
  });

  it("beats an English cloud name even though German was requested", () => {
    // Measured at a live installation on 2026-09-12 with Accept-Language: de-DE:
    // the cloud answered "Power status" for the dishwasher and "Childproof lock"
    // for the washer-dryer — neither is a text `humanizeId` produces ("Power
    // state", "Child lock"), so they really came from the cloud. The very same
    // OperationState key came back "Betriebsstatus" on one appliance and
    // "Operation state" on another. A name of ours reaches all eleven languages.
    for (const [key, cloud, ours] of [
      ["BSH.Common.Setting.PowerState", "Power status", "setPowerState"],
      ["BSH.Common.Setting.ChildLock", "Childproof lock", "setChildLock"],
      ["BSH.Common.Status.OperationState", "Operation state", "stOperationState"],
    ] as const) {
      const t = transformItem({ key, name: cloud, value: false });
      expect(t.common.name).toEqual(tName(ours));
      expect(t.nameSource).toBe("i18n");
    }
  });

  it("names a catalog event itself, in every language, with a short explanation", () => {
    const t = transformItem({ key: "Dishcare.Dishwasher.Event.SaltNearlyEmpty", value: undefined });
    expect(t.common.name).toMatchObject({ en: "Salt nearly empty", de: "Salz fast leer" });
    expect(t.common.desc).toMatchObject({ de: "Reicht noch für wenige Spülgänge." });
    expect(t.nameSource).toBe("i18n");
  });

  it("cleans a name with a line break instead of storing it", () => {
    // A key the text table does NOT cover — then the cloud name is what lands in
    // the object, and it gets cleaned. (With a table entry our own name wins and
    // there would be nothing left to clean, making the assertion vacuous.) An
    // unknown key is not dropped, which this covers too.
    const t = transformItem({
      key: "Cooking.Hob.Status.SomeKeyNoSourceDocuments",
      name: "Ofen\ntemperatur",
      value: 50,
    });
    expect(t.common.name).toBe("Ofen temperatur");
    expect(t.nameSource).toBe("api");
  });

  it("names the synthetic program states itself, as translation objects", () => {
    const sel = transformItem({ key: "BSH.Common.Root.SelectedProgram", value: "" });
    expect(sel.common.name).toMatchObject({ en: "Selected program", de: "Gewähltes Programm" });
    expect(sel.nameSource).toBe("i18n");
    const act = transformItem({ key: "BSH.Common.Root.ActiveProgram", value: "" });
    expect(act.common.name).toMatchObject({ en: "Active program" });
  });

  it("names the derived door and running states as translation objects", () => {
    const door = expandBshItem(
      { key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Open" },
      true,
    );
    expect(door[0]?.common.name).toMatchObject({ en: "Door open", de: "Tür offen" });
    expect(door[1]?.common.name).toMatchObject({ en: "Door locked" });
    expect(door[0]?.common.desc).toMatchObject({ de: "Wahr, solange die Tür offen steht." });
    const freezer = expandBshItem(
      { key: "Refrigeration.Common.Status.Door.Freezer", value: "BSH.Common.EnumType.DoorState.Closed" },
      false,
    );
    expect(freezer[0]?.common.name).toMatchObject({ en: "Freezer door open", de: "Tür Gefrierfach offen" });
    const run = expandBshItem(
      { key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" },
      false,
    );
    expect(run[1]?.common.name).toMatchObject({ en: "Program running" });
  });

  it("labels a setting's choices with the cloud's display values when it sends them", () => {
    const t = transformItem({
      key: "BSH.Common.Setting.PowerState",
      value: "BSH.Common.EnumType.PowerState.On",
      constraints: {
        allowedvalues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Standby"],
        displayvalues: ["Ein", "Bereitschaft"],
      },
    });
    // Localized labels from the API beat the curated English list.
    expect(t.common.states).toEqual({ on: "Ein", standby: "Bereitschaft" });
  });

  it("keeps the curated labels when the display values do not line up", () => {
    const t = transformItem({
      key: "BSH.Common.Setting.PowerState",
      value: "BSH.Common.EnumType.PowerState.On",
      constraints: {
        allowedvalues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Standby"],
        displayvalues: ["Ein"],
      },
    });
    expect(t.common.states).toMatchObject({ on: "On", standby: "Standby" });
  });

  it("names an option from its definition, without inventing an explanation", () => {
    const t = transformOptionDefinition({
      key: "LaundryCare.Washer.Option.SpinSpeed",
      name: "Schleuderdrehzahl",
      type: "Int",
    });
    expect(t.common.name).toMatchObject({ de: "Schleuderdrehzahl", en: "Spin speed" });
    // A known option carries the adapter's explanation next to that name.
    expect(t.common.desc).toMatchObject({
      de: "Wie schnell die Trommel am Ende schleudert — schneller heißt trocknere Wäsche.",
    });
    expect(t.nameSource).toBe("i18n");
    const known = transformOptionDefinition({ key: "BSH.Common.Option.ProgramProgress", type: "Int" });
    expect(known.common.desc).toMatchObject({ de: "Fortschritt in Prozent." });
    // Same name with or without a cloud name in the definition — the table entry
    // decides, and it is stamped "i18n" so no later label replaces it.
    const bare = transformOptionDefinition({ key: "LaundryCare.Washer.Option.SpinSpeed", type: "Int" });
    expect(bare.common.name).toMatchObject({ de: "Schleuderdrehzahl", en: "Spin speed" });
    expect(bare.nameSource).toBe("i18n");
    // A key the adapter has no name for still falls back to the English label —
    // and gets no explanation at all: an invented sentence would be worse than none.
    const unknown = transformOptionDefinition({ key: "LaundryCare.Washer.Option.MadeUpOne", type: "Int" });
    expect(unknown.common.name).toBe("Made up one");
    expect(unknown.nameSource).toBe("derived");
    expect(unknown.common.desc).toBeUndefined();
  });
});

describe("option names where the cloud sends none", () => {
  it("uses our own translated name whether or not the cloud sent one", () => {
    // Measured 2026-09-12: the cloud answers option names in English as readily
    // as in the requested language ("Spin Speed", "Less Ironing" next to
    // "Glanztrocknen"), and the same key differs between two appliances. A name
    // of ours reaches all eleven languages, so it wins in both cases.
    const withCloudName = transformOptionDefinition({
      key: "LaundryCare.Washer.Option.Prewash",
      name: "Vorspülen",
      type: "Boolean",
    });
    const withoutCloudName = transformOptionDefinition({ key: "LaundryCare.Washer.Option.Prewash", type: "Boolean" });
    for (const t of [withCloudName, withoutCloudName]) {
      expect(t.common.name).toMatchObject({ de: "Vorwäsche", en: "Prewash", "zh-cn": "预洗" });
      expect(t.nameSource).toBe("i18n");
    }
  });

  it("covers every appliance family, not only the ones we can test with", () => {
    for (const key of [
      "Dishcare.Dishwasher.Option.IntensivZone",
      "Cooking.Oven.Option.FastPreHeat",
      "ConsumerProducts.CoffeeMaker.Option.CoffeeStrength",
      "ConsumerProducts.CleaningRobot.Option.SuctionPower",
      "HeatingVentilationAirConditioning.AirConditioner.Option.FanSpeedPercentage",
      "LaundryCare.Dryer.Option.DryingTarget",
    ]) {
      const t = transformOptionDefinition({ key, type: "Boolean" });
      expect(typeof t.common.name, key).toBe("object");
    }
  });
});

describe("compartment doors of a refrigeration appliance", () => {
  it("names every known compartment in every language, not with the raw key segment", () => {
    const expected: Record<string, { de: string; en: string }> = {
      Refrigerator: { de: "Tür Kühlfach offen", en: "Refrigerator door open" },
      Freezer: { de: "Tür Gefrierfach offen", en: "Freezer door open" },
      BottleCooler: { de: "Tür Flaschenkühler offen", en: "Bottle cooler door open" },
      ChillerLeft: { de: "Tür Kaltfach links offen", en: "Left chiller door open" },
      WineCompartment: { de: "Tür Weinfach offen", en: "Wine compartment door open" },
      FlexCompartment: { de: "Tür Flexfach offen", en: "Flex compartment door open" },
    };
    for (const [segment, texts] of Object.entries(expected)) {
      const [t] = expandBshItem({ key: `Refrigeration.Common.Status.Door.${segment}`, value: undefined }, false);
      expect(t.id, segment).toBe(`door${segment}Open`);
      expect(t.common.name, segment).toMatchObject(texts);
    }
  });

  it("falls back to the placeholder for a compartment the catalogue does not know", () => {
    // A new compartment must not break — it just arrives in English until it is
    // added to the table.
    const [t] = expandBshItem({ key: "Refrigeration.Common.Status.Door.SnackDrawer", value: undefined }, false);
    expect(t.common.name).toMatchObject({ en: "Door SnackDrawer open" });
  });
});

describe("keys the extra-data opt-in delivers", () => {
  // krobi switched on the additional appliance data in the Home Connect developer
  // portal (2026-09-07). His three appliances then reported ten keys that NO source
  // documents — not api-docs.home-connect.com, not the 1020-key reference of
  // homebridge-homeconnect. They arrived in the tree with an English label derived
  // from the key, because the table was built against a catalogue that never saw them.
  const OPT_IN_KEYS = [
    "Dishcare.Dishwasher.Status.ProgramPhase",
    "Dishcare.Dishwasher.Status.EcoDryActive",
    "BSH.Common.Status.ProgramSessionSummary.Latest",
    "BSH.Common.Status.Program.All.Energy.Consumed",
    "BSH.Common.Status.Program.All.Water.Consumed",
    "LaundryCare.Washer.Status.Detergent.All.Consumed",
    "LaundryCare.Common.Status.Program.History.Uid",
    "LaundryCare.Common.Status.Program.History.EffectiveTime",
    "LaundryCare.Common.Status.Program.Details.Program02",
    "LaundryCare.Common.Status.Program.Details.Program09",
  ];

  it.each(OPT_IN_KEYS)("names and explains %s in every language", key => {
    const t = transformItem({ key, value: "x" });
    // A plain string is what the derived English label looks like — the defect.
    expect(typeof t.common.name).toBe("object");
    expect(typeof t.common.desc).toBe("object");
    const name = t.common.name as Record<string, string>;
    const desc = t.common.desc as Record<string, string>;
    for (const lang of ["en", "de", "fr", "it", "nl", "pl", "pt", "ru", "uk", "zh-cn", "es"]) {
      expect(name[lang], `name/${lang}`).toBeTruthy();
      expect(desc[lang], `desc/${lang}`).toBeTruthy();
      // An unresolved key would come back as the key itself.
      expect(name[lang]).not.toMatch(/^st[A-Z]/);
      expect(desc[lang]).not.toMatch(/Desc$/);
    }
  });

  it("fills the number of a numbered family into name and description", () => {
    const nine = transformItem({ key: "LaundryCare.Common.Status.Program.Details.Program09", value: "D3sDAFwA" });
    const two = transformItem({ key: "LaundryCare.Common.Status.Program.Details.Program02", value: "D3sHAFkA" });
    expect((nine.common.name as Record<string, string>).en).toBe("Program details 9");
    expect((nine.common.name as Record<string, string>).de).toBe("Programmdetails 9");
    expect((two.common.name as Record<string, string>).de).toBe("Programmdetails 2");
    // The placeholder must not survive into the tree.
    expect((nine.common.desc as Record<string, string>).de).toContain("9");
    for (const lang of Object.keys(nine.common.name as Record<string, string>)) {
      expect((nine.common.name as Record<string, string>)[lang]).not.toContain("%s");
      expect((nine.common.desc as Record<string, string>)[lang]).not.toContain("%s");
    }
  });

  it("names the opt-in keys itself, even when the cloud sends a name", () => {
    // These keys are in no source at all (neither api-docs nor the 1020-key
    // reference), so the adapter's own text is the only one that reaches every
    // language — and it is not replaced by whatever single language the cloud
    // happens to answer in.
    const t = transformItem({ key: "Dishcare.Dishwasher.Status.EcoDryActive", value: false, name: "Eco-Trocknen" });
    expect(t.common.name).toMatchObject({ de: "EcoDry aktiv" });
    expect(t.nameSource).toBe("i18n");
    // The explanation belongs to the adapter either way.
    expect(typeof t.common.desc).toBe("object");
  });
});

describe("every table entry explains its datapoint", () => {
  it("leaves no entry without a description", () => {
    // krobi 2026-09-07: "why can't you translate EVERYTHING". Ten entries had a
    // name but no explanation — seven of them were a second SPELLING of an option
    // whose twin carried the text all along (`…IDos1.Active` next to `…IDos1Active`,
    // `Washer.Option.SpeedPerfect` next to `Common.Option.SpeedPerfect`). The upgrade
    // suite caught it as "desc still null" on an existing tree.
    const src = readFileSync(join(__dirname, "state-texts.ts"), "utf8");
    const without: string[] = [];
    for (const m of src.matchAll(/"([A-Za-z]+\.[A-Za-z0-9.]+)":\s*\{([^{}]*)\}/gs)) {
      if (!/desc:/.test(m[2])) {
        without.push(m[1]);
      }
    }
    expect(without).toEqual([]);
  });
});

describe("expandBshItem findings of the 2026-09-15 audit", () => {
  it("carries no value through any expansion when the item has none", () => {
    // Key-only items are real: a response carries only what the appliance
    // reports right now. Every expansion used to turn the absence into `false`
    // (door closed, not running, no alarm) — the fallback path already kept it.
    const keyOnly = (key: string, lockable = false): unknown[] =>
      expandBshItem({ key, value: undefined }, lockable).map(t => t.value);
    expect(keyOnly("BSH.Common.Status.DoorState", true)).toEqual([undefined, undefined]);
    expect(keyOnly("BSH.Common.Status.DoorState")).toEqual([undefined]);
    expect(keyOnly("Refrigeration.Common.Status.Door.Freezer")).toEqual([undefined]);
    expect(keyOnly("BSH.Common.Status.OperationState")).toEqual([undefined, undefined]);
    expect(keyOnly("BSH.Common.Event.ProgramFinished")).toEqual([undefined]);
    // null is not a value either (except for the program roots, resolved upstream).
    expect(expandBshItem({ key: "BSH.Common.Event.ProgramFinished", value: null }, false).map(t => t.value)).toEqual([
      undefined,
    ]);
    // And a real value still expands as before.
    expect(
      expandBshItem({ key: "BSH.Common.Status.DoorState", value: "BSH.Common.EnumType.DoorState.Locked" }, true).map(
        t => t.value,
      ),
    ).toEqual([false, true]);
    expect(
      expandBshItem(
        { key: "BSH.Common.Status.OperationState", value: "BSH.Common.EnumType.OperationState.Run" },
        false,
      ).map(t => t.value),
    ).toEqual(["run", true]);
  });
});

describe("shortEnumIn (audit 2026-09-24, F7)", () => {
  it("is the bare last segment unless another value of the list ends the same", () => {
    const heat = "Cooking.Oven.Program.HeatingMode.DoughProving";
    const steam = "Cooking.Oven.Program.SteamModes.DoughProving";
    const bake = "Cooking.Oven.Program.HeatingMode.PizzaSetting";
    expect(shortEnumIn(bake, [heat, steam, bake])).toBe("pizzasetting");
    expect(shortEnumIn(heat, [heat, steam, bake])).toBe("heatingmode.doughproving");
    expect(shortEnumIn(steam, [heat, steam, bake])).toBe("steammodes.doughproving");
    expect(shortEnumIn(heat)).toBe("doughproving");
    const cotton = "LaundryCare.WasherDryer.Program.Cotton";
    const cotton3 = "LaundryCare.WasherDryer.Program.Cotton.Cotton.Cotton";
    expect(shortEnumIn(cotton, [cotton, cotton3])).toBe("program.cotton");
    expect(shortEnumIn(cotton3, [cotton, cotton3])).toBe("cotton.cotton");
  });
});

describe("no value in, no value out (audit 2026-09-24, F10)", () => {
  it("a key-only enum item writes no empty string over the reading", () => {
    const t = transformItem({
      key: "BSH.Common.Setting.PowerState",
      value: undefined,
      constraints: { allowedvalues: ["BSH.Common.EnumType.PowerState.On", "BSH.Common.EnumType.PowerState.Off"] },
    });
    expect(t.value).toBeUndefined();
    // The idle program ("") stays a value.
    expect(transformItem({ key: "BSH.Common.Root.SelectedProgram", value: "" }).value).toBe("");
  });
});

describe("enum options without a default (audit 2026-09-24, D9)", () => {
  it("seeds an enum option only from its own default", () => {
    const mk = (constraints: Record<string, unknown>): unknown =>
      transformOptionDefinition({
        key: "LaundryCare.Dryer.Option.DryingTarget",
        type: "LaundryCare.Dryer.EnumType.DryingTarget",
        constraints: parseConstraints(constraints),
      }).value;
    const values = [
      "LaundryCare.Dryer.EnumType.DryingTarget.IronDry",
      "LaundryCare.Dryer.EnumType.DryingTarget.CupboardDry",
    ];
    expect(mk({ allowedvalues: values, default: values[1] })).toBe("cupboarddry");
    // An invented "" read like the user's choice of no drying target.
    expect(mk({ allowedvalues: values })).toBeUndefined();
  });
});
