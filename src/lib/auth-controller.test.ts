import { describe, it, expect } from "vitest";
import { AuthController, type AuthPort, SLOW_DOWN_STEP_MS, AUTH_RETRY_MS } from "./auth-controller";
import { HomeConnectAuth, type FormPostResult, type StoredToken } from "./oauth";

const TOKEN_BODY = { access_token: "AT", refresh_token: "RT", expires_in: 86_400, scope: "Monitor Control" };
const DEVICE_BODY = {
  device_code: "DC",
  user_code: "1234",
  verification_uri: "https://verify",
  verification_uri_complete: "https://verify?code=1234",
  interval: 5,
  expires_in: 600,
};

const ok = (body: unknown): FormPostResult => ({ status: 200, ok: true, body });
const fail = (status: number, body: unknown): FormPostResult => ({ status, ok: false, body });

interface Harness {
  ctl: AuthController;
  timers: Array<{ cb: () => void; ms: number; handle: object; interval: boolean }>;
  logs: Array<{ level: string; msg: string }>;
  clock: { t: number };
  calls: Array<{ path: string; form: Record<string, string> }>;
  port: FakeAuthPort;
}

/** A recording in-memory AuthPort — no adapter, no network, injected timers + clock. */
class FakeAuthPort implements AuthPort {
  refreshToken: string | undefined;
  readonly savedTokens: StoredToken[] = [];
  readonly urls: string[] = [];
  readonly connected: boolean[] = [];
  readonly notifications: string[] = [];
  signedIn = 0;

  constructor(
    private readonly timers: Array<{ cb: () => void; ms: number; handle: object; interval: boolean }>,
    private readonly logs: Array<{ level: string; msg: string }>,
    private readonly clock: { t: number },
  ) {}

  readonly log = {
    debug: (msg: string) => this.logs.push({ level: "debug", msg }),
    info: (msg: string) => this.logs.push({ level: "info", msg }),
    warn: (msg: string) => this.logs.push({ level: "warn", msg }),
    error: (msg: string) => this.logs.push({ level: "error", msg }),
    silly: (msg: string) => this.logs.push({ level: "silly", msg }),
  } as unknown as ioBroker.Logger;

  loadRefreshToken(): Promise<string | undefined> {
    return Promise.resolve(this.refreshToken);
  }
  /** Make the next writes fail — the object database refusing a rotated token. */
  saveFails = false;
  saveToken(token: StoredToken): Promise<void> {
    if (this.saveFails) {
      return Promise.reject(new Error("objects db not writable"));
    }
    this.savedTokens.push(token);
    return Promise.resolve();
  }
  setVerificationUrl(url: string): Promise<void> {
    this.urls.push(url);
    return Promise.resolve();
  }
  setConnected(connected: boolean): Promise<void> {
    this.connected.push(connected);
    return Promise.resolve();
  }
  notify(message: string): void {
    this.notifications.push(message);
  }
  /** Every `auth.lastError` write, in order. */
  readonly problems: string[] = [];
  setProblem(text: string): Promise<void> {
    this.problems.push(text);
    return Promise.resolve();
  }
  /** How often the stored login was cleared. */
  cleared = 0;
  clearStoredLogin(): Promise<void> {
    this.cleared++;
    this.refreshToken = undefined;
    return Promise.resolve();
  }
  onSignedIn(): Promise<void> {
    this.signedIn++;
    return Promise.resolve();
  }
  setTimer(cb: () => void, ms: number): unknown {
    const handle = {};
    this.timers.push({ cb, ms, handle, interval: false });
    return handle;
  }
  clearTimer(handle: unknown): void {
    const i = this.timers.findIndex(t => t.handle === handle);
    if (i >= 0) {
      this.timers.splice(i, 1);
    }
  }
  setIntervalTimer(cb: () => void, ms: number): unknown {
    const handle = {};
    this.timers.push({ cb, ms, handle, interval: true });
    return handle;
  }
  clearIntervalTimer(handle: unknown): void {
    this.clearTimer(handle);
  }
  now = (): number => this.clock.t;
}

/**
 * Build a controller with a queued-response OAuth transport and fake timers.
 *
 * @param results the queued form-POST results, consumed in call order
 * @returns the harness pieces
 */
function harness(results: FormPostResult[]): Harness {
  const clock = { t: 1_700_000_000_000 };
  const calls: Array<{ path: string; form: Record<string, string> }> = [];
  let i = 0;
  const auth = new HomeConnectAuth(
    { clientId: "cid", clientSecret: "sec", baseUrl: "https://api.home-connect.com" },
    (path, form) => {
      calls.push({ path, form });
      const r = results[i++];
      if (!r) {
        throw new Error("harness: no more queued results");
      }
      return Promise.resolve(r);
    },
    () => clock.t,
  );
  const timers: Array<{ cb: () => void; ms: number; handle: object; interval: boolean }> = [];
  const logs: Array<{ level: string; msg: string }> = [];
  const port = new FakeAuthPort(timers, logs, clock);
  return { ctl: new AuthController(auth, port), timers, logs, clock, calls, port };
}

/**
 * Fire the most recently scheduled one-shot timer (the pending poll/retry).
 *
 * @param h Harness holding the captured timers
 */
function firePending(h: Harness): void {
  const t = [...h.timers].reverse().find(x => !x.interval);
  if (!t) {
    throw new Error("no pending one-shot timer");
  }
  h.timers.splice(h.timers.indexOf(t), 1);
  t.cb();
}

/** Let the async chains settle. */
const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5));

