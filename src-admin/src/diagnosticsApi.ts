// Fleet master (.consistency-master/src-admin/src/diagnosticsApi.ts) — never edit the copy in an adapter.
//
// The admin side of the `diagnostics` message (adapter side: src/lib/diagnostics/report-jobs.ts, diagnostics report
// standard C3, krobi 2026-10-06). Free of React and socket-client imports so it stays a pure, testable factory: the only dependencies are the
// socket's `sendTo` and its state subscription. The answer shapes come from the adapter side as types only — nothing of
// it reaches the browser bundle.

import { errText } from "../../src/lib/err-text";
import type { Report, ReportDevice } from "../../src/lib/diagnostics/report-jobs";

/** What the start-and-fetch round answers. */
export type DiagnosticsExportResult = Report | { error: string };

/** A state as the admin connection hands it to a subscriber. */
export type StateHandler = (id: string, state: { val?: unknown } | null | undefined) => void;

/** The admin socket's surface the card uses. */
export interface DiagnosticsSocket {
  /** Send a message to the instance and wait for its answer. */
  sendTo(instance: string, command: string, data: unknown): Promise<unknown>;
  /** Watch a state: the admin connection calls the handler with the current value, then on every change. */
  subscribeState?(id: string, handler: StateHandler): Promise<void> | void;
  /** Stop watching. */
  unsubscribeState?(id: string, handler?: StateHandler): void;
}

/** Thrown when the device list could not be fetched — an empty list and a broken call never look alike. */
export class DeviceListError extends Error {}

/** Why the instance gave no answer. */
export type UnavailableReason = "notRunning" | "stopped" | "noAnswer";

/**
 * The instance could not answer: it is not running, it stopped (or restarted) while the card waited, or it
 * did not answer in time. The card turns the reason into its own words.
 */
export class InstanceUnavailableError extends Error {
  /**
   * @param reason why there is no answer
   * @param seconds how long the card waited (for `noAnswer`)
   */
  public constructor(
    public readonly reason: UnavailableReason,
    public readonly seconds = 0,
  ) {
    super(`instance unavailable: ${reason}`);
    this.name = "InstanceUnavailableError";
  }
}

/** How long the card waits for the device list — the adapter answers it from memory at once. */
export const LIST_TIMEOUT_MS = 15_000;

/** How long the card waits for a report — the wait ends long before only when the instance stops. */
export const EXPORT_TIMEOUT_MS = 180_000;

/**
 * How often the card asks whether the report is done. No single answer may take long: the admin's browser
 * connection calls every pending answer with "timeout" after 30 s (admin 8.0.23 `lib/js/socket.io.js`, a callback
 * lives `Date.now() + 3e4`).
 */
export const POLL_INTERVAL_MS = 2_000;

/** The words the admin's browser connection answers with instead of the instance (`lib/js/socket.io.js`). */
const TRANSPORT_WORDS = new Set(["timeout", "disconnected"]);

/** How long the card waits for each answer. */
export interface DiagnosticsTimeouts {
  /** The device list, and each question about a running report. */
  listMs: number;
  /** One report, from the start to the file. */
  exportMs: number;
  /** The pause between two questions about a running report. */
  pollMs?: number;
}

/** The two operations the card drives. */
export interface DiagnosticsApi {
  /** Every device the instance runs, connected or not. */
  listDevices(): Promise<ReportDevice[]>;
  /** Read one device and get its report back. */
  exportReport(device: string): Promise<DiagnosticsExportResult>;
}

/**
 * Whether an export answer carries a report.
 *
 * @param r the answer
 */
export function isReport(r: DiagnosticsExportResult): r is Report {
  return typeof (r as Report).fileName === "string" && typeof (r as Report).content === "string";
}

/**
 * Send one `diagnostics` message to the instance and wait for its answer — but not forever. The admin
 * connection's `sendTo` has no timeout of its own, so a stopped instance left the card at "Loading devices…"
 * for good, and an instance restarted during a report left its button locked. The
 * instance's `alive` state tells at once when it is not running and when it stops while the card waits; the
 * timeout catches what neither shows (an instance that runs but does not answer).
 *
 * @param socket the admin socket
 * @param namespace the instance, e.g. `demo.0`
 * @param data the message
 * @param timeoutMs how long to wait for the answer
 * @returns the answer; rejects with {@link InstanceUnavailableError} or the socket's own error
 */
