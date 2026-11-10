import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { I18n } from "@iobroker/gui-components";
import type { ConfigGenericProps } from "@iobroker/json-config";

import SignIn, { isRefusal, userCodeOf } from "./SignIn";

/** A promise with its resolve/reject handles, for answers that arrive late. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Socket {
  getState: ReturnType<typeof vi.fn>;
  subscribeState: ReturnType<typeof vi.fn>;
  unsubscribeState: ReturnType<typeof vi.fn>;
  sendTo: ReturnType<typeof vi.fn>;
}

/** The parts of the panel the tests drive (private members, reached through a cast). */
interface Panel {
  componentDidMount(): Promise<void>;
  componentWillUnmount(): void;
  runTest(): Promise<void>;
  runAction(command: "requestSignIn" | "resetLogin"): Promise<void>;
  openAppPage(): Promise<void>;
  finishAppSignIn(): Promise<void>;
  renderItem(): React.JSX.Element;
  setState: ReturnType<typeof vi.fn>;
  state: Record<string, unknown>;
}

function makePanel(socket: Socket, options: { data?: Record<string, unknown>; alive?: boolean } = {}): Panel {
  const props = {
    oContext: { adapterName: "homeconnect", instance: 0, socket },
    schema: {},
    data: options.data ?? {},
    attr: "signIn",
    themeType: "light",
    alive: options.alive ?? false,
  } as unknown as ConfigGenericProps;
  const panel = new SignIn(props) as unknown as Panel;
  panel.setState = vi.fn();
  return panel;
}

