"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var auth_controller_exports = {};
__export(auth_controller_exports, {
  AUTH_RETRY_MS: () => AUTH_RETRY_MS,
  AuthController: () => AuthController,
  SIGN_IN_REQUIRED: () => SIGN_IN_REQUIRED,
  SIGN_IN_WINDOW_MS: () => SIGN_IN_WINDOW_MS,
  SLOW_DOWN_STEP_MS: () => SLOW_DOWN_STEP_MS
});
module.exports = __toCommonJS(auth_controller_exports);
var import_oauth = require("./oauth");
var import_pure_helpers = require("./pure-helpers");
var import_sign_in_help = require("./sign-in-help");
const AUTH_RETRY_MS = 30 * 1e3;
const REFRESH_BACKOFF_MAX_MS = 30 * 60 * 1e3;
const DEVICE_FLOW_RETRY_MS = 5 * 60 * 1e3;
const SLOW_DOWN_STEP_MS = 5e3;
const SIGN_IN_WINDOW_MS = 60 * 6e4;
const SIGN_IN_REQUIRED = "Home Connect sign-in required \u2014 open the adapter settings and follow the sign-in link shown there.";
const CODE_ENDED_ERRORS = /* @__PURE__ */ new Set(["access_denied", "expired_token", "invalid_grant"]);
const CONFIG_ERRORS = /* @__PURE__ */ new Set([
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope"
]);
function isLoginOver(code) {
  return code === "invalid_grant" || code !== void 0 && CONFIG_ERRORS.has(code);
}
class AuthController {
  /**
   * @param auth the configured OAuth flow driver
   * @param port the injected adapter capabilities
   */
  constructor(auth, port) {
    this.auth = auth;
    this.port = port;
  }
  auth;
  port;
  token;
  /** In-flight token refresh, shared by concurrent 401 callers (re-armed after it settles). */
  refreshing;
  refreshTimer;
  deviceFlowTimer;
  retryTimer;
  stopped = false;
  /** Consecutive failed refresh attempts — drives the growing retry back-off. */
  refreshFailures = 0;
  /** Epoch-ms before which no new refresh attempt may hit the token endpoint. */
  nextRefreshAllowed = 0;
  /** Whether a transient refresh failure was already warned about (repeats → debug). */
  refreshWarned = false;
  /** Whether the current sign-in episode already raised the notification + info line. */
  signInAnnounced = false;
  /** A rotated token the database refused — retried until it is safely stored. */
  unsavedToken;
  /** Whether this sign-in episode already warned about a configuration answer (repeats → debug). */
  configWarned = false;
  /** Whether this sign-in episode already warned about a failed start of the device flow (repeats → debug). */
  startWarned = false;
  /** Epoch-ms the current sign-in episode began — see {@link SIGN_IN_WINDOW_MS}. */
  episodeStartedAt;
  /**
   * Token requests in flight (refresh at start, runtime refresh, device-flow
   * poll) including the persisting of what they bring. Home Connect rotates the
   * refresh token server-side the moment it answers — a teardown that does not
   * wait for the answer loses the only valid key.
   */
  inflight = /* @__PURE__ */ new Set();
  /** The current access token, or undefined while not signed in. */
  get accessToken() {
    var _a;
    return (_a = this.token) == null ? void 0 : _a.accessToken;
  }
  /** Current epoch-ms (injected clock in tests, Date.now otherwise). */
  now() {
    return this.port.now ? this.port.now() : Date.now();
  }
  /** Begin the auth lifecycle: reuse the stored login, or run the device flow. */
  async start() {
    await this.authenticate();
  }
  /**
   * Resolve once no token request is in flight any more — for the teardown, so a
   * rotated token that is on its way still gets stored. Never rejects.
   */
  async settle() {
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
  track(work) {
    this.inflight.add(work);
    const done = () => {
      this.inflight.delete(work);
    };
    work.then(done, done);
    return work;
  }
  /** Cancel all timers (synchronous, for onUnload). */
  stop() {
    this.stopped = true;
    if (this.refreshTimer) {
      this.port.clearIntervalTimer(this.refreshTimer);
      this.refreshTimer = void 0;
    }
    if (this.deviceFlowTimer) {
      this.port.clearTimer(this.deviceFlowTimer);
      this.deviceFlowTimer = void 0;
    }
    if (this.retryTimer) {
      this.port.clearTimer(this.retryTimer);
      this.retryTimer = void 0;
    }
  }
  /**
   * Obtain a valid access token: reuse the stored refresh token if there is one,
   * otherwise run the device flow. A refresh that fails because the token was
   * revoked (`invalid_grant`) drops to a fresh device-flow sign-in; a transient
   * failure (network / 5xx / timeout) keeps the stored token and just retries,
   * so a blip during a restart does not force the user to re-authorise.
   */
  async authenticate() {
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
          this.port.log.debug(`refresh failed after stop: ${(0, import_pure_helpers.errMessage)(e)}`);
          return;
        }
        if (e instanceof import_oauth.OAuthError && isLoginOver(e.oauthError)) {
          await this.reportRefusal(e);
          this.port.log.warn(
            `Stored login is no longer valid (${(0, import_pure_helpers.errMessage)(e)}) \u2014 ${(0, import_sign_in_help.signInHint)(e.oauthError, e.description)} A new sign-in is required.`
          );
        } else {
          const delay = this.nextRefreshBackoff();
          this.port.log.warn(
            `Stored login could not be refreshed (${(0, import_pure_helpers.errMessage)(e)}) \u2014 retrying in ${Math.round(delay / 1e3)} s, login kept.`
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
  async runDeviceFlow() {
    var _a, _b;
    if (this.stopped) {
      return;
    }
    (_a = this.episodeStartedAt) != null ? _a : this.episodeStartedAt = this.now();
    if (this.now() - this.episodeStartedAt >= SIGN_IN_WINDOW_MS) {
      await this.pause();
      return;
    }
    let dev;
    try {
      dev = await this.auth.startDeviceFlow();
    } catch (e) {
      if (e instanceof import_oauth.OAuthError && e.oauthError !== void 0) {
        await this.reportRefusal(e);
      }
      const level = this.startWarned ? "debug" : "warn";
      this.startWarned = true;
      const hint = e instanceof import_oauth.OAuthError && e.oauthError !== void 0 ? ` ${(0, import_sign_in_help.signInHint)(e.oauthError, e.description)}` : "";
      this.port.log[level](
        `Could not start the Home Connect sign-in (${(0, import_pure_helpers.errMessage)(e)}).${hint} Next attempt in 5 minutes.`
      );
      this.retryTimer = this.port.setTimer(() => void this.guard(() => this.runDeviceFlow()), DEVICE_FLOW_RETRY_MS);
      return;
    }
    const url = (_b = dev.verificationUriComplete) != null ? _b : dev.verificationUri;
    await this.port.setVerificationUrl(url);
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
  async pause() {
    await this.port.setVerificationUrl("");
    this.port.log.info(
      "No sign-in was confirmed within an hour \u2014 the adapter stops asking Home Connect for sign-in links. Request a new one in the adapter settings when you are ready."
    );
  }
  /**
   * Publish Home Connect's own words for a refusal (`auth.lastError`).
   *
   * @param e the refusal
   */
  async reportRefusal(e) {
    const text = (0, import_sign_in_help.refusalText)(e.oauthError, e.description);
    if (text !== void 0) {
      await this.port.setProblem(text);
    }
  }
  /**
   * Start a new sign-in episode now — the settings panel's "request a new sign-in link": after the
   * pause, after a refusal that was fixed in the portal, or simply because the user is ready.
   *
   * @returns what happened, in a sentence for the panel
   */
  async requestSignIn() {
    if (this.stopped) {
      return "The adapter is stopping.";
    }
    if (this.token) {
      return 'Already signed in \u2014 use "Reset sign-in" to sign in with another account.';
    }
    this.clearSignInTimers();
    this.episodeStartedAt = void 0;
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
  async resetLogin() {
    if (this.stopped) {
      return "The adapter is stopping.";
    }
    if (this.refreshTimer) {
      this.port.clearIntervalTimer(this.refreshTimer);
      this.refreshTimer = void 0;
    }
    this.token = void 0;
    this.unsavedToken = void 0;
    await this.port.clearStoredLogin();
    await this.port.setConnected(false);
    this.port.log.info("Home Connect login reset \u2014 a new sign-in follows.");
    return this.requestSignIn();
  }
  /** Cancel the device-flow poll and a pending retry. */
  clearSignInTimers() {
    if (this.deviceFlowTimer) {
      this.port.clearTimer(this.deviceFlowTimer);
      this.deviceFlowTimer = void 0;
    }
    if (this.retryTimer) {
      this.port.clearTimer(this.retryTimer);
      this.retryTimer = void 0;
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
  pollDeviceFlow(deviceCode, intervalMs, expiresAt) {
    this.deviceFlowTimer = this.port.setTimer(() => {
      void this.guard(async () => {
        if (this.stopped) {
          return;
        }
        if (this.now() >= expiresAt) {
          this.port.log.debug("the sign-in code expired unused \u2014 requesting a fresh sign-in link.");
          await this.port.setVerificationUrl("");
          await this.runDeviceFlow();
          return;
        }
        let result;
        try {
          result = await this.track(this.auth.pollForToken(deviceCode));
        } catch (e) {
          const code = e instanceof import_oauth.OAuthError ? e.oauthError : void 0;
          const description = e instanceof import_oauth.OAuthError ? e.description : void 0;
          if (code !== void 0 && CONFIG_ERRORS.has(code)) {
            const level = this.configWarned ? "debug" : "warn";
            this.configWarned = true;
            await this.reportRefusal(e);
            this.port.log[level](
              `Home Connect rejected the sign-in (${(0, import_pure_helpers.errMessage)(e)}) \u2014 ${(0, import_sign_in_help.signInHint)(code, description)} Next sign-in attempt in 5 minutes.`
            );
            await this.port.setVerificationUrl("");
            this.retryTimer = this.port.setTimer(
              () => void this.guard(() => this.runDeviceFlow()),
              DEVICE_FLOW_RETRY_MS
            );
            return;
          }
          if (code === void 0 || !CODE_ENDED_ERRORS.has(code)) {
            this.port.log.debug(`sign-in poll failed (${(0, import_pure_helpers.errMessage)(e)}) \u2014 trying again with the same code.`);
            this.pollDeviceFlow(deviceCode, intervalMs, expiresAt);
            return;
          }
          if (code === "expired_token") {
            this.port.log.debug("the sign-in code expired unconfirmed \u2014 requesting a fresh sign-in link.");
          } else {
            await this.reportRefusal(e);
            this.port.log.warn(
              `Home Connect sign-in failed (${(0, import_pure_helpers.errMessage)(e)}) \u2014 ${(0, import_sign_in_help.signInHint)(code, description)} Requesting a fresh sign-in link.`
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
  async applyToken(token) {
    this.token = token;
    if (token.lifetimeAssumed) {
      this.port.log.debug("the token response carried no usable expires_in \u2014 assuming the usual 24 h lifetime.");
    }
    await this.persistToken(token);
    if (this.stopped) {
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
  async persistToken(token) {
    try {
      await this.port.saveToken(token);
      this.unsavedToken = void 0;
    } catch (e) {
      this.unsavedToken = token;
      this.port.log.error(
        `Home Connect: the refreshed login could not be stored (${(0, import_pure_helpers.errMessage)(e)}) \u2014 the adapter keeps working, but the STORED login is now out of date. Unless it can be written before the next restart, a new sign-in will be required. The adapter keeps retrying.`
      );
    }
  }
  /**
   * Retry a token write the database refused earlier. Called from the periodic
   * check and once more at teardown — the token in memory is valid, only the
   * database was not, so a later attempt usually just works.
   */
  async persistPendingToken() {
    const pending = this.unsavedToken;
    if (!pending) {
      return;
    }
    try {
      await this.port.saveToken(pending);
      if (this.unsavedToken === pending) {
        this.unsavedToken = void 0;
      }
      this.port.log.info("Home Connect: the refreshed login is stored again \u2014 no new sign-in is needed.");
    } catch (e) {
      this.port.log.debug(`storing the refreshed login failed again: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
  /** After a successful sign-in: reset the episode flags, arm the refresh, wire the adapter. */
  async signedIn() {
    if (this.stopped) {
      return;
    }
    this.signInAnnounced = false;
    this.configWarned = false;
    this.startWarned = false;
    this.episodeStartedAt = void 0;
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
  nextRefreshBackoff() {
    const delay = Math.min(REFRESH_BACKOFF_MAX_MS, AUTH_RETRY_MS * 2 ** this.refreshFailures);
    this.refreshFailures++;
    this.nextRefreshAllowed = this.now() + delay;
    return delay;
  }
  /** Arm the periodic check that refreshes the access token before it expires. */
  armRefreshTimer() {
    if (this.refreshTimer) {
      return;
    }
    this.refreshTimer = this.port.setIntervalTimer(() => {
      void this.guard(() => this.persistPendingToken());
      if (this.token && (0, import_oauth.needsRefresh)(this.token, this.now())) {
        void this.refreshNow();
      }
    }, import_oauth.REFRESH_CHECK_INTERVAL_MS);
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
  async refreshNow() {
    if (!this.token) {
      return false;
    }
    if (!this.refreshing) {
      if (this.now() < this.nextRefreshAllowed) {
        return false;
      }
      const refreshToken = this.token.refreshToken;
      this.refreshing = (async () => {
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
          if (e instanceof import_oauth.OAuthError && isLoginOver(e.oauthError)) {
            await this.port.setConnected(false);
            await this.reportRefusal(e);
            this.port.log.warn(
              `Home Connect login is no longer valid (${(0, import_pure_helpers.errMessage)(e)}) \u2014 ${(0, import_sign_in_help.signInHint)(e.oauthError, e.description)} A new sign-in is required.`
            );
            this.token = void 0;
            this.episodeStartedAt = void 0;
            void this.guard(() => this.runDeviceFlow());
          } else if (this.stopped) {
            this.port.log.debug(`refresh failed after stop: ${(0, import_pure_helpers.errMessage)(e)}`);
          } else {
            const delay = this.nextRefreshBackoff();
            const level = this.refreshWarned ? "debug" : "warn";
            this.port.log[level](
              `Home Connect token refresh failed: ${(0, import_pure_helpers.errMessage)(e)} \u2014 next attempt at the earliest in ${Math.round(delay / 1e3)} s.`
            );
            this.refreshWarned = true;
          }
          return false;
        } finally {
          this.refreshing = void 0;
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
  async guard(fn) {
    try {
      await fn();
    } catch (e) {
      this.port.log.error(`auth task failed: ${(0, import_pure_helpers.errMessage)(e)}`);
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  AUTH_RETRY_MS,
  AuthController,
  SIGN_IN_REQUIRED,
  SIGN_IN_WINDOW_MS,
  SLOW_DOWN_STEP_MS
});
//# sourceMappingURL=auth-controller.js.map