export async function askInstance(
  socket: DiagnosticsSocket,
  namespace: string,
  data: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const aliveId = `system.adapter.${namespace}.alive`;
  let seenAlive = false;
  let giveUp: (reason: InstanceUnavailableError) => void;
  const unavailable = new Promise<never>((_resolve, reject) => {
    giveUp = reject;
  });
  const onAlive: StateHandler = (_id, state) => {
    if (state?.val === true) {
      seenAlive = true;
      return;
    }
    giveUp(new InstanceUnavailableError(seenAlive ? "stopped" : "notRunning"));
  };
  const timer = setTimeout(
    () => giveUp(new InstanceUnavailableError("noAnswer", Math.round(timeoutMs / 1000))),
    timeoutMs,
  );
  try {
    // A socket without the subscription still gets the answer or the timeout.
    void Promise.resolve(socket.subscribeState?.(aliveId, onAlive)).catch(() => undefined);
  } catch {
    // The same: no watch, the timeout stays.
  }
  try {
    const answer = await Promise.race([socket.sendTo(namespace, "diagnostics", data), unavailable]);
    if (typeof answer === "string" && TRANSPORT_WORDS.has(answer)) {
      // The connection gave up on this answer, not the instance: say so instead of "no report".
      throw new InstanceUnavailableError("noAnswer", Math.round(timeoutMs / 1000));
    }
    return answer;
  } finally {
    clearTimeout(timer);
    socket.unsubscribeState?.(aliveId, onAlive);
  }
}

/**
 * Build the API for one admin socket and instance.
 *
 * @param socket the admin socket
 * @param namespace the instance, e.g. `demo.0`
 * @param timeouts how long to wait for each answer
 */
export function makeDiagnosticsApi(
  socket: DiagnosticsSocket,
  namespace: string,
  timeouts: DiagnosticsTimeouts = { listMs: LIST_TIMEOUT_MS, exportMs: EXPORT_TIMEOUT_MS },
): DiagnosticsApi {
  return {
    async listDevices(): Promise<ReportDevice[]> {
      let answer: unknown;
      try {
        answer = await askInstance(socket, namespace, { action: "list" }, timeouts.listMs);
      } catch (e) {
        throw e instanceof InstanceUnavailableError ? e : new DeviceListError(errText(e));
      }
      const devices = (answer as { devices?: unknown } | null)?.devices;
      if (!Array.isArray(devices)) {
        const error = (answer as { error?: unknown } | null)?.error;
        throw new DeviceListError(typeof error === "string" ? error : "");
      }
      return devices as ReportDevice[];
    },
    async exportReport(device: string): Promise<DiagnosticsExportResult> {
      // Start, then ask until it is done: every answer comes at once (see POLL_INTERVAL_MS).
      const deadline = Date.now() + timeouts.exportMs;
      const giveUp = (): InstanceUnavailableError =>
        new InstanceUnavailableError("noAnswer", Math.round(timeouts.exportMs / 1000));
      const started = await askInstance(socket, namespace, { action: "start", device }, timeouts.listMs);
      const job = (started as { job?: unknown } | null)?.job;
      if (typeof job !== "string") {
        const error = (started as { error?: unknown } | null)?.error;
        return { error: typeof error === "string" ? error : "" };
      }
      for (;;) {
        const wait = Math.min(timeouts.pollMs ?? POLL_INTERVAL_MS, deadline - Date.now());
        if (wait <= 0) {
          throw giveUp();
        }
        await new Promise(resolve => setTimeout(resolve, wait));
        let answer: unknown;
        try {
          answer = await askInstance(socket, namespace, { action: "result", job }, timeouts.listMs);
        } catch (e) {
          if (e instanceof InstanceUnavailableError && e.reason === "noAnswer") {
            // One question lost on the way (the connection's own "timeout"): the report goes on, ask again.
            continue;
          }
          throw e;
        }
        if (answer && typeof answer === "object") {
          if ("pending" in answer) {
            continue;
          }
          if ("gone" in answer) {
            // The instance restarted (its jobs live in memory) or the report was already handed out.
            throw new InstanceUnavailableError("stopped");
          }
          if (isReport(answer as DiagnosticsExportResult) || "error" in answer) {
            return answer as DiagnosticsExportResult;
          }
        }
        return { error: "" };
      }
    },
  };
}
