import React from "react";
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

// Round 157 (master audit M28): the stand-in hands the key back, so a key the card uses that DIAGNOSTICS_TEXTS lacks
// passed every test while the admin showed the raw key — every key asked for is collected and checked after the file.
const { used } = vi.hoisted(() => ({ used: new Set<string>() }));
vi.mock("@iobroker/gui-components", () => ({
  I18n: {
    t: (key: string, ...args: unknown[]) => {
      used.add(key);
      return [key, ...args].join(" ");
    },
    extendTranslations: vi.fn(),
  },
}));

import { InstanceUnavailableError } from "./diagnosticsApi";
import { DiagnosticsPanel, failureText, issueFormUrl } from "./DiagnosticsPanel";
import { DIAGNOSTICS_TEXTS } from "./diagnosticsTexts";

afterAll(() => {
  expect(used.size).toBeGreaterThan(0);
  expect([...used].filter(key => !(key in DIAGNOSTICS_TEXTS.en)).sort()).toEqual([]);
});
// Round 157 (master audit M29): a spy (the download click) went on into every later test of the file
afterEach(() => {
  vi.restoreAllMocks();
});

/** What every card here is mounted with besides its socket. */
const MOUNT = {
  namespace: "demo.0",
  repository: "https://github.com/owner/ioBroker.demo",
  tabIds: ["_main", "_expert"],
};

/** The card asks every few milliseconds here, not every two seconds. */
const FAST = { listMs: 15_000, exportMs: 180_000, pollMs: 5 };

/**
 * An instance that lists its devices, starts a report as job `j1` and hands back `answers.export` for it.
 *
 * @param answers the device list and the report (or error)
 * @param answers.list the answer to `list`
 * @param answers.export the answer to `result`
 */
function socket(answers: { list: unknown; export?: unknown }): { sendTo: ReturnType<typeof vi.fn> } {
  return {
    sendTo: vi.fn((_instance: string, _command: string, data: { action: string }) =>
      Promise.resolve(data.action === "list" ? answers.list : data.action === "start" ? { job: "j1" } : answers.export),
    ),
  };
}