function makeSocket(): Socket {
  return {
    getState: vi.fn(() => Promise.resolve({ val: "" })),
    subscribeState: vi.fn(() => Promise.resolve()),
    unsubscribeState: vi.fn(),
    sendTo: vi.fn(() => Promise.resolve({ result: "ok" })),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** The part of the panel's state a test sets before it renders. */
type PanelState = { url?: string; signedIn?: boolean; connected?: boolean; lastError?: string; pasted?: string };

/**
 * A panel in the given sign-in state, rendered once (its setState is a spy, so nothing re-renders).
 *
 * @param data the instance settings the panel reads (`accessMode`)
 * @param state the sign-in state to render
 * @returns the rendered panel
 */
function renderPanel(data: Record<string, unknown>, state: PanelState): Panel {
  const panel = makePanel(makeSocket(), { data, alive: true });
  panel.state = { ...panel.state, ...state };
  render(panel.renderItem());
  return panel;
}

/** The sign-in page the adapter publishes in the app access — a code in it must never show as a device-flow code. */
const APP_LINK =
  "https://api.home-connect.com/security/oauth/authorize?client_id=X&redirect_uri=https%3A%2F%2Fqr.home-connect.com%2Fauthorize%2Fprod%2F&user_code=ABCD-1234";

describe("SignIn — 2026-11-10: the Home Connect app access (beta)", () => {
  it("app mode shows the paste field and no user code", () => {
    renderPanel({ accessMode: "app" }, { url: APP_LINK });
    expect(screen.getByTestId("hc-app-paste")).toBeInTheDocument();
    expect(screen.getByTestId("hc-app-link")).toHaveAttribute("href", APP_LINK);
    expect(screen.queryByTestId("hc-user-code")).toBeNull();
    expect(screen.queryByText(I18n.t("hc_signInPrompt"))).toBeNull();
  });

  it('app mode derives "sign-in needed" from the states', () => {
    renderPanel({ accessMode: "app" }, { url: "", signedIn: false, lastError: "Unknown" });
    expect(screen.getByText(I18n.t("hc_appSignInNeeded"))).toBeInTheDocument();
    expect(screen.getByTestId("hc-app-open")).toBeEnabled();
    expect(screen.queryByTestId("hc-request-link")).toBeNull();
    expect(screen.queryByTestId("hc-app-paste")).toBeNull();
  });

  it("a refusal in app mode points to a new sign-in, never to the developer portal", () => {
    renderPanel({ accessMode: "app" }, { url: "", signedIn: false, lastError: "invalid_grant: Refresh token expired" });
    expect(screen.getByText(I18n.t("hc_appProblem"))).toBeInTheDocument();
    expect(screen.getByText(I18n.t("hc_problemAnswer", "invalid_grant: Refresh token expired"))).toBeInTheDocument();
    expect(screen.queryByText(I18n.t("hc_problem_loginRevoked"))).toBeNull();
  });

  it("the open button asks appSignInLink and opens the answer in a new tab", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(Promise.resolve({ result: APP_LINK }));
    const tab = { opener: {} as unknown };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const panel = makePanel(socket, { data: { accessMode: "app" }, alive: true });
    await panel.openAppPage();
    expect(socket.sendTo).toHaveBeenCalledWith("homeconnect.0", "appSignInLink", {});
    expect(open).toHaveBeenCalledWith(APP_LINK, "_blank");
    expect(tab.opener).toBeNull();
    expect(panel.setState).toHaveBeenCalledWith({ url: APP_LINK });
    expect(panel.setState).toHaveBeenLastCalledWith({ acting: false });
  });

  it("a blocked tab still leaves the page as a link in the panel", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(Promise.resolve({ result: APP_LINK }));
    vi.spyOn(window, "open").mockReturnValue(null);
    const panel = makePanel(socket, { data: { accessMode: "app" }, alive: true });
    await panel.openAppPage();
    expect(panel.setState).toHaveBeenCalledWith({ url: APP_LINK });
  });

  it("the finish button sends appSignInComplete with the pasted address", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(Promise.resolve({ result: "Signed in to Home Connect." }));
    const panel = makePanel(socket, { data: { accessMode: "app" }, alive: true });
    panel.state = { ...panel.state, pasted: "https://qr.home-connect.com/authorize/prod/?code=abc&state=s" };
    await panel.finishAppSignIn();
    expect(socket.sendTo).toHaveBeenCalledWith("homeconnect.0", "appSignInComplete", {
      address: "https://qr.home-connect.com/authorize/prod/?code=abc&state=s",
    });
    expect(panel.setState).toHaveBeenCalledWith({
      actionResult: { ok: true, text: "Signed in to Home Connect." },
      pasted: "",
    });
    expect(panel.setState).toHaveBeenLastCalledWith({ acting: false });
  });

  it("an error answer is shown verbatim and keeps what was pasted", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(Promise.resolve({ error: "no sign-in link is open — request a new one" }));
    const panel = makePanel(socket, { data: { accessMode: "app" }, alive: true });
    panel.state = { ...panel.state, pasted: "https://qr.home-connect.com/authorize/prod/?code=abc" };
    await panel.finishAppSignIn();
    expect(panel.setState).toHaveBeenCalledWith({
      actionResult: { ok: false, text: "no sign-in link is open — request a new one" },
    });
    expect(panel.setState).not.toHaveBeenCalledWith(expect.objectContaining({ pasted: "" }));
  });

  it("an open-page refusal is shown verbatim and opens no tab", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(
      Promise.resolve({ error: "The instance runs with the developer access — save the settings first." }),
    );
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const panel = makePanel(socket, { data: { accessMode: "app" }, alive: true });
    await panel.openAppPage();
    expect(open).not.toHaveBeenCalled();
    expect(panel.setState).toHaveBeenCalledWith({
      actionResult: { ok: false, text: "The instance runs with the developer access — save the settings first." },
    });
    expect(panel.setState).toHaveBeenLastCalledWith({ acting: false });
  });

  it("typing into the paste field keeps a draft; finishing waits for something pasted", () => {
    const panel = renderPanel({ accessMode: "app" }, { url: APP_LINK, pasted: "" });
    expect(screen.getByTestId("hc-app-finish")).toBeDisabled();
    const input = screen.getByTestId("hc-app-paste").querySelector("input");
    expect(input).not.toBeNull();
    fireEvent.change(input!, { target: { value: "https://qr.home-connect.com/authorize/prod/?code=abc" } });
    expect(panel.setState).toHaveBeenCalledWith({ pasted: "https://qr.home-connect.com/authorize/prod/?code=abc" });
  });

  it("an answer after the close renders nothing", async () => {
    const socket = makeSocket();
    const late = deferred<{ result: string }>();
    socket.sendTo.mockReturnValue(late.promise);
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const panel = makePanel(socket, { data: { accessMode: "app" }, alive: true });
    const opening = panel.openAppPage();
    panel.setState.mockClear();
    panel.componentWillUnmount();
    late.resolve({ result: APP_LINK });
    await opening;
    expect(panel.setState).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("the developer access renders as before: the code, no paste field", () => {
    renderPanel({}, { url: "https://api.home-connect.com/security/oauth/device_verify?user_code=ABCD-1234" });
    expect(screen.getByTestId("hc-user-code")).toHaveTextContent("ABCD-1234");
    expect(screen.queryByTestId("hc-app-paste")).toBeNull();
    expect(screen.queryByTestId("hc-app-open")).toBeNull();
  });
});

