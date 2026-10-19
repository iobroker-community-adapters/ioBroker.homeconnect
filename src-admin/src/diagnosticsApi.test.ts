import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DeviceListError,
  InstanceUnavailableError,
  isReport,
  makeDiagnosticsApi,
  type DiagnosticsSocket,
  type StateHandler,
} from "./diagnosticsApi";

/**
 * A socket whose instance never answers, with the instance's `alive` state under the test's control.
 *
 * @param alive the value the subscription reports first (undefined: it reports nothing)
 */
function silentInstance(alive?: boolean): {
  socket: DiagnosticsSocket;
  setAlive(val: boolean): void;
  watchers: Set<StateHandler>;
} {
  const watchers = new Set<StateHandler>();
  return {
    watchers,
    setAlive: val => watchers.forEach(handler => handler("system.adapter.demo.0.alive", { val })),
    socket: {
      sendTo: () => new Promise(() => {}),
      subscribeState: (id, handler) => {
        expect(id).toBe("system.adapter.demo.0.alive");
        watchers.add(handler);
        // Like the admin connection: the current value first, after a round trip.
        return alive === undefined ? undefined : Promise.resolve().then(() => handler(id, { val: alive }));
      },
      unsubscribeState: (_id, handler) => {
        watchers.delete(handler!);
      },
    },
  };
}

function socketReturning(value: unknown): { socket: DiagnosticsSocket; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    socket: {
      sendTo: (instance: string, command: string, data: unknown) => {
        calls.push([instance, command, data]);
        return Promise.resolve(value);
      },
    },
  };
}

/** The card asks every few milliseconds here, not every two seconds. */
const FAST = { listMs: 15_000, exportMs: 180_000, pollMs: 5 };

/**
 * A socket that answers one message after the other with the given answers.
 *
 * @param answers the answers, in order
 */
function sequence(answers: unknown[]): DiagnosticsSocket {
  return { sendTo: () => Promise.resolve(answers.shift()) };
}

describe("makeDiagnosticsApi", () => {
  it("asks the instance for its devices", async () => {
    const { socket, calls } = socketReturning({ devices: [{ value: "lamp-2b3c", label: "RX", connected: true }] });
    const devices = await makeDiagnosticsApi(socket, "demo.1").listDevices();
    expect(calls[0]).toEqual(["demo.1", "diagnostics", { action: "list" }]);
    expect(devices).toHaveLength(1);
  });

  it("tells a broken list call apart from an empty list", async () => {
    await expect(makeDiagnosticsApi(socketReturning(undefined).socket, "demo.0").listDevices()).rejects.toBeInstanceOf(
      DeviceListError,
    );
    const failing: DiagnosticsSocket = { sendTo: () => Promise.reject(new Error("no connection")) };
    await expect(makeDiagnosticsApi(failing, "demo.0").listDevices()).rejects.toThrow("no connection");
    expect(await makeDiagnosticsApi(socketReturning({ devices: [] }).socket, "demo.0").listDevices()).toEqual([]);
  });

  it("starts the selected device's report, asks for it and hands the answer back", async () => {
    const answers: unknown[] = [{ job: "lamp-2b3c#1" }, { pending: true }, { fileName: "f.json", content: "{}" }];
    const calls: unknown[][] = [];
    const socket: DiagnosticsSocket = {
      sendTo: (instance, command, data) => {
        calls.push([instance, command, data]);
        return Promise.resolve(answers.shift());
      },
    };
    const res = await makeDiagnosticsApi(socket, "demo.0", FAST).exportReport("lamp-2b3c");
    expect(calls).toEqual([
      ["demo.0", "diagnostics", { action: "start", device: "lamp-2b3c" }],
      ["demo.0", "diagnostics", { action: "result", job: "lamp-2b3c#1" }],
      ["demo.0", "diagnostics", { action: "result", job: "lamp-2b3c#1" }],
    ]);
    expect(isReport(res) && res.fileName).toBe("f.json");
  });

  it("turns a shapeless answer into an error, never into an empty download", async () => {
    const res = await makeDiagnosticsApi(socketReturning("nonsense").socket, "demo.0", FAST).exportReport("x");
    expect(isReport(res)).toBe(false);
    const late = await makeDiagnosticsApi(sequence([{ job: "j" }, "nonsense"]), "demo.0", FAST).exportReport("x");
    expect(isReport(late)).toBe(false);
  });

  it("hands on the error the adapter answers when it starts no report", async () => {
    const res = await makeDiagnosticsApi(
      socketReturning({ error: "unknown device 'x'" }).socket,
      "demo.0",
      FAST,
    ).exportReport("x");
    expect(res).toEqual({ error: "unknown device 'x'" });
  });

  it("says the instance stopped when it no longer knows the report (a restart empties its memory)", async () => {
    const report = makeDiagnosticsApi(sequence([{ job: "j" }, { gone: true }]), "demo.0", FAST).exportReport("x");
    await expect(report).rejects.toEqual(new InstanceUnavailableError("stopped"));
  });

  it("hands on the error the adapter answers instead of a list", async () => {
    const api = makeDiagnosticsApi(socketReturning({ error: "diagnostics failed: boom" }).socket, "demo.0");
    await expect(api.listDevices()).rejects.toThrow(new DeviceListError("diagnostics failed: boom"));
  });
});

