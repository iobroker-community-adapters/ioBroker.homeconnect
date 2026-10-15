// Core decision H-02 (accepted 2026-10-15): BSH reports on/off as On with Standby, Off or MainsOff — the adapter makes it a
// switch (true/false) like Home Assistant home_connect; switching off sends Off where the appliance offers it, else
// Standby. krobi 2026-09-29 19:30: "warum ist powerstate ein text string? … und keine boolean??!?!?!?!"
import { describe, expect, it, vi } from "vitest";
import { transformItem } from "../lib/value-transformer";
import { resolveWrite } from "../lib/command-dispatch";
// adapter-core's I18n needs a running adapter; a name is not what this guard checks.
vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: (key: string) => ({ en: key }),
    translate: (key: string) => key,
  },
}));

const POWER = "BSH.Common.Setting.PowerState";
const value = (v: string): string => `BSH.Common.EnumType.PowerState.${v}`;

describe("H-02 On with Off, Standby or MainsOff is a switch", () => {
  it("shows the power state as a boolean switch", () => {
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

  it("switches off with Off where the appliance offers it, else with Standby", () => {
    const off = (bshValues: string[]): unknown =>
      resolveWrite({ haId: "HA-1", channel: "settings", id: "powerState", bshKey: POWER, bshValues, value: false })
        ?.body;
    expect(off([value("On"), value("Off"), value("Standby")])).toEqual({ key: POWER, value: value("Off") });
    expect(off([value("On"), value("Standby")])).toEqual({ key: POWER, value: value("Standby") });
    expect(
      resolveWrite({
        haId: "HA-1",
        channel: "settings",
        id: "powerState",
        bshKey: POWER,
        bshValues: [value("On"), value("Off")],
        value: true,
      })?.body,
    ).toEqual({ key: POWER, value: value("On") });
  });
});
