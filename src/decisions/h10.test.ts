// Core decision H-10 (accepted 2026-10-15): an unconfirmed sign-in link is renewed for at most an hour — then the adapter
// asks Home Connect for no new code until a new link is requested in the panel or the instance restarts. krobi
// 2026-09-26 20:34, his choice "Stop after 1 hour (recommended)" on "today the adapter renews it endlessly every 5
// minutes (around 290 codes a day to BSH)".
import { describe, expect, it } from "vitest";
import { AuthController, SIGN_IN_WINDOW_MS, type AuthPort } from "../lib/auth-controller";
import { HomeConnectAuth, type FormPostResult, type StoredToken } from "../lib/oauth";

const DEVICE = {
  device_code: "DC",
  user_code: "1234",
  verification_uri: "https://verify",
  verification_uri_complete: "https://verify?code=1234",
  interval: 5,
  expires_in: 600,
};

describe("H-10 an unconfirmed sign-in stops asking after an hour", () => {
  it("asks for links for an hour, then no more until a new link is requested", async () => {
    expect(SIGN_IN_WINDOW_MS).toBe(60 * 60_000);
    const clock = { t: 1_700_000_000_000 };
    const paths: string[] = [];
    // Never confirmed: every token poll says the code ran out, every link request gets a new code.
    const auth = new HomeConnectAuth(
      { clientId: "cid", clientSecret: "", baseUrl: "https://api.home-connect.com" },
      (path): Promise<FormPostResult> => {
        paths.push(path);
        return Promise.resolve(
          path.endsWith("device_authorization")
            ? { status: 200, ok: true, body: DEVICE }
            : { status: 400, ok: false, body: { error: "expired_token" } },
        );
      },
      () => clock.t,
    );
    const timers: Array<{ cb: () => void; live: boolean }> = [];
    const urls: string[] = [];
    const port: AuthPort = {
      log: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        silly: () => undefined,
      } as unknown as ioBroker.Logger,
      loadRefreshToken: () => Promise.resolve(undefined),
      saveToken: (_t: StoredToken) => Promise.resolve(),
      setVerificationUrl: (url: string) => {
        urls.push(url);
        return Promise.resolve();
      },
      setConnected: () => Promise.resolve(),
      notify: () => undefined,
      setProblem: () => Promise.resolve(),
      clearStoredLogin: () => Promise.resolve(),
      onSignedIn: () => Promise.resolve(),
      setTimer: (cb: () => void) => {
        const t = { cb, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (h: unknown) => {
        (h as { live: boolean }).live = false;
      },
      setIntervalTimer: () => ({}),
      clearIntervalTimer: () => undefined,
      now: () => clock.t,
    };
    const ctl = new AuthController(auth, port);
    await ctl.start();
    // Two hours of an unconfirmed sign-in, a minute at a time.
    for (let minute = 0; minute < 120; minute++) {
      clock.t += 60_000;
      for (const t of timers.splice(0).filter(x => x.live)) {
        t.cb();
      }
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    const links = paths.filter(p => p.endsWith("device_authorization")).length;
    expect(links).toBeGreaterThan(1);
    // Nothing asked after the hour: the last link request came within it.
    const before = links;
    clock.t += 6 * 60 * 60_000;
    for (const t of timers.splice(0).filter(x => x.live)) {
      t.cb();
    }
    await new Promise(resolve => setTimeout(resolve, 1));
    expect(paths.filter(p => p.endsWith("device_authorization")).length).toBe(before);
    expect(urls.at(-1)).toBe("");
    // A new link on request starts a new hour.
    await ctl.requestSignIn();
    expect(paths.filter(p => p.endsWith("device_authorization")).length).toBe(before + 1);
    ctl.stop();
  });
});
