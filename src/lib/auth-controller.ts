// Auth lifecycle — extracted from main.ts so the sign-in orchestration is a
// testable unit (a fake AuthPort + injected timers stand in for the adapter).
// Owns the token, the periodic refresh, the device flow including its polling,
// and the recovery paths: a transient refresh failure retries with the login
// kept; a revoked login (invalid_grant, at start-up OR at runtime) drops to a
// fresh device-flow sign-in; an expired or rejected sign-in link is replaced by
// a fresh one automatically, so the link in the admin panel is always valid.

import { needsRefresh, OAuthError, REFRESH_CHECK_INTERVAL_MS } from "./oauth";
import type { HomeConnectAuth, DeviceAuthorization, StoredToken } from "./oauth";
import { errMessage } from "./pure-helpers";
import { refusalText, signInHint } from "./sign-in-help";

/** Retry the initial sign-in this soon after a transient (non-auth) refresh failure. */
export const AUTH_RETRY_MS = 30 * 1000;
/**
 * Cap for the growing wait between FAILED token-refresh attempts. The token
 * endpoint has its own quota (10 refreshes/minute, 100/day — official rate-limit
 * docs), so failed attempts back off 30 s → doubling → this cap (≈ 50 attempts
 * per day worst case) instead of retrying on a fixed clock.
 */
const REFRESH_BACKOFF_MAX_MS = 30 * 60 * 1000;
/** Retry a failed device-flow *start* this soon (kind to the OAuth endpoints). */
const DEVICE_FLOW_RETRY_MS = 5 * 60 * 1000;
/** RFC 8628: when the server answers slow_down, grow the poll interval by 5 s. */
export const SLOW_DOWN_STEP_MS = 5_000;
/**
 * How long one sign-in episode keeps asking Home Connect for fresh links. A code lives 5 minutes;
 * without a limit an unconfirmed sign-in renewed it forever — about 290 codes and 17 000 token
 * requests a day for an instance nobody signs in to. After this the sign-in pauses until the user
 * asks for a new link in the settings (or the instance restarts). krobi 2026-09-26.
 */
export const SIGN_IN_WINDOW_MS = 60 * 60_000;
/** The notification and the log line when a sign-in is needed — without the code, which changes every 5 minutes. */
export const SIGN_IN_REQUIRED =
  "Home Connect sign-in required — open the adapter settings and follow the sign-in link shown there.";

/**
 * Device-flow poll answers that END the current code: the OAuth error codes of
 * RFC 8628 §3.5 and RFC 6749 §5.2. Everything else — a transport failure (the
 * HTTP layer reports it as the pseudo-code `network_error`), a 5xx without a
 * code, an unknown code — is a blip: the same code is polled again, and
 * `expiresAt` bounds the worst case to one code lifetime. Treating every
 * error as final threw away the code the user was typing in at that moment.
 *
 * Two kinds of final answer, handled apart:
 * - the CODE is over (denied, expired, already used) — a fresh link at once;
 * - the CONFIGURATION is wrong (client secret, client, scope). The device
 *   authorization sends the client id only, so a wrong secret passes it and
 *   fails every poll: a fresh link at once turned into a new link every few
 *   seconds, forever — sign-in impossible, the log flooded. That waits like a
 *   failed device-flow start and says what to check.
 */
const CODE_ENDED_ERRORS = new Set(["access_denied", "expired_token", "invalid_grant"]);
const CONFIG_ERRORS = new Set([
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
]);

/**
 * Whether a refresh answer means the login cannot come back: revoked, or the application itself
 * refused — then a new sign-in is the only way, and retrying on the back-off would only wait for
 * the access token to die.
 *
 * @param code the OAuth `error` code of the refresh answer
 * @returns whether a new sign-in is needed
 */
function isLoginOver(code: string | undefined): boolean {
  return code === "invalid_grant" || (code !== undefined && CONFIG_ERRORS.has(code));
}