describe("DiagnosticsPanel", () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:report");
    URL.revokeObjectURL = vi.fn();
  });

  it("pre-selects the only device and downloads the report under the adapter's file name", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const s = socket({
      list: { devices: [{ value: "lamp-2b3c", label: "Lamp", connected: true }] },
      export: { fileName: "demo_lamp-2b3c_v3.3.0.json", content: "{}" },
    });
    render(
      <DiagnosticsPanel
        socket={s}
        {...MOUNT}
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    const done = await screen.findByTestId("diag-done");
    expect(done).toHaveTextContent("diag_done demo_lamp-2b3c_v3.3.0.json");
    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "https://github.com/owner/ioBroker.demo/issues/new?template=device-support.yml",
    );
    expect(click).toHaveBeenCalled();
    expect(s.sendTo).toHaveBeenCalledWith("demo.0", "diagnostics", { action: "start", device: "lamp-2b3c" });
    expect(s.sendTo).toHaveBeenCalledWith("demo.0", "diagnostics", { action: "result", job: "j1" });
  });

  it("shows that the report is being generated, with the seconds counting, until the answer comes", async () => {
    let done = false;
    const s = {
      sendTo: vi.fn((_i: string, _c: string, data: { action: string }) =>
        Promise.resolve(
          data.action === "list"
            ? { devices: [{ value: "lamp-2b3c", label: "Lamp", connected: true }] }
            : data.action === "start"
              ? { job: "j1" }
              : done
                ? { error: "x" }
                : { pending: true },
        ),
      ),
    };
    render(
      <DiagnosticsPanel
        socket={s}
        {...MOUNT}
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    // Round 157 (master audit M26): the card's count runs on a steered clock (its interval and Date) — before, the test
    // waited the real second, up to 2.5 s, and a busy runner showed 2 at its first look
    vi.useFakeTimers({ toFake: ["setInterval", "Date"] });
    try {
      fireEvent.click(button);
      expect(await screen.findByTestId("diag-generating")).toHaveTextContent("diag_generating");
      expect(screen.getByTestId("diag-export")).toBeDisabled();
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId("diag-elapsed")).toHaveTextContent(/^diag_elapsed 1$/);
    } finally {
      vi.useRealTimers();
    }
    done = true;
    await waitFor(() => expect(screen.queryByTestId("diag-generating")).toBeNull());
  });

  it("shows the adapter's error instead of a download", async () => {
    const s = socket({
      list: { devices: [{ value: "lamp-2b3c", label: "Lamp", connected: false }] },
      export: { error: "a report for this device is being made right now" },
    });
    render(
      <DiagnosticsPanel
        socket={s}
        {...MOUNT}
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-error")).toHaveTextContent("being made right now");
  });

  it("says when the instance runs no device", async () => {
    render(
      <DiagnosticsPanel
        socket={socket({ list: { devices: [] } })}
        {...MOUNT}
      />,
    );
    expect(await screen.findByTestId("diag-no-devices")).toBeInTheDocument();
  });

  it("does not show a broken list as an empty one", async () => {
    render(
      <DiagnosticsPanel
        socket={socket({ list: undefined })}
        {...MOUNT}
      />,
    );
    expect(await screen.findByTestId("diag-list-failed")).toBeInTheDocument();
  });

  it("shows the error the adapter answers instead of its device list", async () => {
    render(
      <DiagnosticsPanel
        socket={socket({ list: { error: "diagnostics failed: boom" } })}
        {...MOUNT}
      />,
    );
    expect(await screen.findByTestId("diag-list-failed")).toHaveTextContent("diagnostics failed: boom");
  });

  // A stopped instance left the card at "Loading devices…" for good.
  it("says that the instance is not running instead of loading forever", async () => {
    const s = {
      sendTo: vi.fn(() => new Promise(() => {})),
      subscribeState: vi.fn((id: string, handler: (id: string, state: { val: unknown } | null) => void) => {
        void Promise.resolve().then(() => handler(id, { val: false }));
      }),
      unsubscribeState: vi.fn(),
    };
    render(
      <DiagnosticsPanel
        socket={s}
        {...MOUNT}
        timeouts={FAST}
      />,
    );
    expect(await screen.findByTestId("diag-list-failed")).toHaveTextContent("diag_notRunning");
    expect(s.subscribeState).toHaveBeenCalledWith("system.adapter.demo.0.alive", expect.any(Function));
  });

  // A restart during a report left the button locked.
  it("frees the button and says why when the instance stops during a report", async () => {
    let alive: (val: boolean) => void = () => {};
    const s = {
      sendTo: vi.fn((_i: string, _c: string, data: { action: string }) =>
        data.action === "list"
          ? Promise.resolve({ devices: [{ value: "lamp-2b3c", label: "Lamp", connected: true }] })
          : new Promise(() => {}),
      ),
      subscribeState: vi.fn((id: string, handler: (id: string, state: { val: unknown } | null) => void) => {
        alive = val => handler(id, { val });
        handler(id, { val: true });
      }),
      unsubscribeState: vi.fn(),
    };
    render(
      <DiagnosticsPanel
        socket={s}
        {...MOUNT}
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-generating")).toBeInTheDocument();
    alive(false);
    expect(await screen.findByTestId("diag-error")).toHaveTextContent("diag_stopped");
    await waitFor(() => expect(screen.getByTestId("diag-export")).not.toBeDisabled());
    expect(screen.queryByTestId("diag-generating")).toBeNull();
  });

  it("forgets the remembered tab when it mounts and when it unmounts", async () => {
    localStorage.setItem("App.demo", "_expert");
    const view = render(
      <DiagnosticsPanel
        socket={socket({ list: { devices: [] } })}
        {...MOUNT}
      />,
    );
    expect(localStorage.getItem("App.demo")).toBeNull();
    await screen.findByTestId("diag-no-devices");
    localStorage.setItem("App.demo", "_expert");
    view.unmount();
    expect(localStorage.getItem("App.demo")).toBeNull();
  });

  it("registers its own words, the list of what the report contains and the privacy box", async () => {
    // The words are registered once per page (module state), so an earlier test has already done it; vitest 5 also clears
    // every mock's calls before each test (clearMocks). A fresh module graph makes this test see its own registration.
    vi.resetModules();
    const { I18n: freshI18n } = await import("@iobroker/gui-components");
    const { DiagnosticsPanel: FreshPanel } = await import("./DiagnosticsPanel");
    render(
      <FreshPanel
        socket={socket({ list: { devices: [{ value: "lamp-2b3c", label: "Lamp", connected: false }] } })}
        {...MOUNT}
      />,
    );
    expect(await screen.findByTestId("diag-intro")).toHaveTextContent("diag_contains");
    expect(screen.getByTestId("diag-privacy")).toHaveTextContent("diag_privacyMarkers");
    expect(screen.getByTestId("diag-privacy")).toHaveTextContent("diag_privacyMemory");
    expect(freshI18n.extendTranslations).toHaveBeenCalledWith(
      expect.objectContaining({ diag_export: expect.any(String) }),
      "de",
    );
  });

  it("marks an unconnected device and says the report goes without a live read", async () => {
    render(
      <DiagnosticsPanel
        socket={socket({ list: { devices: [{ value: "lamp-2b3c", label: "Lamp", connected: false }] } })}
        {...MOUNT}
      />,
    );
    expect(await screen.findByText("diag_offlineHint")).toBeInTheDocument();
  });

  it("lets the user pick one of several devices", async () => {
    const s = socket({
      list: {
        devices: [
          { value: "a", label: "A", connected: true },
          { value: "b", label: "B", connected: false },
        ],
      },
      export: { error: "" },
    });
    render(
      <DiagnosticsPanel
        socket={s}
        {...MOUNT}
        timeouts={FAST}
      />,
    );
    const button = await screen.findByTestId("diag-export");
    expect(button).toBeDisabled();
    fireEvent.mouseDown(within(screen.getByTestId("diag-device-select")).getByRole("combobox"));
    fireEvent.click(await screen.findByText("B — diag_notConnected"));
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    expect(await screen.findByTestId("diag-error")).toHaveTextContent("diag_exportFailed");
  });
});

