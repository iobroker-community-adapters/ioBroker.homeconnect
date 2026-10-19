import { describe, expect, it } from "vitest";
import { REPORT_README, reportFileName, reportFrame } from "./report-file";

describe("reportFileName", () => {
  it("names the file <adapter>_<device-id>_v<version>_<date>_<time>.json in UTC", () => {
    expect(reportFileName("demo", "lamp-cf73", "3.3.0", new Date("2026-10-06T15:33:41.123Z"))).toBe(
      "demo_lamp-cf73_v3.3.0_2026-10-06_153341.json",
    );
  });

  it("keeps only letters, digits and dashes of the id", () => {
    expect(reportFileName("demo-two", "serial-1-…AA22 x/y", "1.0.0", new Date(0))).toBe(
      "demo-two_serial-1-AA22_x_y_v1.0.0_1970-01-01_000000.json",
    );
    expect(reportFileName("demo", "…", "1.0.0", new Date(0))).toBe("demo_device_v1.0.0_1970-01-01_000000.json");
  });
});

describe("reportFrame", () => {
  it("starts every report the same way", () => {
    const frame = reportFrame("demo", "1.2.3", new Date(0), false);
    expect(frame).toMatchObject({
      readMe: REPORT_README,
      adapter: "iobroker.demo",
      version: "1.2.3",
      exportedAt: "1970-01-01T00:00:00.000Z",
      connected: false,
    });
    expect(frame.runtime.node).toBe(process.version);
  });

  it("keeps the readMe to one short sentence pair", () => {
    expect(REPORT_README.length).toBeLessThanOrEqual(120);
  });
});
