// Fleet master (.consistency-master/src/lib/diagnostics/report-jobs.ts) — never edit the copy in an adapter.
//
// Diagnostics report standard (krobi 2026-10-06, page "Diagnosebericht — Flottenstandard", C3):
// the admin's `diagnostics` message. `list` names every device, connected or not (DB-03); `start` begins one device's
// report and answers at once with a job; `result` hands the finished report over once. The admin's browser connection
// gives up on every answer after 30 s (admin 8.0.23 `lib/js/socket.io.js`, `Date.now() + 3e4`), and a report may take
// longer — so no answer waits for one. The report lives in memory until the card fetches it, never on disk (DB-01);
// an unfetched one is dropped by the next message after KEEP_MS (no timer). A device that is not connected is never
// read live (DB-03): `readLive` is called for connected devices only, and the report then says so.
// Round 104 (krobi 2026-10-07 20:53, every fleet rule complete and checked in the gate): the frame is the report's own
// — the adapter's body can add to it but never replace a frame field (DB-06) — and it says what the live read did
// (`liveRead`), so the inventory suite can tell a read that reached the device from one that never asked it (DB-02).

import { errText } from "../err-text";
import { reportFileName, reportFrame, type ReportFrame } from "./report-file";

/** Shortest gap after a finished report before the next one of the same device — a double click is not two reports. */
export const REPORT_COOLDOWN_MS = 2_000;

/** How long a finished report waits for the card to fetch it. */
export const REPORT_KEEP_MS = 10 * 60_000;

/** One device as the card lists it. */
export interface ReportDevice {
  /** The device id. */
  value: string;
  /** What the card shows. */
  label: string;
  /** Whether it is connected — an unconnected one gets a report without the live read. */
  connected: boolean;
}

/** A finished report: the file name and the JSON text. */
export interface Report {
  /** The name the browser saves it under. */
  fileName: string;
  /** The report JSON. */
  content: string;
}

/**
 * What the live read did, as the report says it: `read` (it returned something), `nothing` (it returned nothing),
 * `failed` or `not connected` (never asked). The reason of a failure stays in the body the adapter builds — the frame
 * goes out as it is, and an error text can carry an address or a name (DB-04).
 */
export type LiveRead = "read" | "nothing" | "failed" | "not connected";

/** What the card gets when it asks for a started report. */
export type ReportAnswer = { pending: true } | { gone: true } | Report | { error: string };

/** One device as the adapter knows it. */
export interface ReportSourceDevice {
  /** The device id. */
  id: string;
  /** Its display name, when it has one. */
  label?: string;
  /** Whether it is connected right now. */
  connected: boolean;
}

/** What the report body is made of, besides the frame. */
export interface ReportBody {
  /**
   * The device id for the file name, rendered by the same placeholders as the content (`places.text(id)`). A scheme id
   * (model and the last four characters of the unit id, DB-12) stays as it is; an id that falls back to a name, an
   * address or a whole serial becomes its placeholder — the file goes out as the attachment of a public issue, its name
   * is never pseudonymised by anyone else (DB-04, round 105).
   */
  fileId: string;
  /** Everything else the report holds. */
  content: Record<string, unknown>;
}

/** What the adapter hands the jobs: its devices, the live read and the report body. */
export interface ReportSource<L> {
  /** The adapter name, e.g. `demo`. */
  readonly adapter: string;
  /** The adapter version. */
  readonly version: string;
  /** The devices this instance runs right now. */
  devices(): ReportSourceDevice[];
  /**
   * Read one CONNECTED device live; never called for an unconnected one. Rejects when the device answered nothing — a
   * read nobody answered is a failed read, and the report says `failed`, never `read` (round 104, DB-02).
   */
  readLive(id: string): Promise<L>;
  /** Build the report body; `live` is undefined when the device was not connected or the read failed. */
  build(id: string, live: L | undefined, liveError: string | undefined): Promise<ReportBody>;
  /** The adapter log. */
  readonly log: { info(message: string): void; warn(message: string): void };
}

/** The adapter's report jobs: one per device at a time, held in memory until fetched. */
export class ReportJobs<L> {
  private readonly running = new Set<string>();
  private readonly finished = new Map<string, number>();
  private readonly jobs = new Map<string, { device: string; result?: Report | { error: string }; doneAt?: number }>();
  private jobCount = 0;