// `sendTo` of the admin connection never times out — a stopped instance kept the card
// loading for good, a restart during a report kept its button locked.
describe("askInstance (through the API)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("says at once that the instance is not running, instead of waiting for its answer", async () => {
    const { socket, watchers } = silentInstance(false);
    const list = makeDiagnosticsApi(socket, "demo.0").listDevices();
    await expect(list).rejects.toEqual(new InstanceUnavailableError("notRunning"));
    expect(watchers.size).toBe(0);
  });

  it("ends a report's wait when the instance stops (or restarts) in the middle of it", async () => {
    const { socket, setAlive, watchers } = silentInstance(true);
    const report = makeDiagnosticsApi(socket, "demo.0").exportReport("lamp-2b3c");
    await Promise.resolve();
    await Promise.resolve();
    setAlive(false);
    await expect(report).rejects.toMatchObject({ reason: "stopped" });
    expect(watchers.size).toBe(0);
  });

  it("gives up after the timeout when the instance runs but does not answer", async () => {
    vi.useFakeTimers();
    const { socket, watchers } = silentInstance(true);
    const report = makeDiagnosticsApi(socket, "demo.0", { listMs: 15_000, exportMs: 180_000 }).exportReport("x");
    const verdict = expect(report).rejects.toEqual(new InstanceUnavailableError("noAnswer", 15));
    await vi.advanceTimersByTimeAsync(15_000);
    await verdict;
    expect(watchers.size).toBe(0);
  });

  it("gives up after the report's deadline when the instance answers 'pending' for good", async () => {
    vi.useFakeTimers();
    const socket: DiagnosticsSocket = {
      sendTo: (_i, _c, data) =>
        Promise.resolve((data as { action: string }).action === "start" ? { job: "j" } : { pending: true }),
    };
    const report = makeDiagnosticsApi(socket, "demo.0", { listMs: 15_000, exportMs: 180_000 }).exportReport("x");
    const verdict = expect(report).rejects.toEqual(new InstanceUnavailableError("noAnswer", 180));
    await vi.advanceTimersByTimeAsync(180_000);
    await verdict;
  });

  it("gives up after the timeout on a socket without a state subscription", async () => {
    vi.useFakeTimers();
    const socket: DiagnosticsSocket = { sendTo: () => new Promise(() => {}) };
    const list = makeDiagnosticsApi(socket, "demo.0", { listMs: 15_000, exportMs: 180_000 }).listDevices();
    const verdict = expect(list).rejects.toMatchObject({ reason: "noAnswer", seconds: 15 });
    await vi.advanceTimersByTimeAsync(15_000);
    await verdict;
  });

  it("stops watching the instance once the answer is there", async () => {
    const watchers = new Set<StateHandler>();
    const socket: DiagnosticsSocket = {
      sendTo: () => Promise.resolve({ devices: [] }),
      subscribeState: (_id, handler) => {
        watchers.add(handler);
      },
      unsubscribeState: (_id, handler) => {
        watchers.delete(handler!);
      },
    };
    expect(await makeDiagnosticsApi(socket, "demo.0").listDevices()).toEqual([]);
    expect(watchers.size).toBe(0);
  });
});

