// Core decision H-06 (accepted 2026-10-15): an empty leftover object under an old appliance id (an object without a type)
// is removed by the adapter itself at start; this is no deletion because of an outage. krobi 2026-09-29 22:26, his choice
// "Weg A: aufräumen (Empfohlen)" on the leftovers such as homeconnect.0.sx87tx02ce-60.settings.powerState.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ObjectMirror } from "../lib/object-mirror";

describe("H-06 empty leftovers are removed at start", () => {
  it("finds the objects without a type in the own namespace, and only those", () => {
    const mirror = new ObjectMirror("homeconnect.0");
    mirror.load([
      { id: "homeconnect.0.sx87tx02ce-60.settings.powerState", value: { common: {} } },
      { id: "homeconnect.0.sx87tx02ce-5775", value: { type: "device", common: {} } },
      { id: "homeconnect.0.sx87tx02ce-5775.settings.powerState", value: { type: "state", common: {} } },
    ]);
    expect(mirror.untyped()).toEqual(["homeconnect.0.sx87tx02ce-60.settings.powerState"]);
  });

  it("deletes them in the start chain, before priming, reading nothing on them", () => {
    // The wiring in main: the list is taken from the start-up read, and the leftover step deletes each id.
    const main = readFileSync(join(process.cwd(), "src", "main.ts"), "utf8");
    expect(main).toContain("this.untypedAtStart = this.objectMirror.untyped();");
    const steps = main.slice(main.indexOf("const steps: Array<[string, () => Promise<unknown>]> = ["));
    const leftover = steps.indexOf('["leftover cleanup", () => this.dropUntypedObjects()]');
    expect(leftover).toBeGreaterThan(0);
    expect(leftover).toBeLessThan(steps.indexOf('["priming", () => sync.primeFromObjects()]'));
    const drop = main.slice(main.indexOf("private async dropUntypedObjects(): Promise<void> {"));
    expect(drop.slice(0, drop.indexOf("\n  }\n"))).toContain(
      "for (const id of this.untypedAtStart) {\n      await this.delObjectAsync(id);",
    );
  });
});