describe("AuthController start-up", () => {
  it("reuses the stored login and wires up the adapter", async () => {
    const h = harness([ok(TOKEN_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(h.ctl.accessToken).toBe("AT");
    expect(h.port.savedTokens).toHaveLength(1);
    expect(h.port.signedIn).toBe(1);
    expect(h.port.connected).toContain(true);
    expect(h.timers.some(t => t.interval)).toBe(true); // refresh check armed
  });

  it("drops to the device flow when the stored login is revoked (invalid_grant)", async () => {
    const h = harness([fail(400, { error: "invalid_grant" }), ok(DEVICE_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(h.port.urls).toContain("https://verify?code=1234");
    expect(h.port.notifications).toHaveLength(1);
    expect(h.timers.at(-1)?.ms).toBe(5_000); // device-flow poll pending
  });

  it("keeps the login and retries after a transient refresh failure", async () => {
    const h = harness([fail(500, {})]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(h.calls).toHaveLength(1); // no device_authorization call
    expect(h.timers.at(-1)?.ms).toBe(AUTH_RETRY_MS);
    expect(h.port.notifications).toHaveLength(0);
  });

  it("doubles the start-up retry delay per consecutive failure", async () => {
    const h = harness([fail(500, {}), fail(500, {}), fail(500, {})]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(h.timers.at(-1)?.ms).toBe(AUTH_RETRY_MS); // 30 s
    h.clock.t += 31_000;
    firePending(h);
    await flush();
    expect(h.timers.at(-1)?.ms).toBe(AUTH_RETRY_MS * 2); // 60 s
    h.clock.t += 61_000;
    firePending(h);
    await flush();
    expect(h.timers.at(-1)?.ms).toBe(AUTH_RETRY_MS * 4); // 120 s
  });
});

describe("AuthController device flow", () => {
  it("signs in once the user approved and clears the verification URL", async () => {
    const h = harness([ok(DEVICE_BODY), ok(TOKEN_BODY)]);
    await h.ctl.start();
    firePending(h);
    await flush();
    expect(h.ctl.accessToken).toBe("AT");
    expect(h.port.signedIn).toBe(1);
    expect(h.port.urls.at(-1)).toBe(""); // cleared after approval
  });

  it("grows the poll interval on a slow_down answer", async () => {
    const h = harness([ok(DEVICE_BODY), fail(400, { error: "slow_down" })]);
    await h.ctl.start();
    expect(h.timers.at(-1)?.ms).toBe(5_000);
    firePending(h);
    await flush();
    expect(h.timers.at(-1)?.ms).toBe(5_000 + SLOW_DOWN_STEP_MS);
  });

  it("requests a fresh sign-in link when the code expires unused", async () => {
    const h = harness([ok(DEVICE_BODY), ok({ ...DEVICE_BODY, user_code: "5678" })]);
    await h.ctl.start();
    h.clock.t += 601_000; // past expires_in = 600 s
    firePending(h);
    await flush();
    expect(h.port.urls.at(-2)).toBe(""); // stale link cleared…
    expect(h.port.urls.at(-1)).toBe("https://verify?code=1234"); // …fresh link published
    expect(h.timers.at(-1)?.ms).toBe(5_000); // polling again
    expect(h.port.notifications).toHaveLength(1); // announced only once per episode
  });

  it("requests a fresh sign-in link after a terminal poll error (denied)", async () => {
    const h = harness([ok(DEVICE_BODY), fail(400, { error: "access_denied" }), ok(DEVICE_BODY)]);
    await h.ctl.start();
    firePending(h);
    await flush();
    expect(h.port.urls.at(-2)).toBe("");
    expect(h.port.urls.at(-1)).toBe("https://verify?code=1234");
    expect(h.port.notifications).toHaveLength(1);
  });
});

describe("AuthController runtime refresh", () => {
  it("starts a fresh sign-in when the login is revoked while running", async () => {
    const h = harness([ok(TOKEN_BODY), fail(400, { error: "invalid_grant" }), ok(DEVICE_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(await h.ctl.refreshNow()).toBe(false);
    await flush();
    expect(h.ctl.accessToken).toBeUndefined(); // dead token dropped
    expect(h.port.connected).toContain(false);
    expect(h.port.urls).toContain("https://verify?code=1234"); // new sign-in link is out
  });

  it("warns once about a transient refresh failure, then drops to debug, and keeps the token", async () => {
    const h = harness([ok(TOKEN_BODY), fail(500, {}), fail(500, {})]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(await h.ctl.refreshNow()).toBe(false);
    h.clock.t += 31_000; // past the 30 s back-off
    expect(await h.ctl.refreshNow()).toBe(false);
    const failures = h.logs.filter(l => l.msg.includes("token refresh failed"));
    expect(failures.map(l => l.level)).toEqual(["warn", "debug"]);
    expect(h.ctl.accessToken).toBe("AT"); // login kept for the next attempt
  });

  it("backs off between failed refresh attempts (token endpoint has its own quota)", async () => {
    const h = harness([ok(TOKEN_BODY), fail(500, {}), fail(500, {})]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(await h.ctl.refreshNow()).toBe(false);
    const callsAfterFirst = h.calls.length;
    // Within the back-off window: no new hit on the token endpoint.
    expect(await h.ctl.refreshNow()).toBe(false);
    expect(h.calls.length).toBe(callsAfterFirst);
    // After the window: a fresh attempt goes out.
    h.clock.t += 31_000;
    expect(await h.ctl.refreshNow()).toBe(false);
    expect(h.calls.length).toBe(callsAfterFirst + 1);
  });

  it("shares one in-flight refresh across concurrent callers", async () => {
    const h = harness([ok(TOKEN_BODY), ok({ ...TOKEN_BODY, access_token: "AT2" })]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    const [a, b] = await Promise.all([h.ctl.refreshNow(), h.ctl.refreshNow()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(h.calls).toHaveLength(2); // one start refresh + ONE shared runtime refresh
    expect(h.ctl.accessToken).toBe("AT2");
  });

  it("stop() cancels all pending timers", async () => {
    const h = harness([ok(DEVICE_BODY)]);
    await h.ctl.start();
    expect(h.timers.length).toBeGreaterThan(0);
    h.ctl.stop();
    expect(h.timers).toHaveLength(0);
  });
});

describe("AuthController teardown", () => {
  it("stops the retry chain after unload", async () => {
    const h = harness([{ status: 500, ok: false, body: null }]);
    h.port.refreshToken = "RT";
    await h.ctl.start();
    const pending = [...h.timers].reverse().find(t => !t.interval);
    expect(pending).toBeDefined();

    h.ctl.stop();
    // stop() clears the timers, but a timer already fired (or one the host runs
    // during teardown) must not restart the whole sign-in machinery.
    h.calls.length = 0;
    pending?.cb();
    await flush();
    expect(h.calls).toHaveLength(0);
  });

  it("does not announce a connection for a sign-in that finishes after the stop", async () => {
    // A device-flow approval or a token refresh that was in flight when the host
    // stopped the adapter still arrives here. Reporting "connected" then raises
    // `auth.signedIn` again AFTER the teardown wrote it false — the sign-in panel
    // would show a stopped instance as signed in until the next start.
    // A normal signed-in run, then the stop, then a refresh that finishes late.
    const h = harness([ok(TOKEN_BODY), ok(TOKEN_BODY)]);
    h.port.refreshToken = "RT";
    await h.ctl.start();
    h.ctl.stop();
    const connectedBefore = h.port.connected.length;
    const savedBefore = h.port.savedTokens.length;

    await h.ctl.refreshNow();

    // The rotated token MUST still be stored (decision 22: the cloud kills the
    // previous one the moment it hands out a new one) — only the announcement
    // is dropped.
    expect(h.port.savedTokens.length).toBeGreaterThan(savedBefore);
    expect(h.port.connected.slice(connectedBefore)).toEqual([]);
  });

  it("stops the device-flow poll after unload", async () => {
    const h = harness([
      { status: 200, ok: true, body: { device_code: "DC", user_code: "1234", verification_uri: "https://v" } },
    ]);
    await h.ctl.start();
    const poll = [...h.timers].reverse().find(t => !t.interval);
    h.ctl.stop();
    h.calls.length = 0;
    poll?.cb();
    await flush();
    // A poll surviving the unload keeps talking to the token endpoint from a
    // stopped instance — and its answer would revive the whole controller.
    expect(h.calls).toHaveLength(0);
  });

  it("arms exactly one refresh timer, however often it signs in", async () => {
    const h = harness([
      { status: 200, ok: true, body: TOKEN_BODY },
      { status: 200, ok: true, body: TOKEN_BODY },
    ]);
    h.port.refreshToken = "RT";
    await h.ctl.start();
    expect(h.timers.filter(t => t.interval)).toHaveLength(1);

    // A second sign-in episode (a revoked login that came back, a re-start).
    await h.ctl.start();
    await flush();
    // A second interval per sign-in doubles the refresh traffic and leaks a timer
    // that stop() can no longer reach.
    expect(h.timers.filter(t => t.interval)).toHaveLength(1);
  });

  it("does not start a sign-in from a revoked token after unload", async () => {
    const h = harness([
      { status: 200, ok: true, body: TOKEN_BODY },
      { status: 400, ok: false, body: { error: "invalid_grant" } },
    ]);
    h.port.refreshToken = "RT";
    await h.ctl.start();
    h.ctl.stop();
    h.calls.length = 0;

    // A 401 from a REST call already in flight lands here after the teardown.
    await h.ctl.refreshNow();
    await flush();
    // The refresh itself is the only call that may go out; a device flow started
    // from a stopped instance publishes a sign-in link nobody can complete.
    expect(h.calls).toHaveLength(1);
    expect(h.port.notifications).toHaveLength(0);
  });

  it("refreshes on the timer only when the token is actually near expiry", async () => {
    const h = harness([{ status: 200, ok: true, body: TOKEN_BODY }]);
    h.port.refreshToken = "RT";
    await h.ctl.start();
    const tick = h.timers.find(t => t.interval);
    h.calls.length = 0;

    tick?.cb();
    await flush();
    // TOKEN_BODY is fresh: refreshing on every tick would burn the token
    // endpoint's daily quota for nothing.
    expect(h.calls).toHaveLength(0);
  });
});

describe("AuthController remaining paths", () => {
  it("announces the sign-in once per episode and only renews the link on debug", async () => {
    const h = harness([
      { status: 200, ok: true, body: DEVICE_BODY },
      { status: 400, ok: false, body: { error: "expired_token" } },
      { status: 200, ok: true, body: { ...DEVICE_BODY, user_code: "5678" } },
    ]);
    await h.ctl.start();
    expect(h.port.notifications).toHaveLength(1);

    // The code expired → a fresh link. Notifying again per renewal would nag the
    // user every five minutes for the same outstanding action.
    firePending(h);
    await flush();
    expect(h.port.notifications).toHaveLength(1);
    // The code changes every five minutes: only debug names it, the notification and the info
    // line point at the settings where the current one always stands.
    expect(h.logs.filter(l => l.level === "debug" && l.msg.startsWith("sign-in link:")).map(l => l.msg)).toEqual([
      "sign-in link: https://verify code 1234",
      "sign-in link: https://verify code 5678",
    ]);
    expect(h.port.notifications[0]).not.toContain("1234");
    expect(h.logs.filter(l => l.level === "info").map(l => l.msg)).toEqual([
      "Home Connect sign-in required — open the adapter settings and follow the sign-in link shown there.",
    ]);
    // An expired code is no refusal — nothing is published as a problem.
    expect(h.port.problems).toEqual([]);
  });

  it("keeps polling while the user has not approved yet", async () => {
    const h = harness([
      { status: 200, ok: true, body: DEVICE_BODY },
      { status: 400, ok: false, body: { error: "authorization_pending" } },
      { status: 200, ok: true, body: TOKEN_BODY },
    ]);
    await h.ctl.start();
    firePending(h);
    await flush();
    // A pending answer must reschedule at the SAME interval — treating it as an
    // error would restart the flow and invalidate the code the user is typing.
    const next = [...h.timers].reverse().find(t => !t.interval);
    expect(next?.ms).toBe(5000);

    firePending(h);
    await flush();
    expect(h.port.signedIn).toBe(1);
  });

  it("refreshes on the timer when the token is actually near expiry", async () => {
    const h = harness([
      { status: 200, ok: true, body: { ...TOKEN_BODY, expires_in: 60 } },
      { status: 200, ok: true, body: TOKEN_BODY },
    ]);
    h.port.refreshToken = "RT";
    await h.ctl.start();
    h.calls.length = 0;

    h.timers.find(t => t.interval)?.cb();
    await flush();
    // An access token dies at its expiry (24 h at Home Connect, 60 s here); the periodic check is what keeps the
    // stream and the REST calls alive without the user noticing.
    expect(h.calls).toHaveLength(1);
    expect(h.port.savedTokens).toHaveLength(2);
  });

  it("does not try to refresh before there is a login", async () => {
    const h = harness([]);
    await expect(h.ctl.refreshNow()).resolves.toBe(false);
    expect(h.calls).toHaveLength(0);
  });

  it("says when the refresh works again after a failing spell", async () => {
    const h = harness([
      { status: 200, ok: true, body: TOKEN_BODY },
      { status: 500, ok: false, body: null },
      { status: 200, ok: true, body: TOKEN_BODY },
    ]);
    h.port.refreshToken = "RT";
    await h.ctl.start();
    await h.ctl.refreshNow();
    expect(h.logs.some(l => l.level === "warn" && l.msg.includes("token refresh failed"))).toBe(true);

    h.clock.t += 60_000; // past the back-off window
    await h.ctl.refreshNow();
    // Without the recovery line a user who saw the warning has no way to tell
    // the adapter got well again.
    expect(h.logs.some(l => l.level === "info" && l.msg.includes("refresh succeeded again"))).toBe(true);
  });

  it("reports a failing background task instead of dying on an unhandled rejection", async () => {
    const h = harness([
      { status: 200, ok: true, body: DEVICE_BODY },
      { status: 200, ok: true, body: TOKEN_BODY },
    ]);
    await h.ctl.start();
    h.port.setVerificationUrl = () => Promise.reject(new Error("states db down"));

    firePending(h);
    await flush();
    // The poll runs from a timer callback: an escaping rejection is an unhandled
    // rejection and takes the adapter process down.
    expect(h.logs.some(l => l.level === "error" && l.msg.includes("auth task failed"))).toBe(true);
  });
});

describe("AuthController device-flow start failure", () => {
  it("retries later instead of giving up when the sign-in cannot be started", async () => {
    const h = harness([
      { status: 401, ok: false, body: { error: "invalid_client" } },
      { status: 200, ok: true, body: DEVICE_BODY },
    ]);
    await h.ctl.start();
    // Wrong credentials, or the token host unreachable. Giving up here leaves a
    // dead instance that only a manual restart revives.
    expect(h.logs.some(l => l.level === "warn" && l.msg.includes("Could not start the Home Connect sign-in"))).toBe(
      true,
    );
    const retry = [...h.timers].reverse().find(t => !t.interval);
    expect(retry?.ms).toBe(300_000);

    firePending(h);
    await flush();
    expect(h.port.urls).toContain("https://verify?code=1234");
  });
});

describe("AuthController connection flag", () => {
  it("keeps the instance signed in through a transient refresh failure", async () => {
    const h = harness([ok(TOKEN_BODY), fail(500, {})]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    h.port.connected.length = 0;
    expect(await h.ctl.refreshNow()).toBe(false);
    // The access token is still valid until its expiry; a 500 from the token
    // endpoint is not a lost login. Reporting "not connected" for it would be a
    // false alarm on every cloud hiccup.
    expect(h.port.connected).toEqual([]);
    expect(h.ctl.accessToken).toBe("AT");
  });

  it("reports the login gone only when it was revoked", async () => {
    const h = harness([ok(TOKEN_BODY), fail(400, { error: "invalid_grant" }), ok(DEVICE_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    h.port.connected.length = 0;
    await h.ctl.refreshNow();
    await flush();
    expect(h.port.connected).toEqual([false]);
  });
});

describe("AuthController token persistence", () => {
  it("reports a rotated token it could not store as a lost login, not as a kept one", async () => {
    // Home Connect rotates the refresh token: the moment the new one arrives the
    // old one is dead. A write that fails therefore leaves the ONLY usable key in
    // memory while the database keeps one the cloud will never accept again.
    const h = harness([ok({ ...TOKEN_BODY, access_token: "AT2", refresh_token: "NEW" })]);
    h.port.refreshToken = "OLD";
    h.port.saveFails = true;

    await h.ctl.start();

    expect(h.port.savedTokens).toEqual([]);
    // It must be said out loud — silence here costs the user a new device-flow
    // sign-in at the next restart.
    const errors = h.logs.filter(l => l.level === "error").map(l => l.msg);
    expect(errors.some(m => m.includes("could not be stored"))).toBe(true);
    // And it must NOT be reported as a refresh failure with the login kept —
    // that is the opposite of what happened.
    expect(h.logs.some(l => l.msg.includes("login kept"))).toBe(false);
    // The adapter keeps working: this run has a valid token.
    expect(h.ctl.accessToken).toBe("AT2");
  });

  it("writes the token again as soon as the database accepts it", async () => {
    const h = harness([ok({ ...TOKEN_BODY, access_token: "AT2", refresh_token: "NEW" })]);
    h.port.refreshToken = "OLD";
    h.port.saveFails = true;
    await h.ctl.start();
    expect(h.port.savedTokens).toEqual([]);

    // The database recovers; the periodic check retries the write.
    h.port.saveFails = false;
    const periodic = h.timers.find(t => t.interval);
    expect(periodic).toBeDefined();
    periodic?.cb();
    await flush();

    expect(h.port.savedTokens.map(t => t.refreshToken)).toEqual(["NEW"]);
    expect(h.logs.some(l => l.level === "info" && l.msg.includes("stored again"))).toBe(true);
  });

  it("forgets the token once it is stored — no write on every later check", async () => {
    const h = harness([ok({ ...TOKEN_BODY, refresh_token: "NEW" })]);
    h.port.refreshToken = "OLD";
    h.port.saveFails = true;
    await h.ctl.start();
    h.port.saveFails = false;

    await h.ctl.persistPendingToken();
    await h.ctl.persistPendingToken();
    await h.ctl.persistPendingToken();

    // Exactly one write: a pending token that is never cleared would be rewritten
    // on every periodic check for the rest of the run.
    expect(h.port.savedTokens.map(t => t.refreshToken)).toEqual(["NEW"]);
  });

  it("stores the pending token when the database accepts it again (the call main makes at teardown)", async () => {
    const h = harness([ok({ ...TOKEN_BODY, refresh_token: "NEW" })]);
    h.port.refreshToken = "OLD";
    h.port.saveFails = true;
    await h.ctl.start();

    h.port.saveFails = false;
    await h.ctl.persistPendingToken();

    expect(h.port.savedTokens.map(t => t.refreshToken)).toEqual(["NEW"]);
  });

  it("keeps quiet and keeps the token when the retry fails again", async () => {
    const h = harness([ok({ ...TOKEN_BODY, refresh_token: "NEW" })]);
    h.port.refreshToken = "OLD";
    h.port.saveFails = true;
    await h.ctl.start();
    h.logs.length = 0;

    await h.ctl.persistPendingToken();
    // A repeat of a failure already reported at error level is debug material.
    expect(h.logs.every(l => l.level === "debug")).toBe(true);

    // The token is still pending, so a later attempt still has it.
    h.port.saveFails = false;
    await h.ctl.persistPendingToken();
    expect(h.port.savedTokens.map(t => t.refreshToken)).toEqual(["NEW"]);
  });
});

describe("AuthController findings of the 2026-09-15 audit", () => {
  /**
   * The device flow is out, the user has the link — then the poll fails ONCE.
   *
   * @param answer the token endpoint's answer to that one poll
   * @returns the harness after the blip
   */
  async function pollBlip(answer: FormPostResult): Promise<Harness> {
    const h = harness([ok(DEVICE_BODY), answer, ok(TOKEN_BODY)]);
    await h.ctl.start();
    expect(h.port.urls).toEqual(["https://verify?code=1234"]);
    firePending(h); // the poll that gets the blip
    await flush();
    return h;
  }

  for (const [what, answer] of [
    [
      "a transport failure",
      { status: 0, ok: false, body: { error: "network_error", error_description: "fetch failed" } },
    ],
    ["a 503", fail(503, {})],
    ["an unknown error code", fail(400, { error: "temporarily_unavailable" })],
  ] as const) {
    it(`keeps polling the same code after ${what}`, async () => {
      const h = await pollBlip(answer);
      // Measured before the fix: a second device_authorization, the link the
      // user was confirming replaced by code 9999, plus a warning for a blip.
      expect(h.calls.filter(c => c.path.endsWith("device_authorization"))).toHaveLength(1);
      expect(h.port.urls).toEqual(["https://verify?code=1234"]);
      expect(h.logs.filter(l => l.level === "warn")).toEqual([]);
      firePending(h); // the next poll of the SAME code
      await flush();
      expect(h.calls.at(-1)?.form.device_code).toBe("DC");
      expect(h.ctl.accessToken).toBe("AT");
      expect(h.port.signedIn).toBe(1);
    });
  }

  it("still requests a fresh link when the code expired (a final OAuth answer)", async () => {
    const h = harness([ok(DEVICE_BODY), fail(400, { error: "expired_token" }), ok(DEVICE_BODY)]);
    await h.ctl.start();
    firePending(h);
    await flush();
    expect(h.calls.filter(c => c.path.endsWith("device_authorization"))).toHaveLength(2);
  });

  it("keeps the newer token pending when a retried store overlaps a refresh", async () => {
    const h = harness([ok(TOKEN_BODY), ok({ ...TOKEN_BODY, access_token: "AT2", refresh_token: "RT2" })]);
    h.port.refreshToken = "OLD";
    h.port.saveFails = true;
    await h.ctl.start(); // RT could not be stored — pending
    // The retry of that store is slow; a refresh rotates the token meanwhile.
    let finishRetry: () => void = () => undefined;
    const slowSave = new Promise<void>(resolve => {
      finishRetry = resolve;
    });
    h.port.saveFails = false;
    h.port.saveToken = () => slowSave;
    const retry = h.ctl.persistPendingToken();
    await flush();
    h.port.saveToken = () => Promise.reject(new Error("objects db not writable"));
    await h.ctl.refreshNow(); // RT2 arrives, cannot be stored either — now RT2 is pending
    finishRetry(); // the old store of RT lands
    await retry;
    // Measured before the fix: the database held RT (dead server-side) and the
    // pending marker was cleared — RT2 was never written, the next start asked
    // for a new sign-in. The later retry must still know about RT2.
    const saved: StoredToken[] = [];
    h.port.saveToken = (token: StoredToken) => {
      saved.push(token);
      return Promise.resolve();
    };
    await h.ctl.persistPendingToken();
    expect(saved.map(t => t.refreshToken)).toEqual(["RT2"]);
  });

  it("arms no retry and warns nothing when the refresh fails after stop()", async () => {
    const clock = { t: 1_700_000_000_000 };
    let rejectRefresh: (e: Error) => void = () => undefined;
    const auth = new HomeConnectAuth(
      { clientId: "cid", clientSecret: "sec", baseUrl: "https://api.home-connect.com" },
      () =>
        new Promise<FormPostResult>((_resolve, reject) => {
          rejectRefresh = reject;
        }),
      () => clock.t,
    );
    const timers: Array<{ cb: () => void; ms: number; handle: object; interval: boolean }> = [];
    const logs: Array<{ level: string; msg: string }> = [];
    const port = new FakeAuthPort(timers, logs, clock);
    port.refreshToken = "OLD";
    const ctl = new AuthController(auth, port);
    const started = ctl.start();
    await flush(); // the refresh request is in flight
    ctl.stop();
    rejectRefresh(new Error("Connection is closed."));
    await started;
    // A timer armed on a stopped instance is refused by the host with a warning
    // of its own, and "retrying in 30 s" would announce a retry that never comes.
    expect(timers.filter(t => !t.interval)).toEqual([]);
    expect(logs.filter(l => l.level === "warn")).toEqual([]);
    expect(logs.some(l => l.level === "debug" && l.msg.includes("refresh failed after stop"))).toBe(true);
  });
});

describe("AuthController findings of the 2026-09-24 audit", () => {
  it("F3: a wrong client secret waits five minutes instead of renewing the link every few seconds", async () => {
    const h = harness([
      ok(DEVICE_BODY),
      fail(401, { error: "invalid_client" }),
      ok(DEVICE_BODY),
      fail(401, { error: "invalid_client" }),
    ]);
    await h.ctl.start();
    firePending(h); // the first poll carries the secret — rejected
    await flush();
    // Measured before: a fresh device_authorization at once, every ~5 s, forever.
    expect(h.calls.filter(c => c.path.endsWith("device_authorization"))).toHaveLength(1);
    expect(h.timers.filter(t => !t.interval).map(t => t.ms)).toEqual([300_000]);
    expect(h.port.urls.at(-1)).toBe("");
    const warns = h.logs.filter(l => l.level === "warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].msg).toContain("Home Connect rejected the Client Secret");
    expect(h.port.problems).toEqual(["invalid_client"]);
    // The next attempt after five minutes; the same answer warns no more.
    firePending(h);
    await flush();
    firePending(h);
    await flush();
    expect(h.logs.filter(l => l.level === "warn")).toHaveLength(1);
    expect(h.timers.filter(t => !t.interval).map(t => t.ms)).toEqual([300_000]);
  });

  it("F3: a denied or expired code still gets a fresh link at once", async () => {
    const h = harness([ok(DEVICE_BODY), fail(400, { error: "access_denied" }), ok(DEVICE_BODY)]);
    await h.ctl.start();
    firePending(h);
    await flush();
    expect(h.calls.filter(c => c.path.endsWith("device_authorization"))).toHaveLength(2);
  });

  it("F12: settle() waits for a refresh in flight until its token is stored", async () => {
    const clock = { t: 1_700_000_000_000 };
    let answer: (r: FormPostResult) => void = () => undefined;
    const auth = new HomeConnectAuth(
      { clientId: "cid", clientSecret: "sec", baseUrl: "https://api.home-connect.com" },
      () =>
        new Promise<FormPostResult>(resolve => {
          answer = resolve;
        }),
      () => clock.t,
    );
    const timers: Array<{ cb: () => void; ms: number; handle: object; interval: boolean }> = [];
    const port = new FakeAuthPort(timers, [], clock);
    port.refreshToken = "OLD";
    const ctl = new AuthController(auth, port);
    const started = ctl.start();
    await flush(); // the refresh is on its way
    ctl.stop(); // the teardown begins
    let settled = false;
    const done = ctl.settle().then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false); // still waiting for the answer
    answer(ok({ ...TOKEN_BODY, refresh_token: "ROTATED" }));
    await done;
    await started;
    // Home Connect already killed OLD — ROTATED is the only valid key and is stored.
    expect(port.savedTokens.map(t => t.refreshToken)).toEqual(["ROTATED"]);
  });

  it("settle() waits for the token a confirmed sign-in brings, even while the link is still being cleared", async () => {
    const h = harness([ok(DEVICE_BODY), ok({ ...TOKEN_BODY, refresh_token: "FIRST" })]);
    await h.ctl.start();
    // The link write hangs (a slow database): before the fix the poll's token waited
    // behind it, outside the in-flight set, and a teardown in that window lost the
    // only valid key.
    h.port.setVerificationUrl = (url: string) => {
      h.port.urls.push(url);
      return url === "" ? new Promise<void>(() => undefined) : Promise.resolve();
    };
    firePending(h); // the poll: the user confirmed the code
    await flush();
    h.ctl.stop();
    await h.ctl.settle();
    expect(h.port.savedTokens.map(x => x.refreshToken)).toEqual(["FIRST"]);
  });

  it("F23/N1: a runtime refresh failing after stop stays on debug; the next attempt is announced as 'at the earliest'", async () => {
    const h = harness([ok(TOKEN_BODY), fail(500, {}), fail(500, {})]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    await h.ctl.refreshNow();
    expect(h.logs.find(l => l.level === "warn")?.msg).toContain("next attempt at the earliest in 30 s");
    h.clock.t += 31_000;
    h.ctl.stop();
    h.logs.length = 0;
    await h.ctl.refreshNow();
    expect(h.logs.filter(l => l.level === "warn")).toEqual([]);
    expect(h.logs.some(l => l.msg.includes("refresh failed after stop"))).toBe(true);
  });

  it("E5: the refresh back-off stops growing at 30 minutes", async () => {
    const h = harness(Array.from({ length: 9 }, () => fail(500, {})));
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    const delays: number[] = [];
    for (let n = 0; n < 8; n++) {
      const t = h.timers.filter(x => !x.interval).at(-1);
      delays.push(t?.ms ?? -1);
      h.clock.t += (t?.ms ?? 0) + 1;
      firePending(h);
      await flush();
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000, 1_800_000, 1_800_000]);
  });
});

describe("AuthController — token lifetime (audit 2026-09-24, F14)", () => {
  it("says when a token response carried no usable lifetime and keeps the login", async () => {
    const { expires_in: _gone, ...noLifetime } = TOKEN_BODY;
    const h = harness([ok(noLifetime)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(h.ctl.accessToken).toBe("AT");
    expect(h.logs).toContainEqual({
      level: "debug",
      msg: "the token response carried no usable expires_in — assuming the usual 24 h lifetime.",
    });
  });

  it("stays quiet about a token response with its lifetime", async () => {
    const h = harness([ok(TOKEN_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(h.logs.some(l => l.msg.includes("expires_in"))).toBe(false);
  });
});

describe("AuthController tells what Home Connect said (2026-09-26)", () => {
  const NOT_ACTIVE = {
    error: "unauthorized_client",
    error_description: "request rejected by client authorization authority (developer portal)",
  };

  it("publishes Home Connect's own words for a refused poll and says what to do", async () => {
    const h = harness([ok(DEVICE_BODY), fail(400, NOT_ACTIVE)]);
    await h.ctl.start();
    firePending(h);
    await flush();
    expect(h.port.problems).toEqual([
      "unauthorized_client: request rejected by client authorization authority (developer portal)",
    ]);
    const warn = h.logs.find(l => l.level === "warn")?.msg ?? "";
    expect(warn).toContain(
      "unauthorized_client (request rejected by client authorization authority (developer portal))",
    );
    expect(warn).toContain("15 to 60 minutes");
  });

  it("publishes a refused start of the device flow, warns once and then goes quiet", async () => {
    const refused = { error: "unauthorized_client", error_description: "Invalid client id" };
    const h = harness([fail(400, refused), fail(400, refused)]);
    await h.ctl.start();
    expect(h.port.problems).toEqual(["unauthorized_client: Invalid client id"]);
    expect(h.logs.filter(l => l.level === "warn").map(l => l.msg)).toEqual([
      "Could not start the Home Connect sign-in (Device authorization failed: unauthorized_client (Invalid client id))." +
        " Home Connect does not know this Client ID — copy it again from the developer portal (64 hexadecimal characters)." +
        " Next attempt in 5 minutes.",
    ]);
    firePending(h);
    await flush();
    expect(h.logs.filter(l => l.level === "warn")).toHaveLength(1);
  });

  it("clears the problem once signed in", async () => {
    const h = harness([ok(DEVICE_BODY), fail(400, NOT_ACTIVE), ok(DEVICE_BODY), ok(TOKEN_BODY)]);
    await h.ctl.start();
    firePending(h); // refused → retry in 5 min
    await flush();
    firePending(h); // new device flow
    await flush();
    firePending(h); // approved
    await flush();
    expect(h.port.problems.at(-1)).toBe("");
    expect(h.port.signedIn).toBe(1);
  });

  it("ends the login when the refresh is refused for the application, instead of retrying for a day", async () => {
    const refused = { error: "invalid_client", error_description: "client secret validation failed" };
    const h = harness([ok(TOKEN_BODY), fail(401, refused), ok(DEVICE_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(await h.ctl.refreshNow()).toBe(false);
    await flush();
    expect(h.ctl.accessToken).toBeUndefined();
    expect(h.port.connected.at(-1)).toBe(false);
    expect(h.port.problems).toContain("invalid_client: client secret validation failed");
    expect(h.port.urls).toContain("https://verify?code=1234");
  });

  it("goes to a new sign-in at start when the stored login's application is refused", async () => {
    const refused = { error: "unauthorized_client", error_description: "Invalid client id" };
    const h = harness([fail(400, refused), ok(DEVICE_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    // Not the transient 30-second retry of the stored login: that can never succeed now.
    expect(h.calls.map(c => c.path)).toEqual(["/security/oauth/token", "/security/oauth/device_authorization"]);
    expect(h.port.problems).toEqual(["unauthorized_client: Invalid client id"]);
  });
});

describe("AuthController pauses an unconfirmed sign-in after an hour (krobi 2026-09-26)", () => {
  /** A device flow whose code is never confirmed: each code runs out by the clock, and every second link request is refused. */
  const EXPIRED = { error: "expired_token" };

  it("renews the link for an hour, then stops asking Home Connect", async () => {
    const results: FormPostResult[] = [];
    for (let n = 0; n < 20; n++) {
      results.push(ok(DEVICE_BODY), fail(400, EXPIRED));
    }
    const h = harness(results);
    await h.ctl.start();
    // Each round: the code expired by the clock or the retry timer fires; every second link request is refused.
    // Ten minutes a round, until nothing is pending any more.
    for (let round = 0; round < 12 && h.timers.some(t => !t.interval); round++) {
      h.clock.t += 10 * 60_000;
      firePending(h);
      await flush();
    }
    // Minute 0 and every ten minutes up to minute 50: six device_authorization requests (three links, three refused
    // starts), then the pause at minute 60.
    expect(h.calls.filter(c => c.path.endsWith("device_authorization"))).toHaveLength(6);
    expect(h.port.urls.at(-1)).toBe("");
    expect(h.timers.filter(t => !t.interval)).toEqual([]);
    expect(h.logs.filter(l => l.level === "info").map(l => l.msg)).toContain(
      "No sign-in was confirmed within an hour — the adapter stops asking Home Connect for sign-in links. " +
        "Request a new one in the adapter settings when you are ready.",
    );
  });

  it("starts a new episode on request — with a new notification", async () => {
    const results: FormPostResult[] = [];
    for (let n = 0; n < 20; n++) {
      results.push(ok(DEVICE_BODY), fail(400, EXPIRED));
    }
    const h = harness(results);
    await h.ctl.start();
    // Ten minutes a round, until nothing is pending any more.
    for (let round = 0; round < 12 && h.timers.some(t => !t.interval); round++) {
      h.clock.t += 10 * 60_000;
      firePending(h);
      await flush();
    }
    const before = h.calls.length;
    await expect(h.ctl.requestSignIn()).resolves.toBe("A new sign-in link was requested.");
    expect(h.calls.slice(before).map(c => c.path)).toEqual(["/security/oauth/device_authorization"]);
    expect(h.port.urls.at(-1)).toBe("https://verify?code=1234");
    expect(h.port.notifications).toHaveLength(2);
  });

  it("cancels a pending poll when a new link is requested, instead of polling two codes", async () => {
    const h = harness([ok(DEVICE_BODY), ok({ ...DEVICE_BODY, device_code: "DC2" })]);
    await h.ctl.start();
    expect(h.timers.filter(t => !t.interval)).toHaveLength(1);
    await h.ctl.requestSignIn();
    expect(h.timers.filter(t => !t.interval)).toHaveLength(1);
  });
});

describe("AuthController reset from the settings panel", () => {
  it("says so when already signed in instead of starting a second sign-in", async () => {
    const h = harness([ok(TOKEN_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    await expect(h.ctl.requestSignIn()).resolves.toContain("Already signed in");
    expect(h.calls).toHaveLength(1);
  });

  it("forgets the login, reports not signed in and starts a new sign-in", async () => {
    const h = harness([ok(TOKEN_BODY), ok(DEVICE_BODY)]);
    h.port.refreshToken = "OLD";
    await h.ctl.start();
    expect(h.timers.filter(t => t.interval)).toHaveLength(1);
    await expect(h.ctl.resetLogin()).resolves.toBe("A new sign-in link was requested.");
    expect(h.port.cleared).toBe(1);
    expect(h.ctl.accessToken).toBeUndefined();
    expect(h.port.connected.at(-1)).toBe(false);
    // The periodic refresh of the old login is gone; the device flow polls.
    expect(h.timers.filter(t => t.interval)).toEqual([]);
    expect(h.port.urls.at(-1)).toBe("https://verify?code=1234");
    expect(h.logs.filter(l => l.level === "info").map(l => l.msg)).toContain(
      "Home Connect login reset — a new sign-in follows.",
    );
  });

  it("does nothing on a stopped controller", async () => {
    const h = harness([]);
    h.ctl.stop();
    await expect(h.ctl.requestSignIn()).resolves.toBe("The adapter is stopping.");
    await expect(h.ctl.resetLogin()).resolves.toBe("The adapter is stopping.");
    expect(h.port.cleared).toBe(0);
  });
});

describe("AuthController hints by Home Connect's words (needle run 2026-09-26)", () => {
  it("names the Client ID as the problem when Home Connect says the id is invalid", async () => {
    const h = harness([
      ok(DEVICE_BODY),
      fail(400, { error: "unauthorized_client", error_description: "Invalid client id" }),
    ]);
    await h.ctl.start();
    firePending(h);
    await flush();
    expect(h.logs.find(l => l.level === "warn")?.msg).toContain("Home Connect does not know this Client ID");
  });
});