  /**
   * @param source the adapter's side
   * @param now the clock (injectable for tests)
   */
  public constructor(
    private readonly source: ReportSource<L>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Answer one `diagnostics` message.
   *
   * @param payload `{ action: "list" }`, `{ action: "start", device }` or `{ action: "result", job }`
   * @returns the answer for the card
   */
  public handle(payload: unknown): Promise<unknown> {
    const { action, device, job } = (typeof payload === "object" && payload !== null ? payload : {}) as {
      action?: unknown;
      device?: unknown;
      job?: unknown;
    };
    this.dropUnfetched();
    if (action === "list") {
      return Promise.resolve({ devices: this.list() });
    }
    if (action === "start") {
      return Promise.resolve(this.start(typeof device === "string" ? device : ""));
    }
    if (action === "result") {
      return Promise.resolve(this.result(typeof job === "string" ? job : ""));
    }
    return Promise.resolve({ error: `unknown diagnostics action '${String(action)}'` });
  }

  /**
   * Every device, connected or not — a report is wanted exactly when a device misbehaves.
   *
   * @returns the devices, by label
   */
  public list(): ReportDevice[] {
    return this.source
      .devices()
      .map(d => ({
        value: d.id,
        label: d.label && d.label !== d.id ? `${d.label} (${d.id})` : d.id,
        connected: d.connected,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Begin one device's report and answer at once; a second start while it runs gets the same job.
   *
   * @param deviceId the device id
   * @returns the job, or why there is none
   */
  public start(deviceId: string): { job: string } | { error: string } {
    for (const [id, job] of this.jobs) {
      if (job.device === deviceId && !job.result) {
        return { job: id };
      }
    }
    if (!this.source.devices().some(d => d.id === deviceId)) {
      return { error: `unknown device '${deviceId}'` };
    }
    const id = `${deviceId}#${++this.jobCount}`;
    const job: { device: string; result?: Report | { error: string }; doneAt?: number } = { device: deviceId };
    this.jobs.set(id, job);
    void this.make(deviceId).then(result => {
      job.result = result;
      job.doneAt = this.now();
    });
    return { job: id };
  }

  /**
   * A started report: still pending, gone, or the result — handed over once.
   *
   * @param id the job id `start` answered
   * @returns the answer
   */
  public result(id: string): ReportAnswer {
    const job = this.jobs.get(id);
    if (!job) {
      return { gone: true };
    }
    if (!job.result) {
      return { pending: true };
    }
    this.jobs.delete(id);
    return job.result;
  }

  /** Drop the finished reports nobody fetched within REPORT_KEEP_MS. */
  private dropUnfetched(): void {
    const now = this.now();
    for (const [id, job] of this.jobs) {
      if (job.doneAt !== undefined && now - job.doneAt > REPORT_KEEP_MS) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Make one device's report: the live read only for a connected device, then the adapter's body inside the frame.
   *
   * @param deviceId the device id
   * @returns the report, or why there is none
   */
  private async make(deviceId: string): Promise<Report | { error: string }> {
    const device = this.source.devices().find(d => d.id === deviceId);
    const now = this.now();
    if (!device) {
      return { error: `unknown device '${deviceId}'` };
    }
    if (this.running.has(deviceId) || now - (this.finished.get(deviceId) ?? -Infinity) < REPORT_COOLDOWN_MS) {
      return { error: "a report for this device is being made right now — try again in a moment" };
    }
    this.running.add(deviceId);
    try {
      let live: L | undefined;
      let liveError: string | undefined;
      if (device.connected) {
        try {
          live = await this.source.readLive(deviceId);
        } catch (e) {
          liveError = errText(e);
        }
      }
      const body = await this.source.build(deviceId, live, liveError);
      const made = new Date(this.now());
      const frame: ReportFrame = reportFrame(this.source.adapter, this.source.version, made, device.connected);
      const liveRead: LiveRead = !device.connected
        ? "not connected"
        : liveError !== undefined
          ? "failed"
          : live === undefined || live === null
            ? "nothing"
            : "read";
      const fileName = reportFileName(this.source.adapter, body.fileId, this.source.version, made);
      this.source.log.info(`${deviceId}: diagnostics report ready (${fileName})`);
      return { fileName, content: JSON.stringify({ ...body.content, ...frame, liveRead }, null, 2) };
    } catch (e) {
      const reason = errText(e);
      this.source.log.warn(`${deviceId}: diagnostics report failed: ${reason}`);
      return { error: `report failed: ${reason}` };
    } finally {
      this.running.delete(deviceId);
      this.finished.set(deviceId, this.now());
    }
  }
}
