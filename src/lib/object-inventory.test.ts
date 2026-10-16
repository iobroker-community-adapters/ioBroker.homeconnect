import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stateText } from "./state-texts";

/**
 * Assertions over the generated object inventory (`npm run test:inventory`,
 * driven by the 17 device-type fixtures). These hold what the unit tests cannot:
 * that the rule survives for EVERY appliance type, across the whole tree the
 * adapter really builds.
 */
const inventory = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "test", "objects.inventory.json"), "utf8"),
) as Record<string, { common?: Record<string, unknown>; native?: Record<string, unknown> }>;

describe("object inventory", () => {
  it("gives every writable enum setting more than one candidate value", () => {
    // The finding this defends (2026-09-12, measured at a live installation):
    // the settings LIST carries no constraints, so without the single-setting
    // fetch a writable enum knows only its CURRENT value as a write candidate —
    // an appliance sitting at `off` could not be switched on through the adapter.
    // One candidate is the signature of that bug.
    const offenders = Object.entries(inventory)
      .filter(([id]) => id.includes(".settings."))
      .filter(([, o]) => o.common?.write === true && Array.isArray(o.native?.bshValues))
      .filter(([, o]) => (o.native?.bshValues as unknown[]).length < 2)
      .map(([id]) => id);
    expect(offenders).toEqual([]);
    // And the rule is not vacuous: there ARE such settings in the inventory.
    const enums = Object.entries(inventory).filter(
      ([id, o]) => id.includes(".settings.") && o.common?.write === true && Array.isArray(o.native?.bshValues),
    );
    expect(enums.length).toBeGreaterThan(10);
  });

  it("gives every numeric setting the bounds its constraints declare", () => {
    const offenders = Object.entries(inventory)
      .filter(([id, o]) => id.includes(".settings.") && o.common?.type === "number")
      .filter(([, o]) => o.common?.min === undefined || o.common?.max === undefined)
      .map(([id]) => id);
    expect(offenders).toEqual([]);
  });

  it("gives no appliance two datapoints with the same name, in any language", () => {
    // A name has to say WHICH datapoint it is. `settings.powerState` and
    // `status.operationState` both read "Betriebszustand" in German until
    // 2026-09-12 — invisible while the cloud name won on powerState, and plainly
    // wrong once our own text did. Two Oven preheat events and two chiller doors
    // collided in ALL eleven languages, in the very same channel.
    const langs = Object.keys(
      Object.values(inventory).find(o => typeof o.common?.name === "object")?.common?.name ?? {},
    );
    expect(langs.length).toBeGreaterThan(5);
    const clashes: string[] = [];
    for (const lang of langs) {
      const perDevice = new Map<string, Map<string, string[]>>();
      for (const [id, o] of Object.entries(inventory)) {
        const parts = id.split(".");
        if (parts.length < 5 || (o as { type?: string }).type !== "state") {
          continue;
        }
        const name = o.common?.name;
        const text = typeof name === "object" ? (name as Record<string, string>)[lang] : (name as string);
        if (!text) {
          continue;
        }
        const device = parts[2];
        const byName = perDevice.get(device) ?? new Map<string, string[]>();
        perDevice.set(device, byName);
        byName.set(text, [...(byName.get(text) ?? []), parts.slice(3).join(".")]);
      }
      for (const [device, byName] of perDevice) {
        for (const [text, ids] of byName) {
          if (ids.length > 1) {
            clashes.push(`${lang} ${device}: "${text}" <- ${ids.join(", ")}`);
          }
        }
      }
    }
    expect(clashes).toEqual([]);
  });

  it("gives every appliance type an inline pictogram on its device object", () => {
    // One assertion over the whole generated tree, so a new appliance type can
    // not arrive without its icon: the fixtures cover all seventeen types, and
    // every one of them must end up with a `common.icon` that IS one of the
    // files in `admin/icons`, carried inline as a base64 SVG data URI. Only that
    // form is inlined by the Admin and inherits the row's text colour through
    // `currentColor`; the v1.19.0 path form landed in an `<img>` and was black
    // on both dark themes (measured 2026-09-12).
    const devices = Object.entries(inventory).filter(([, o]) => (o as { type?: string }).type === "device");
    expect(devices.length).toBe(17);

    const iconDir = join(__dirname, "..", "..", "admin", "icons");
    const files = new Map(
      readdirSync(iconDir)
        .filter(f => f.endsWith(".svg"))
        // A Windows checkout carries CRLF; the adapter normalises to LF before
        // embedding, so the comparison does the same.
        .map(f => [readFileSync(join(iconDir, f), "utf8").replace(/\r\n/g, "\n"), f] as const),
    );
    const prefix = "data:image/svg+xml;base64,";

    const offenders: string[] = [];
    for (const [id, o] of devices) {
      const icon = o.common?.icon;
      if (typeof icon !== "string" || !icon.startsWith(prefix)) {
        offenders.push(`${id}: no inline pictogram (type ${String(o.native?.type)})`);
        continue;
      }
      const markup = Buffer.from(icon.slice(prefix.length), "base64").toString("utf8");
      if (!files.has(markup)) {
        offenders.push(`${id}: the inline icon is not one of the files in admin/icons`);
      } else if (!markup.includes("currentColor")) {
        offenders.push(`${id}: ${files.get(markup)} paints nothing in currentColor`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("names every datapoint the text table covers itself, in every language", () => {
    // A cloud name reaches one language, and measured 2026-09-12 not reliably the
    // one that was asked for. Where this adapter has a text, `nameSource` must be
    // "i18n" — a plain string there means a single-language label froze in.
    const plainStrings = Object.entries(inventory)
      .filter(([, o]) => o.native?.nameSource === "i18n")
      .filter(([, o]) => typeof o.common?.name === "string")
      .map(([id]) => id);
    expect(plainStrings).toEqual([]);
  });

  it("gives every datapoint whose BSH key the text table covers the adapter's own name", () => {
    // The rule above only looked at datapoints that ALREADY carry `i18n` — a key
    // of the text table that silently fell back to the cloud's name or a derived
    // label passed it (audit 2026-09-24, E6). This one starts from the table.
    const covered = Object.entries(inventory).filter(
      ([, o]) => typeof o.native?.bshKey === "string" && stateText(o.native.bshKey)?.name !== undefined,
    );
    const offenders = covered.filter(([, o]) => o.native?.nameSource !== "i18n").map(([id]) => id);
    expect(offenders).toEqual([]);
    // Not vacuous: the fixtures over all 17 appliance types reach the table widely.
    expect(covered.length).toBeGreaterThan(100);
  });
});
