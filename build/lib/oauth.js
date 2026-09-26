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
var oauth_exports = {};
__export(oauth_exports, {
  DEVICE_AUTH_PATH: () => DEVICE_AUTH_PATH,
  HomeConnectAuth: () => HomeConnectAuth,
  OAuthError: () => OAuthError,
  REFRESH_CHECK_INTERVAL_MS: () => REFRESH_CHECK_INTERVAL_MS,
  TOKEN_PATH: () => TOKEN_PATH,
  accessExpiryMs: () => accessExpiryMs,
  extractRefreshToken: () => extractRefreshToken,
  needsRefresh: () => needsRefresh,
  toStoredToken: () => toStoredToken
});
module.exports = __toCommonJS(oauth_exports);
const DEVICE_AUTH_PATH = "/security/oauth/device_authorization";
const TOKEN_PATH = "/security/oauth/token";
const REFRESH_MARGIN_MS = 60 * 60 * 1e3;
const REFRESH_CHECK_INTERVAL_MS = 10 * 60 * 1e3;
const ASSUMED_LIFETIME_S = 86400;
class OAuthError extends Error {
  /**
   * @param message human-readable error message
   * @param oauthError the machine-readable OAuth `error` code, if any
   * @param description Home Connect's own explanation (`error_description`), if any — it tells the
   *   cases apart that share a code ("Invalid client id" and "request rejected by client
   *   authorization authority (developer portal)" are both `unauthorized_client`)
   * @param status the HTTP status of the answer
   */
  constructor(message, oauthError, description, status) {
    super(message);
    this.oauthError = oauthError;
    this.description = description;
    this.status = status;
    this.name = "OAuthError";
  }
  oauthError;
  description;
  status;
}
function accessExpiryMs(expiresInSeconds, now) {
  return now + expiresInSeconds * 1e3;
}
function needsRefresh(token, now, marginMs = REFRESH_MARGIN_MS, checkIntervalMs = REFRESH_CHECK_INTERVAL_MS) {
  const lifetime = token.accessLifetimeMs;
  const margin = lifetime !== void 0 && lifetime > checkIntervalMs ? Math.min(marginMs, Math.max(checkIntervalMs, lifetime / 2)) : marginMs;
  return token.accessExpires - now <= margin;
}
function extractRefreshToken(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return void 0;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return void 0;
  }
  if (parsed === null || typeof parsed !== "object") {
    return void 0;
  }
  const obj = parsed;
  const camel = obj.refreshToken;
  if (typeof camel === "string" && camel.length > 0) {
    return camel;
  }
  const snake = obj.refresh_token;
  if (typeof snake === "string" && snake.length > 0) {
    return snake;
  }
  return void 0;
}
function toStoredToken(body, now) {
  if (body === null || typeof body !== "object") {
    throw new OAuthError("Token response is not an object");
  }
  const b = body;
  const accessToken = b.access_token;
  const refreshToken = b.refresh_token;
  const scope = b.scope;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new OAuthError("Token response is missing access_token or refresh_token");
  }
  const raw = typeof b.expires_in === "string" ? Number(b.expires_in.trim()) : b.expires_in;
  const usable = typeof raw === "number" && Number.isFinite(raw) && raw > 0;
  const expiresIn = usable ? raw : ASSUMED_LIFETIME_S;
  return {
    accessToken,
    refreshToken,
    accessExpires: accessExpiryMs(expiresIn, now),
    scope: typeof scope === "string" ? scope : "",
    accessLifetimeMs: expiresIn * 1e3,
    ...usable ? {} : { lifetimeAssumed: true }
  };
}
class HomeConnectAuth {
  /**
   * @param config OAuth application credentials + region base URL
   * @param post injected form-POST transport (real fetch in the adapter, a fake in tests)
   * @param now clock, injectable for deterministic tests
   */
  constructor(config, post, now = () => Date.now()) {
    this.config = config;
    this.post = post;
    this.now = now;
  }
  config;
  post;
  now;
  /**
   * Start the device flow: ask for a device + user code. The caller shows the
   * verification URL to the user, then calls {@link pollForToken} with the result.
   *
   * @returns the device authorization (verification URL, user code, poll interval)
   * @throws {OAuthError} on a malformed or error response
   */
  async startDeviceFlow() {
    const res = await this.post(DEVICE_AUTH_PATH, {
      client_id: this.config.clientId,
      scope: "IdentifyAppliance Monitor Settings Control"
    });
    if (!res.ok || res.body === null || typeof res.body !== "object") {
      const { code, description } = this.oauthErrorOf(res.body);
      throw new OAuthError(
        `Device authorization failed: ${describe(code, description, res.status)}`,
        code,
        description,
        res.status
      );
    }
    const b = res.body;
    const deviceCode = b.device_code;
    const userCode = b.user_code;
    const verificationUri = b.verification_uri;
    if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
      throw new OAuthError("Device authorization response is missing required fields");
    }
    const intervalSec = typeof b.interval === "number" && b.interval > 0 ? b.interval : 5;
    const expiresInSec = typeof b.expires_in === "number" ? b.expires_in : 600;
    return {
      verificationUri,
      verificationUriComplete: typeof b.verification_uri_complete === "string" ? b.verification_uri_complete : void 0,
      userCode,
      deviceCode,
      intervalMs: intervalSec * 1e3,
      expiresAt: this.now() + expiresInSec * 1e3
    };
  }
  /**
   * Exchange a device code for a token once — returns the token on success,
   * `"pending"` while the user has not yet approved, `"slow_down"` when the
   * server asks for a longer poll interval (RFC 8628: increase by 5 s), and
   * throws on a terminal error. The caller drives the polling loop/timer
   * (so the poll uses the adapter's managed timers, not a busy-wait here).
   *
   * @param deviceCode the device code from {@link startDeviceFlow}
   * @returns the stored token, or "pending" / "slow_down" while approval is outstanding
   * @throws {OAuthError} on a terminal error (expired, denied, access denied)
   */
  async pollForToken(deviceCode) {
    const res = await this.post(TOKEN_PATH, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: this.config.clientId,
      ...this.secret()
    });
    if (res.ok) {
      return toStoredToken(res.body, this.now());
    }
    const { code, description } = this.oauthErrorOf(res.body);
    if (code === "authorization_pending") {
      return "pending";
    }
    if (code === "slow_down" || code === void 0 && res.status === 429) {
      return "slow_down";
    }
    throw new OAuthError(
      `Device flow failed: ${describe(code, description, res.status)}`,
      code,
      description,
      res.status
    );
  }
  /**
   * Refresh an access token. Home Connect rotates the refresh token, so the
   * returned {@link StoredToken} carries the new refresh token to persist.
   *
   * @param refreshToken the current refresh token
   * @returns a fresh stored token (new access + rotated refresh token)
   * @throws {OAuthError} if the refresh is rejected (e.g. invalid_grant)
   */
  async refresh(refreshToken) {
    const res = await this.post(TOKEN_PATH, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...this.secret()
    });
    if (!res.ok) {
      const { code, description } = this.oauthErrorOf(res.body);
      throw new OAuthError(
        `Token refresh failed: ${describe(code, description, res.status)}`,
        code,
        description,
        res.status
      );
    }
    return toStoredToken(res.body, this.now());
  }
  /**
   * The client secret as a form field — only when one is configured.
   *
   * @returns `{ client_secret }`, or nothing
   */
  secret() {
    var _a;
    const secret = (_a = this.config.clientSecret) == null ? void 0 : _a.trim();
    return secret ? { client_secret: secret } : {};
  }
  /**
   * Best-effort extraction of the OAuth `error` code and Home Connect's `error_description` from an
   * error response body.
   *
   * @param body the parsed (error) response body
   * @returns the code and the description, each undefined when absent
   */
  oauthErrorOf(body) {
    if (body === null || typeof body !== "object") {
      return {};
    }
    const b = body;
    return {
      code: typeof b.error === "string" && b.error.length > 0 ? b.error : void 0,
      description: typeof b.error_description === "string" && b.error_description.trim().length > 0 ? b.error_description.trim() : void 0
    };
  }
}
function describe(code, description, status) {
  var _a;
  if (code && description) {
    return `${code} (${description})`;
  }
  return (_a = code != null ? code : description) != null ? _a : `status ${status}`;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DEVICE_AUTH_PATH,
  HomeConnectAuth,
  OAuthError,
  REFRESH_CHECK_INTERVAL_MS,
  TOKEN_PATH,
  accessExpiryMs,
  extractRefreshToken,
  needsRefresh,
  toStoredToken
});
//# sourceMappingURL=oauth.js.map
