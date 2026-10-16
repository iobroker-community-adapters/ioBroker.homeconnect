import { describe, it, expect, vi } from "vitest";
import { categorize, restLogKey } from "./log-dedup";
import { LogOnce } from "./log-once";

describe("categorize", () => {
  it("maps status bands to categories", () => {
    expect(categorize(0)).toBe("net");
    expect(categorize(401)).toBe("auth");
    expect(categorize(403)).toBe("auth");
    expect(categorize(429)).toBe("rate");
    expect(categorize(500)).toBe("http-5xx");
    expect(categorize(503)).toBe("http-5xx");
    expect(categorize(404)).toBe("http-4xx");
    expect(categorize(409)).toBe("http-4xx");
    expect(categorize(200)).toBe("other");
  });
});

describe("restLogKey (2026-09-15, F10)", () => {
  it("collapses the appliance id and a trailing item key to the endpoint kind", () => {
    const H = "GET /api/homeappliances";
    expect(restLogKey(`${H}/BOSCH-HCS06COM1-1234/settings/BSH.Common.Setting.PowerState`)).toBe(`${H}/*/settings/*`);
    expect(restLogKey(`${H}/015090396331005775/programs/available/Dishcare.Dishwasher.Program.Eco50`)).toBe(
      `${H}/*/programs/available/*`,
    );
    expect(restLogKey(`PUT ${H.slice(4)}/HA-1/programs/selected/options/BSH.Common.Option.StartInRelative`)).toBe(
      `PUT ${H.slice(4)}/*/programs/selected/options/*`,
    );
    expect(restLogKey(`PUT ${H.slice(4)}/HA-1/commands/BSH.Common.Command.PauseProgram`)).toBe(
      `PUT ${H.slice(4)}/*/commands/*`,
    );
    // Paths without an item key keep their shape; the list endpoint stays as is.
    expect(restLogKey(`${H}/HA-1/status`)).toBe(`${H}/*/status`);
    expect(restLogKey(`${H}/HA-1/programs/selected`)).toBe(`${H}/*/programs/selected`);
    expect(restLogKey(H)).toBe(H);
  });

  it("dedups the same failure across appliances and keys, and recovers once", () => {
    // One 503 during the start-up used to warn once per path — 25 lines for
    // one outage — and said it succeeded 25 times when it cleared.
    const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const d = new LogOnce(log);
    const fail = (source: string): boolean => d.report(restLogKey(source), `${source} failed`, { kind: "http-5xx" });
    expect(fail("GET /api/homeappliances/HA-1/settings/A")).toBe(true);
    expect(fail("GET /api/homeappliances/HA-1/settings/B")).toBe(false);
    expect(fail("GET /api/homeappliances/HA-2/settings/A")).toBe(false);
    // A different kind still gets its own warning.
    expect(fail("GET /api/homeappliances/HA-2/status")).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(2);
    const back = (source: string): boolean => d.recovered(restLogKey(source), `${source} succeeded.`);
    expect(back("GET /api/homeappliances/HA-2/settings/B")).toBe(true);
    expect(back("GET /api/homeappliances/HA-1/settings/A")).toBe(false);
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