describe("SignIn — 2026-09-24: nothing happens after the panel closed", () => {
  it("reads that finish after the close neither render nor subscribe", async () => {
    const socket = makeSocket();
    const late = deferred<{ val: unknown }>();
    socket.getState.mockReturnValue(late.promise);
    const panel = makePanel(socket);
    const mounted = panel.componentDidMount();
    panel.componentWillUnmount();
    late.resolve({ val: "https://example.invalid/verify" });
    await mounted;
    expect(panel.setState).not.toHaveBeenCalled();
    expect(socket.subscribeState).not.toHaveBeenCalled();
  });

  it("reads that fail after the close do not subscribe either", async () => {
    const socket = makeSocket();
    const late = deferred<{ val: unknown }>();
    socket.getState.mockReturnValue(late.promise);
    const panel = makePanel(socket);
    const mounted = panel.componentDidMount();
    panel.componentWillUnmount();
    late.reject(new Error("socket closed"));
    await mounted;
    expect(socket.subscribeState).not.toHaveBeenCalled();
  });

  it("a failed read on an open panel still subscribes", async () => {
    const socket = makeSocket();
    socket.getState.mockReturnValue(Promise.reject(new Error("no such state")));
    const panel = makePanel(socket);
    await panel.componentDidMount();
    expect(socket.subscribeState).toHaveBeenCalledTimes(4);
  });

  it("reads on an open panel render and subscribe", async () => {
    const socket = makeSocket();
    const panel = makePanel(socket);
    await panel.componentDidMount();
    expect(panel.setState).toHaveBeenCalledWith({ url: "", connected: false, signedIn: false, lastError: "" });
    expect(socket.subscribeState).toHaveBeenCalledTimes(4);
  });

  it("a test answer after the close renders nothing", async () => {
    const socket = makeSocket();
    const late = deferred<{ result: string }>();
    socket.sendTo.mockReturnValue(late.promise);
    const panel = makePanel(socket);
    const test = panel.runTest();
    panel.setState.mockClear();
    panel.componentWillUnmount();
    late.resolve({ result: "Connected." });
    await test;
    expect(panel.setState).not.toHaveBeenCalled();
  });

  it("a test that fails after the close renders nothing", async () => {
    const socket = makeSocket();
    const late = deferred<never>();
    socket.sendTo.mockReturnValue(late.promise);
    const panel = makePanel(socket);
    const test = panel.runTest();
    panel.setState.mockClear();
    panel.componentWillUnmount();
    late.reject(new Error("socket closed"));
    await test;
    expect(panel.setState).not.toHaveBeenCalled();
  });
});

describe("SignIn — 2026-09-24: the connection test always ends", () => {
  it("shows the adapter's answer and leaves the testing state", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(Promise.resolve({ result: "Connected: 3 appliances." }));
    const panel = makePanel(socket);
    await panel.runTest();
    expect(panel.setState).toHaveBeenCalledWith({ testResult: { ok: true, text: "Connected: 3 appliances." } });
    expect(panel.setState).toHaveBeenLastCalledWith({ testing: false });
  });

  it("shows the adapter's error verbatim", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(Promise.resolve({ error: "Not signed in." }));
    const panel = makePanel(socket);
    await panel.runTest();
    expect(panel.setState).toHaveBeenCalledWith({ testResult: { ok: false, text: "Not signed in." } });
  });

  it("a failing socket shows the error text", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(Promise.reject(new Error("socket closed")));
    const panel = makePanel(socket);
    await panel.runTest();
    expect(panel.setState).toHaveBeenCalledWith({ testResult: { ok: false, text: "socket closed" } });
    expect(panel.setState).toHaveBeenLastCalledWith({ testing: false });
  });

  it("no answer within 70 s says so instead of testing forever", async () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(new Promise(() => undefined));
    const panel = makePanel(socket);
    const test = panel.runTest();
    await vi.advanceTimersByTimeAsync(69_999);
    expect(panel.setState).not.toHaveBeenCalledWith({ testing: false });
    await vi.advanceTimersByTimeAsync(1);
    await test;
    expect(panel.setState).toHaveBeenCalledWith({ testResult: { ok: false, text: I18n.t("hc_noAnswer") } });
    expect(panel.setState).toHaveBeenLastCalledWith({ testing: false });
  });
});