describe("DiagnosticsPanel with a new socket", () => {
  it("drops the device list or the failure of the socket it no longer uses", async () => {
    let answer: (value: unknown) => void = () => undefined;
    let fail: (reason: Error) => void = () => undefined;
    const late = { sendTo: () => new Promise(resolve => (answer = resolve)) };
    const lateFail = { sendTo: () => new Promise((_resolve, reject) => (fail = reject)) };
    const fresh = socket({ list: { devices: [{ value: "new-1", label: "New", connected: true }] } });
    const view = render(
      <DiagnosticsPanel
        socket={late}
        {...MOUNT}
      />,
    );
    view.rerender(
      <DiagnosticsPanel
        socket={fresh}
        {...MOUNT}
      />,
    );
    await screen.findByTestId("diag-export");
    // Round 157 (master audit M27): the late answer is delivered inside act, and the new socket's list is proven still
    // there — after a bare setTimeout(0) a state change coming later went unseen
    await act(async () => {
      answer({ devices: [] });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("diag-no-devices")).toBeNull();
    expect(screen.getByTestId("diag-export")).toBeInTheDocument();
    view.rerender(
      <DiagnosticsPanel
        socket={lateFail}
        {...MOUNT}
      />,
    );
    view.rerender(
      <DiagnosticsPanel
        socket={fresh}
        {...MOUNT}
      />,
    );
    await screen.findByTestId("diag-export");
    await act(async () => {
      fail(new Error("too late"));
      await Promise.resolve();
    });
    expect(screen.queryByTestId("diag-list-failed")).toBeNull();
    expect(screen.getByTestId("diag-export")).toBeInTheDocument();
  });
});

describe("issueFormUrl", () => {
  it("opens the device form directly, a trailing slash or not", () => {
    expect(issueFormUrl("https://github.com/owner/ioBroker.demo/")).toBe(
      "https://github.com/owner/ioBroker.demo/issues/new?template=device-support.yml",
    );
  });
});

describe("failureText", () => {
  it("names a failure by its own words, and falls back when it has none", () => {
    expect(failureText(new Error("boom"), "fallback")).toBe("boom");
    expect(failureText(new Error(""), "fallback")).toBe("fallback");
    expect(failureText("not an error", "fallback")).toBe("fallback");
    expect(failureText(new InstanceUnavailableError("noAnswer", 15), "fallback")).toBe("diag_noAnswer 15");
  });
});