// The admin's browser connection (admin 8.0.23 `lib/js/socket.io.js`) keeps a callback `Date.now() + 3e4` and calls it
// with "timeout" on its next 5-second sweep — a report in one answer failed after 33 s. This socket keeps that rule.
describe("the admin's 30-second rule", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * An instance whose report takes `reportMs`, behind a connection that gives up on every answer after 30 s.
   *
   * @param reportMs how long the report takes
   */
  function adminConnection(reportMs: number): DiagnosticsSocket {
    let readyAt = Number.POSITIVE_INFINITY;
    const report = { fileName: "demo_lamp.json", content: "{}" };
    const instance = (data: { action: string }): Promise<unknown> => {
      if (data.action === "export") {
        return new Promise(resolve => setTimeout(() => resolve(report), reportMs));
      }
      if (data.action === "start") {
        readyAt = Date.now() + reportMs;
        return Promise.resolve({ job: "j" });
      }
      return Promise.resolve(Date.now() >= readyAt ? report : { pending: true });
    };
    return {
      sendTo: (_i, _c, data) =>
        Promise.race([
          instance(data as { action: string }),
          new Promise(resolve => setTimeout(() => resolve("timeout"), 30_000)),
        ]),
    };
  }

  it("gets a report that takes 45 s", async () => {
    vi.useFakeTimers();
    const report = makeDiagnosticsApi(adminConnection(45_000), "demo.0").exportReport("lamp-2b3c");
    await vi.advanceTimersByTimeAsync(50_000);
    expect(isReport(await report) && ((await report) as { fileName: string }).fileName).toBe("demo_lamp.json");
  });

  it("asks again when the connection loses one question while the report runs", async () => {
    const report = { fileName: "f.json", content: "{}" };
    const res = await makeDiagnosticsApi(sequence([{ job: "j" }, "timeout", report]), "demo.0", FAST).exportReport("x");
    expect(res).toEqual(report);
  });

  it("says that the connection gave up, never that the report failed", async () => {
    vi.useFakeTimers();
    const socket: DiagnosticsSocket = { sendTo: () => Promise.resolve("timeout") };
    const list = makeDiagnosticsApi(socket, "demo.0").listDevices();
    await expect(list).rejects.toMatchObject({ reason: "noAnswer" });
  });
});

describe("isReport", () => {
  it("takes only an answer with a file name and a content as a report", () => {
    expect(isReport({ fileName: "demo_lamp.json", content: "{}" })).toBe(true);
    expect(isReport({ fileName: "demo_lamp.json" } as never)).toBe(false);
    expect(isReport({ error: "x" })).toBe(false);
  });
});

describe("the rest of the round trip", () => {
  it("still gets the answer when the alive watch cannot be set up", async () => {
    const socket: DiagnosticsSocket = {
      sendTo: () => Promise.resolve({ devices: [] }),
      subscribeState: () => Promise.reject(new Error("no subscription")),
    };
    expect(await makeDiagnosticsApi(socket, "demo.0").listDevices()).toEqual([]);
  });

  it("names no report when the answer is neither a report nor an error", async () => {
    const socket: DiagnosticsSocket = {
      sendTo: (_i, _c, data) =>
        Promise.resolve((data as { action: string }).action === "start" ? { job: "j1" } : { something: 1 }),
    };
    const api = makeDiagnosticsApi(socket, "demo.0", { listMs: 1_000, exportMs: 5_000, pollMs: 1 });
    expect(await api.exportReport("lamp")).toEqual({ error: "" });
  });

  it("stops asking when a question about the report fails for another reason", async () => {
    const socket: DiagnosticsSocket = {
      sendTo: (_i, _c, data) =>
        (data as { action: string }).action === "start"
          ? Promise.resolve({ job: "j1" })
          : Promise.reject(new Error("socket closed")),
    };
    const api = makeDiagnosticsApi(socket, "demo.0", { listMs: 1_000, exportMs: 5_000, pollMs: 1 });
    await expect(api.exportReport("lamp")).rejects.toThrow("socket closed");
  });
});