/** The slice of the adapter the auth lifecycle needs — injected so it can be faked in tests. */
export interface AuthPort {
  /** The adapter logger. */
  readonly log: ioBroker.Logger;
  /** Read the stored refresh token (decryption + legacy format handled by the adapter). */
  loadRefreshToken(): Promise<string | undefined>;
  /** Persist a fresh token (the adapter encrypts it). */
  saveToken(token: StoredToken): Promise<void>;
  /** Publish the sign-in verification URL ("" clears it). */
  setVerificationUrl(url: string): Promise<void>;
  /** Reflect the signed-in/connected flag. */
  setConnected(connected: boolean): Promise<void>;
  /** Raise the persistent "sign-in required" notification. */
  notify(message: string): void;
  /**
   * Publish what Home Connect said when it refused the sign-in (`auth.lastError`): its own words,
   * "" once signed in.
   */
  setProblem(text: string): Promise<void>;
  /** Forget the stored login (`auth.session`). */
  clearStoredLogin(): Promise<void>;
  /** Called after every successful sign-in (initial or re-auth): wire up the adapter. */
  onSignedIn(): Promise<void>;
  /** Schedule a callback (the adapter's managed setTimeout). */
  setTimer(cb: () => void, ms: number): unknown;
  /** Cancel a scheduled callback. */
  clearTimer(handle: unknown): void;
  /** Schedule a repeating callback (the adapter's managed setInterval). */
  setIntervalTimer(cb: () => void, ms: number): unknown;
  /** Cancel a repeating callback. */
  clearIntervalTimer(handle: unknown): void;
  /** Clock, injectable for deterministic tests (defaults to Date.now). */
  now?: () => number;
}

/** Drives sign-in, token refresh and re-authentication against an injected adapter port. */
export class AuthController {
  private token: StoredToken | undefined;
  /** In-flight token refresh, shared by concurrent 401 callers (re-armed after it settles). */
  private refreshing: Promise<boolean> | undefined;
  private refreshTimer: unknown;
  private deviceFlowTimer: unknown;
  private retryTimer: unknown;
  private stopped = false;
  /** Consecutive failed refresh attempts — drives the growing retry back-off. */
  private refreshFailures = 0;
  /** Epoch-ms before which no new refresh attempt may hit the token endpoint. */
  private nextRefreshAllowed = 0;
  /** Whether a transient refresh failure was already warned about (repeats → debug). */
  private refreshWarned = false;
  /** Whether the current sign-in episode already raised the notification + info line. */
  private signInAnnounced = false;
  /** A rotated token the database refused — retried until it is safely stored. */
  private unsavedToken: StoredToken | undefined;
  /** Whether this sign-in episode already warned about a configuration answer (repeats → debug). */
  private configWarned = false;
  /** Whether this sign-in episode already warned about a failed start of the device flow (repeats → debug). */
  private startWarned = false;
  /** Epoch-ms the current sign-in episode began — see {@link SIGN_IN_WINDOW_MS}. */
  private episodeStartedAt: number | undefined;
  /**
   * Token requests in flight (refresh at start, runtime refresh, device-flow
   * poll) including the persisting of what they bring. Home Connect rotates the
   * refresh token server-side the moment it answers — a teardown that does not
   * wait for the answer loses the only valid key.
   */
  private readonly inflight = new Set<Promise<unknown>>();

  /**
   * @param auth the configured OAuth flow driver
   * @param port the injected adapter capabilities
   */
  constructor(
    private readonly auth: HomeConnectAuth,
    private readonly port: AuthPort,
  ) {}

  /** The current access token, or undefined while not signed in. */
  get accessToken(): string | undefined {
    return this.token?.accessToken;
  }

  /** Current epoch-ms (injected clock in tests, Date.now otherwise). */
  private now(): number {
    return this.port.now ? this.port.now() : Date.now();
  }

  /** Begin the auth lifecycle: reuse the stored login, or run the device flow. */
  async start(): Promise<void> {
    await this.authenticate();
  }