describe("SignIn — 2026-09-26: the code, the refusal and the sign-in actions", () => {
  it("reads the code out of the sign-in link", () => {
    expect(userCodeOf("https://api.home-connect.com/security/oauth/device_verify?user_code=ABCD-1234")).toBe(
      "ABCD-1234",
    );
    expect(userCodeOf("https://api.home-connect.com/security/oauth/device_verify")).toBeUndefined();
    expect(userCodeOf("not a url")).toBeUndefined();
    expect(userCodeOf("")).toBeUndefined();
  });

  it("shows a refusal only when there is one — not while all is well or nothing was asked yet", () => {
    expect(isRefusal("unauthorized_client: Invalid client id")).toBe(true);
    expect(isRefusal("")).toBe(false);
    expect(isRefusal("Unknown")).toBe(false);
    expect(isRefusal("  ")).toBe(false);
  });

  it("reads and follows the last sign-in problem", async () => {
    const socket = makeSocket();
    socket.getState.mockImplementation((id: string) =>
      Promise.resolve({ val: id.endsWith("auth.lastError") ? "invalid_client" : "" }),
    );
    const panel = makePanel(socket);
    await panel.componentDidMount();
    expect(panel.setState).toHaveBeenCalledWith(expect.objectContaining({ lastError: "invalid_client" }));
    expect(socket.subscribeState).toHaveBeenCalledWith("homeconnect.0.auth.lastError", expect.any(Function));
    panel.componentWillUnmount();
    expect(socket.unsubscribeState).toHaveBeenCalledWith("homeconnect.0.auth.lastError", expect.any(Function));
  });

  it("asks the adapter for a new link and shows its answer", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(Promise.resolve({ result: "A new sign-in link was requested." }));
    const panel = makePanel(socket);
    await panel.runAction("requestSignIn");
    expect(socket.sendTo).toHaveBeenCalledWith("homeconnect.0", "requestSignIn", {});
    expect(panel.setState).toHaveBeenCalledWith({ acting: true, actionResult: null, confirmReset: false });
    expect(panel.setState).toHaveBeenCalledWith({
      actionResult: { ok: true, text: "A new sign-in link was requested." },
    });
    expect(panel.setState).toHaveBeenLastCalledWith({ acting: false });
  });

  it("shows the adapter's error for a reset it cannot do", async () => {
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(
      Promise.resolve({ error: "No Client ID configured — enter it above and save first." }),
    );
    const panel = makePanel(socket);
    await panel.runAction("resetLogin");
    expect(socket.sendTo).toHaveBeenCalledWith("homeconnect.0", "resetLogin", {});
    expect(panel.setState).toHaveBeenCalledWith({
      actionResult: { ok: false, text: "No Client ID configured — enter it above and save first." },
    });
  });

  it("an action whose answer arrives after the close renders nothing", async () => {
    const socket = makeSocket();
    const late = deferred<{ result: string }>();
    socket.sendTo.mockReturnValue(late.promise);
    const panel = makePanel(socket);
    const action = panel.runAction("requestSignIn");
    panel.setState.mockClear();
    panel.componentWillUnmount();
    late.resolve({ result: "A new sign-in link was requested." });
    await action;
    expect(panel.setState).not.toHaveBeenCalled();
  });

  it("an action with no answer within 70 s says so", async () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    socket.sendTo.mockReturnValue(new Promise(() => undefined));
    const panel = makePanel(socket);
    const action = panel.runAction("resetLogin");
    await vi.advanceTimersByTimeAsync(70_000);
    await action;
    expect(panel.setState).toHaveBeenCalledWith({ actionResult: { ok: false, text: I18n.t("hc_noAnswer") } });
    expect(panel.setState).toHaveBeenLastCalledWith({ acting: false });
  });
});
