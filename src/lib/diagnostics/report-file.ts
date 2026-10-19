// Fleet master (.consistency-master/src/lib/diagnostics/report-file.ts) — never edit the copy in an adapter.
//
// Diagnostics report standard (krobi 2026-10-06, page "Diagnosebericht — Flottenstandard"): one file name for every
// adapter (DB-12) and a very short readMe (DB-06).

/** The readMe every report carries — one sentence, nothing over-explained. */
export const REPORT_README =
  "Diagnostics report for a GitHub issue. Placeholders (address-1, name-1, …) are stable inside this file only.";

/**
 * The file name the browser saves a report under: `<adapter>_<device-id>_v<version>_<date>_<time>.json`, date and
 * time in UTC. The device id is the one the REPORT shows (a placeholder where the real id would give something away).
 *
 * @param adapter the adapter name, e.g. `demo`
 * @param deviceId the device id as the report shows it
 * @param version the adapter version
 * @param now when the report was made
 * @returns the file name
 */
export function reportFileName(adapter: string, deviceId: string, version: string, now: Date): string {
  const iso = now.toISOString();
  const day = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, "");
  const id = deviceId.replace(/…/g, "").replace(/[^a-z0-9-]+/gi, "_") || "device";
  return `${adapter}_${id}_v${version}_${day}_${time}.json`;
}

/** The part every report starts with. */
export interface ReportFrame {
  /** What the file is, in one sentence. */
  readMe: string;
  /** `iobroker.<adapter>`. */
  adapter: string;
  /** The adapter version. */
  version: string;
  /** When the report was made (ISO, UTC). */
  exportedAt: string;
  /** Node and platform of the host. */
  runtime: { node: string; platform: string };
  /** Whether the device was connected; an unconnected one was not read live (DB-03). */
  connected: boolean;
}

/**
 * The start of a report.
 *
 * @param adapter the adapter name
 * @param version the adapter version
 * @param now when the report was made
 * @param connected whether the device was connected
 * @returns the frame
 */
export function reportFrame(adapter: string, version: string, now: Date, connected: boolean): ReportFrame {
  return {
    readMe: REPORT_README,
    adapter: `iobroker.${adapter}`,
    version,
    exportedAt: now.toISOString(),
    runtime: { node: process.version, platform: `${process.platform} ${process.arch}` },
    connected,
  };
}