  /**
   * Resolve once no token request is in flight any more — for the teardown, so a
   * rotated token that is on its way still gets stored. Never rejects.
   */
  async settle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight]);
    }
  }

  /**
   * Register a token request (with its persisting) as in flight until it settles.
   *
   * @param work the request
   * @returns the same promise
   */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const done = (): void => {
      this.inflight.delete(work);
    };
    work.then(done, done);
    return work;
  }

  /** Cancel all timers (synchronous, for onUnload). */
  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      this.port.clearIntervalTimer(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.deviceFlowTimer) {
      this.port.clearTimer(this.deviceFlowTimer);
      this.deviceFlowTimer = undefined;
    }
    if (this.retryTimer) {
      this.port.clearTimer(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /**
   * Obtain a valid access token: reuse the stored refresh token if there is one,
   * otherwise run the device flow. A refresh that fails because the token was
   * revoked (`invalid_grant`) drops to a fresh device-flow sign-in; a transient
   * failure (network / 5xx / timeout) keeps the stored token and just retries,
   * so a blip during a restart does not force the user to re-authorise.
   */
  private async authenticate(): Promise<void> {
    // A retry timer whose callback was already queued when onUnload ran still
    // arrives here. Without this check it talks to the token endpoint and writes
    // states from a stopped instance ("Connection is closed"), and a success
    // would re-arm the refresh interval the teardown just cleared.
    if (this.stopped) {
      return;
    }
    const refreshToken = await this.port.loadRefreshToken();
    if (refreshToken) {
      try {
        await this.track((async () => this.applyToken(await this.auth.refresh(refreshToken)))());
        this.port.log.info("Home Connect: signed in (reused the stored login).");
        await this.signedIn();
        return;
      } catch (e) {
        if (this.stopped) {
          // The refresh was in flight when onUnload ran: no warning about a
          // retry that will never happen, and no timer armed on a stopped
          // instance (the host refuses it and logs a warning of its own).
          this.port.log.debug(`refresh failed after stop: ${errMessage(e)}`);
          return;
        }
        if (e instanceof OAuthError && isLoginOver(e.oauthError)) {
          // Revoked, or the application itself is refused (deleted, disabled, secret changed):
          // the stored login cannot come back — a new sign-in is the only way.
          await this.reportRefusal(e);
          this.port.log.warn(
            `Stored login is no longer valid (${errMessage(e)}) — ${signInHint(e.oauthError, e.description)} A new sign-in is required.`,
          );
          // fall through to the device flow
        } else {
          const delay = this.nextRefreshBackoff();
          this.port.log.warn(
            `Stored login could not be refreshed (${errMessage(e)}) — retrying in ${Math.round(delay / 1000)} s, login kept.`,
          );
          this.retryTimer = this.port.setTimer(() => void this.guard(() => this.authenticate()), delay);
          return;
        }
      }
    }
    await this.runDeviceFlow();
  }

  /**
   * Start (or restart) the device flow: publish the verification URL, announce
   * the sign-in once per episode (notification + info; later cycles only renew
   * the link on debug), then poll until approved. A failed start (network,
   * rejected credentials) retries after a pause instead of giving up.
   */
  private async runDeviceFlow(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.episodeStartedAt ??= this.now();
    if (this.now() - this.episodeStartedAt >= SIGN_IN_WINDOW_MS) {
      await this.pause();
      return;
    }
    let dev: DeviceAuthorization;
    try {
      dev = await this.auth.startDeviceFlow();
    } catch (e) {
      if (e instanceof OAuthError && e.oauthError !== undefined) {
        await this.reportRefusal(e);
      }
      const level = this.startWarned ? "debug" : "warn";
      this.startWarned = true;
      const hint =
        e instanceof OAuthError && e.oauthError !== undefined ? ` ${signInHint(e.oauthError, e.description)}` : "";
      this.port.log[level](
        `Could not start the Home Connect sign-in (${errMessage(e)}).${hint} Next attempt in 5 minutes.`,
      );
      this.retryTimer = this.port.setTimer(() => void this.guard(() => this.runDeviceFlow()), DEVICE_FLOW_RETRY_MS);
      return;
    }
    const url = dev.verificationUriComplete ?? dev.verificationUri;
    await this.port.setVerificationUrl(url);
    // The code changes every five minutes: the notification and the info line point at the
    // settings, where the current link and code always stand; only debug names the code.
    this.port.log.debug(`sign-in link: ${dev.verificationUri} code ${dev.userCode}`);
    if (!this.signInAnnounced) {
      this.port.log.info(SIGN_IN_REQUIRED);
      this.port.notify(SIGN_IN_REQUIRED);
      this.signInAnnounced = true;
    }
    this.pollDeviceFlow(dev.deviceCode, dev.intervalMs, dev.expiresAt);
  }

  /**
   * Stop asking Home Connect for sign-in links: the episode ran {@link SIGN_IN_WINDOW_MS} without a
   * confirmation. The settings panel offers a new link ({@link requestSignIn}); a restart starts
   * over too.
   */
  private async pause(): Promise<void> {
    await this.port.setVerificationUrl("");
    this.port.log.info(
      "No sign-in was confirmed within an hour — the adapter stops asking Home Connect for sign-in links. " +
        "Request a new one in the adapter settings when you are ready.",
    );
  }

  /**
   * Publish Home Connect's own words for a refusal (`auth.lastError`).
   *
   * @param e the refusal
   */
  private async reportRefusal(e: OAuthError): Promise<void> {
    const text = refusalText(e.oauthError, e.description);
    if (text !== undefined) {
      await this.port.setProblem(text);
    }
  }

  /**
   * Start a new sign-in episode now — the settings panel's "request a new sign-in link": after the
   * pause, after a refusal that was fixed in the portal, or simply because the user is ready.
   *
   * @returns what happened, in a sentence for the panel
   */
  async requestSignIn(): Promise<string> {
    if (this.stopped) {
      return "The adapter is stopping.";
    }
    if (this.token) {
      return 'Already signed in — use "Reset sign-in" to sign in with another account.';
    }
    this.clearSignInTimers();
    this.episodeStartedAt = undefined;
    this.signInAnnounced = false;
    this.configWarned = false;
    this.startWarned = false;
    await this.port.setVerificationUrl("");
    await this.runDeviceFlow();
    return "A new sign-in link was requested.";
  }

  /**
   * Forget the login and sign in afresh — to switch to another Home Connect account, or when the
   * stored login is in doubt.
   *
   * @returns what happened, in a sentence for the panel
   */
  async resetLogin(): Promise<string> {
    if (this.stopped) {
      return "The adapter is stopping.";
    }
    if (this.refreshTimer) {
      this.port.clearIntervalTimer(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.token = undefined;
    this.unsavedToken = undefined;
    await this.port.clearStoredLogin();
    await this.port.setConnected(false);
    this.port.log.info("Home Connect login reset — a new sign-in follows.");
    return this.requestSignIn();
  }

  /** Cancel the device-flow poll and a pending retry. */
  private clearSignInTimers(): void {
    if (this.deviceFlowTimer) {
      this.port.clearTimer(this.deviceFlowTimer);
      this.deviceFlowTimer = undefined;
    }
    if (this.retryTimer) {
      this.port.clearTimer(this.retryTimer);
      this.retryTimer = undefined;
    }
  }

  /**
   * One device-flow poll, rescheduled via a managed timer. An expired code or a
   * terminal error does not strand the adapter: the flow restarts with a fresh
   * link (and the stale URL is cleared first).
   *
   * @param deviceCode the device code to poll with
   * @param intervalMs the poll interval (grown on a slow_down answer)
   * @param expiresAt absolute epoch-ms after which the device code is dead
   */
  private pollDeviceFlow(deviceCode: string, intervalMs: number, expiresAt: number): void {
    this.deviceFlowTimer = this.port.setTimer(() => {
      void this.guard(async () => {
        if (this.stopped) {
          return;
        }
        if (this.now() >= expiresAt) {
          this.port.log.debug("the sign-in code expired unused — requesting a fresh sign-in link.");
          await this.port.setVerificationUrl("");
          await this.runDeviceFlow();
          return;
        }
        let result: StoredToken | "pending" | "slow_down";
        try {
          result = await this.track(this.auth.pollForToken(deviceCode));
        } catch (e) {
          // Only the POLL's own failure is judged here: a final OAuth answer ends
          // this code, anything else keeps polling it. What happens after a
          // token arrived (a state write, the sign-in chain) is not a poll
          // failure and stays with the guard around this callback.
          const code = e instanceof OAuthError ? e.oauthError : undefined;
          const description = e instanceof OAuthError ? e.description : undefined;
          if (code !== undefined && CONFIG_ERRORS.has(code)) {
            const level = this.configWarned ? "debug" : "warn";
            this.configWarned = true;
            await this.reportRefusal(e as OAuthError);
            this.port.log[level](
              `Home Connect rejected the sign-in (${errMessage(e)}) — ${signInHint(code, description)} Next sign-in attempt in 5 minutes.`,
            );
            await this.port.setVerificationUrl("");
            this.retryTimer = this.port.setTimer(
              () => void this.guard(() => this.runDeviceFlow()),
              DEVICE_FLOW_RETRY_MS,
            );
            return;
          }
          if (code === undefined || !CODE_ENDED_ERRORS.has(code)) {
            this.port.log.debug(`sign-in poll failed (${errMessage(e)}) — trying again with the same code.`);
            this.pollDeviceFlow(deviceCode, intervalMs, expiresAt);
            return;
          }
          if (code === "expired_token") {
            // Not a refusal: the code simply ran out unconfirmed.
            this.port.log.debug("the sign-in code expired unconfirmed — requesting a fresh sign-in link.");
          } else {
            await this.reportRefusal(e as OAuthError);
            this.port.log.warn(
              `Home Connect sign-in failed (${errMessage(e)}) — ${signInHint(code, description)} Requesting a fresh sign-in link.`,
            );
          }
          await this.port.setVerificationUrl("");
          await this.runDeviceFlow();
          return;
        }
        if (result === "pending") {
          this.pollDeviceFlow(deviceCode, intervalMs, expiresAt);
        } else if (result === "slow_down") {
          this.pollDeviceFlow(deviceCode, intervalMs + SLOW_DOWN_STEP_MS, expiresAt);
        } else {
          await this.port.setVerificationUrl("");
          await this.track(this.applyToken(result));
          this.port.log.info("Home Connect: signed in.");
          await this.signedIn();
        }
      });
    }, intervalMs);
  }

  /**
   * Persist a freshly obtained token and mark the service connected.
   *
   * @param token the token to store and use
   */
  private async applyToken(token: StoredToken): Promise<void> {
    this.token = token;
    if (token.lifetimeAssumed) {
      this.port.log.debug("the token response carried no usable expires_in — assuming the usual 24 h lifetime.");
    }
    // The token is persisted even on a stopped instance — Home Connect kills the
    // previous refresh token the moment it hands out a new one, so losing this
    // one costs the user a fresh device-flow sign-in (decision 22).
    await this.persistToken(token);
    if (this.stopped) {
      // Announcing a connection while the adapter shuts down would re-raise the
      // marker the teardown just cleared, and log "signed in" on the way out.
      return;
    }
    await this.port.setConnected(true);
  }

  /**
   * Store a token — and keep it for a later attempt if the database refused it.
   *
   * Home Connect ROTATES the refresh token: the moment the new one arrives, the
   * old one is dead server-side. A write that failed therefore leaves the only
   * usable key in memory while the database holds one the cloud will never
   * accept again — and the next start would demand a fresh device-flow sign-in
   * from the user. Previously the failure travelled up as a refresh error and
   * was reported as "login kept", which is the opposite of what had happened.
   *
   * The adapter keeps running: the token in memory is valid and this run works
   * completely. What it must not do is stay quiet about it.
   *
   * @param token the token to store
   */
  private async persistToken(token: StoredToken): Promise<void> {
    try {
      await this.port.saveToken(token);
      this.unsavedToken = undefined;
    } catch (e) {
      this.unsavedToken = token;
      this.port.log.error(
        `Home Connect: the refreshed login could not be stored (${errMessage(e)}) — the adapter keeps working, but the STORED login is now out of date. ` +
          `Unless it can be written before the next restart, a new sign-in will be required. The adapter keeps retrying.`,
      );
    }
  }

  /**
   * Retry a token write the database refused earlier. Called from the periodic
   * check and once more at teardown — the token in memory is valid, only the
   * database was not, so a later attempt usually just works.
   */
  async persistPendingToken(): Promise<void> {
    const pending = this.unsavedToken;
    if (!pending) {
      return;
    }
    try {
      await this.port.saveToken(pending);
      // A refresh may have rotated the token while this write was in flight —
      // then the newer one is the pending one now, and it must stay pending:
      // clearing unconditionally left the database on the dead key.
      if (this.unsavedToken === pending) {
        this.unsavedToken = undefined;
      }
      this.port.log.info("Home Connect: the refreshed login is stored again — no new sign-in is needed.");
    } catch (e) {
      this.port.log.debug(`storing the refreshed login failed again: ${errMessage(e)}`);
    }
  }

  /** After a successful sign-in: reset the episode flags, arm the refresh, wire the adapter. */
  private async signedIn(): Promise<void> {
    if (this.stopped) {
      // A sign-in completing after the teardown must not arm a timer or start the
      // whole start-up chain. (The host refuses `setInterval` while shutting down
      // and clears its timers anyway — but it says so with a warning, and
      // `onSignedIn` would run the appliance sync past the teardown.)
      return;
    }
    this.signInAnnounced = false;
    this.configWarned = false;
    this.startWarned = false;
    this.episodeStartedAt = undefined;
    this.refreshWarned = false;
    this.refreshFailures = 0;
    this.nextRefreshAllowed = 0;
    this.armRefreshTimer();
    await this.port.setProblem("");
    await this.port.onSignedIn();
  }

  /**
   * The wait before the next refresh attempt after a failure: 30 s, doubling per
   * consecutive failure, capped — protecting the token endpoint's own daily quota.
   *
   * @returns the back-off delay in ms (also arms {@link nextRefreshAllowed})
   */
  private nextRefreshBackoff(): number {
    const delay = Math.min(REFRESH_BACKOFF_MAX_MS, AUTH_RETRY_MS * 2 ** this.refreshFailures);
    this.refreshFailures++;
    this.nextRefreshAllowed = this.now() + delay;
    return delay;
  }

  /** Arm the periodic check that refreshes the access token before it expires. */
  private armRefreshTimer(): void {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = this.port.setIntervalTimer(() => {
      // A token the database refused earlier is written as soon as it accepts
      // again — without this the only usable refresh token would live in memory
      // until the next restart, which would then need a fresh sign-in.
      void this.guard(() => this.persistPendingToken());
      if (this.token && needsRefresh(this.token, this.now())) {
        void this.refreshNow();
      }
    }, REFRESH_CHECK_INTERVAL_MS);
  }

  /**
   * Refresh the access token now, sharing one in-flight attempt across concurrent
   * callers (the periodic timer and any 401 from a REST call). A transient
   * failure keeps the login and warns once (repeats → debug); a revoked login
   * (`invalid_grant`) drops the dead token — which also stops the event stream's
   * fetches — and starts a fresh device-flow sign-in.
   *
   * @returns whether a fresh token was obtained
   */
  async refreshNow(): Promise<boolean> {
    if (!this.token) {
      return false;
    }
    if (!this.refreshing) {
      // Failed attempts back off (the token endpoint has its own daily quota);
      // sequential 401 callers during the back-off window don't hit it again.
      if (this.now() < this.nextRefreshAllowed) {
        return false;
      }
      const refreshToken = this.token.refreshToken;
      this.refreshing = (async (): Promise<boolean> => {
        try {
          await this.applyToken(await this.auth.refresh(refreshToken));
          if (this.refreshWarned) {
            this.port.log.info("Home Connect token refresh succeeded again.");
            this.refreshWarned = false;
          }
          this.refreshFailures = 0;
          this.nextRefreshAllowed = 0;
          this.port.log.debug("Home Connect: access token refreshed.");
          return true;
        } catch (e) {
          if (e instanceof OAuthError && isLoginOver(e.oauthError)) {
            // Only a login that cannot come back ends the signed-in state: revoked
            // (`invalid_grant`), or the application refused (deleted, disabled, its
            // secret changed). A transient failure keeps the current access token,
            // which stays valid until its expiry — reporting "not connected" for it
            // would be a false alarm; retrying a refusal on the back-off would only
            // keep "signed in" on screen until the token dies after 24 hours.
            await this.port.setConnected(false);
            await this.reportRefusal(e);
            this.port.log.warn(
              `Home Connect login is no longer valid (${errMessage(e)}) — ${signInHint(e.oauthError, e.description)} A new sign-in is required.`,
            );
            this.token = undefined;
            this.episodeStartedAt = undefined;
            void this.guard(() => this.runDeviceFlow());
          } else if (this.stopped) {
            // Failed on the way out: no warning about an attempt that never comes.
            this.port.log.debug(`refresh failed after stop: ${errMessage(e)}`);
          } else {
            const delay = this.nextRefreshBackoff();
            const level = this.refreshWarned ? "debug" : "warn";
            // No timer of its own: the periodic check and the next 401 retry once
            // the back-off window is over — so "at the earliest".
            this.port.log[level](
              `Home Connect token refresh failed: ${errMessage(e)} — next attempt at the earliest in ${Math.round(delay / 1000)} s.`,
            );
            this.refreshWarned = true;
          }
          return false;
        } finally {
          this.refreshing = undefined;
        }
      })();
      void this.track(this.refreshing);
    }
    return this.refreshing;
  }

  /**
   * Run a fire-and-forget async unit with a top-level catch (no unhandled rejection).
   *
   * @param fn the async unit to run
   */
  private async guard(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.port.log.error(`auth task failed: ${errMessage(e)}`);
    }
  }
}
