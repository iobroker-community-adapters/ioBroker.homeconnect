// Home Connect OAuth 2 — headless Device Flow + token refresh.
// Wire details (endpoints, params, timings) are pinned in
// `Ressourcen/homeconnect/bsh-api-research-2026-08-05.md` / reference_bsh_home_connect_api.
//
// This module is pure orchestration: HTTP is injected as a `FormPoster`, so the
// flows are unit-testable without a network or an adapter instance. Token
// encryption/persistence is the caller's job (the adapter uses `encrypt()`).

/** OAuth endpoint paths, relative to the API base URL. */
export const DEVICE_AUTH_PATH = "/security/oauth/device_authorization";
export const TOKEN_PATH = "/security/oauth/token";

/** Refresh the access token this long before it actually expires (safety margin). */
const REFRESH_MARGIN_MS = 60 * 60 * 1000; // 1 h
/** How often the adapter checks whether the access token is due (the auth controller's timer). */
export const REFRESH_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 min
/**
 * Access-token lifetime assumed when a token response carries no usable
 * `expires_in`. Home Connect issues 86 400 s (API research); throwing instead
 * discarded the ROTATED refresh token of that very response — the old one is
 * already dead server-side, so the next attempt ended in a forced re-sign-in.
 */
const ASSUMED_LIFETIME_S = 86_400;

/** Static OAuth application credentials + region base URL. */
export interface OAuthConfig {
  /** Home Connect developer application client ID. */
  clientId: string;
  /**
   * Home Connect developer application client secret — sent only when set. The device flow's
   * token request needs none (api-docs, Authorization → Device Flow); an application whose
   * "Client Secret Always Required" is on still asks for it.
   */
  clientSecret?: string;
  /** Region base URL, e.g. "https://api.home-connect.com". */
  baseUrl: string;
}

/** A token as we persist it: absolute expiry, so it survives an adapter restart. */
export interface StoredToken {
  /** The bearer access token for API requests. */
  accessToken: string;
  /** The (rotating) refresh token used to obtain the next access token. */
  refreshToken: string;
  /** Absolute epoch-ms when the access token expires. */
  accessExpires: number;
  /** The space-separated scopes the token was granted. */
  scope: string;
  /**
   * The access token's lifetime as issued, in ms. Drives the refresh margin: a
   * short-lived token must not sit inside the fixed margin from the moment it
   * arrives. Absent on a token stored by an older version.
   */
  accessLifetimeMs?: number;
  /** True when the token response carried no usable `expires_in` and a default was assumed. */
  lifetimeAssumed?: boolean;
}

/** Result of a form POST: the caller (or a test) supplies parsed JSON + status. */
export interface FormPostResult {
  /** HTTP status code. */
  status: number;
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The parsed JSON response body. */
  body: unknown;
}
export type FormPoster = (path: string, form: Record<string, string>) => Promise<FormPostResult>;

/** Device authorization response (start of the device flow). */
export interface DeviceAuthorization {
  /** The URL the user opens to approve the device. */
  verificationUri: string;
  /** The verification URL with the user code already embedded, if provided. */
  verificationUriComplete?: string;
  /** The code the user enters at the verification URL. */
  userCode: string;
  /** The device code the adapter polls the token endpoint with. */
  deviceCode: string;
  /** Poll interval in ms. */
  intervalMs: number;
  /** Absolute epoch-ms when the device code expires. */
  expiresAt: number;
}

/** Thrown when a device-flow or token request fails (OAuth error code, transport failure, malformed response). */
export class OAuthError extends Error {
  /**
   * @param message human-readable error message
   * @param oauthError the machine-readable OAuth `error` code, if any
   * @param description Home Connect's own explanation (`error_description`), if any — it tells the
   *   cases apart that share a code ("Invalid client id" and "request rejected by client
   *   authorization authority (developer portal)" are both `unauthorized_client`)
   * @param status the HTTP status of the answer
   */
  constructor(
    message: string,
    readonly oauthError?: string,
    readonly description?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

// ─── pure helpers (unit-tested directly) ────────────────────────────────────

/**
 * Absolute expiry from an `expires_in` (seconds) relative to `now` (ms).
 *
 * @param expiresInSeconds the token lifetime in seconds (from the token response)
 * @param now current epoch-ms
 * @returns the absolute epoch-ms when the token expires
 */
export function accessExpiryMs(expiresInSeconds: number, now: number): number {
  return now + expiresInSeconds * 1000;
}

/**
 * True once the access token is within the refresh margin of expiry (or already past).
 *
 * @param token the stored token to check
 * @param now current epoch-ms
 * @param marginMs how long before expiry to already refresh
 * @param checkIntervalMs how often the caller checks — the margin never shrinks below it
 * @returns whether the token should be refreshed now
 */
export function needsRefresh(
  token: StoredToken,
  now: number,
  marginMs = REFRESH_MARGIN_MS,
  checkIntervalMs = REFRESH_CHECK_INTERVAL_MS,
): boolean {
  // A token issued for less than the margin would be "due" from the moment it
  // arrives and refresh on every check — against the token endpoint's own daily
  // quota. Its margin shrinks to half its lifetime then, but never below one
  // check interval: the periodic check must still catch it before it dies. A
  // token that lives no longer than one interval cannot be caught in time any
  // other way — it keeps the full margin (refreshed at every check).
  const lifetime = token.accessLifetimeMs;
  const margin =
    lifetime !== undefined && lifetime > checkIntervalMs
      ? Math.min(marginMs, Math.max(checkIntervalMs, lifetime / 2))
      : marginMs;
  return token.accessExpires - now <= margin;
}

/**
 * Pull a usable refresh token out of whatever sits in `auth.session`. Handles both
 * our own {@link StoredToken} (`refreshToken`) and the previous adapter's raw
 * Home Connect JSON (`refresh_token`), so a version update keeps the login without
 * a new device-flow prompt.
 *
 * @param raw the decrypted `auth.session` string (may be empty/garbage)
 * @returns the refresh token, or undefined if none can be found
 */
export function extractRefreshToken(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  const camel = obj.refreshToken;
  if (typeof camel === "string" && camel.length > 0) {
    return camel;
  }
  const snake = obj.refresh_token;
  if (typeof snake === "string" && snake.length > 0) {
    return snake;
  }
  return undefined;
}

/**
 * Validate a token-endpoint response and turn it into a {@link StoredToken}.
 *
 * @param body the parsed JSON body from the token endpoint
 * @param now current epoch-ms, for the absolute expiry
 * @returns the normalized stored token
 * @throws {OAuthError} if the body is not a well-formed token response
 */
export function toStoredToken(body: unknown, now: number): StoredToken {
  if (body === null || typeof body !== "object") {
    throw new OAuthError("Token response is not an object");
  }
  const b = body as Record<string, unknown>;
  const accessToken = b.access_token;
  const refreshToken = b.refresh_token;
  const scope = b.scope;
  if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
    throw new OAuthError("Token response is missing access_token or refresh_token");
  }
  // `expires_in` as a number or a numeric string; anything else falls back to the
  // lifetime Home Connect issues — never a reason to throw the rotated refresh
  // token of this response away.
  const raw = typeof b.expires_in === "string" ? Number(b.expires_in.trim()) : b.expires_in;
  const usable = typeof raw === "number" && Number.isFinite(raw) && raw > 0;
  const expiresIn = usable ? raw : ASSUMED_LIFETIME_S;
  return {
    accessToken,
    refreshToken,
    accessExpires: accessExpiryMs(expiresIn, now),
    scope: typeof scope === "string" ? scope : "",
    accessLifetimeMs: expiresIn * 1000,
    ...(usable ? {} : { lifetimeAssumed: true }),
  };
}

// ─── the flows ───────────────────────────────────────────────────────────────

/** Drives the Home Connect OAuth flows (device flow + refresh) against an injected HTTP transport. */
export class HomeConnectAuth {
  /**
   * @param config OAuth application credentials + region base URL
   * @param post injected form-POST transport (real fetch in the adapter, a fake in tests)
   * @param now clock, injectable for deterministic tests
   */
  constructor(
    private readonly config: OAuthConfig,
    private readonly post: FormPoster,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Start the device flow: ask for a device + user code. The caller shows the
   * verification URL to the user, then calls {@link pollForToken} with the result.
   *
   * @returns the device authorization (verification URL, user code, poll interval)
   * @throws {OAuthError} on a malformed or error response
   */
  async startDeviceFlow(): Promise<DeviceAuthorization> {
    const res = await this.post(DEVICE_AUTH_PATH, {
      client_id: this.config.clientId,
      scope: "IdentifyAppliance Monitor Settings Control",
    });
    if (!res.ok || res.body === null || typeof res.body !== "object") {
      const { code, description } = this.oauthErrorOf(res.body);
      throw new OAuthError(
        `Device authorization failed: ${describe(code, description, res.status)}`,
        code,
        description,
        res.status,
      );
    }
    const b = res.body as Record<string, unknown>;
    const deviceCode = b.device_code;
    const userCode = b.user_code;
    const verificationUri = b.verification_uri;
    if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
      throw new OAuthError("Device authorization response is missing required fields");
    }
    // RFC 8628 default 5 s; a zero or negative interval would poll in a tight loop.
    const intervalSec = typeof b.interval === "number" && b.interval > 0 ? b.interval : 5;
    const expiresInSec = typeof b.expires_in === "number" ? b.expires_in : 600;
    return {
      verificationUri,
      verificationUriComplete:
        typeof b.verification_uri_complete === "string" ? b.verification_uri_complete : undefined,
      userCode,
      deviceCode,
      intervalMs: intervalSec * 1000,
      expiresAt: this.now() + expiresInSec * 1000,
    };
  }

  /**
   * Exchange a device code for a token once — returns the token on success,
   * `"pending"` while the user has not yet approved, `"slow_down"` when the
   * server asks for a longer poll interval (RFC 8628: increase by 5 s), and
   * throws an OAuthError on every other answer (transport failure, 5xx, OAuth
   * error code) — the caller decides which of them end the code. The caller drives the polling loop/timer
   * (so the poll uses the adapter's managed timers, not a busy-wait here).
   *
   * @param deviceCode the device code from {@link startDeviceFlow}
   * @returns the stored token, or "pending" / "slow_down" while approval is outstanding
   * @throws {OAuthError} on every answer that is not pending or slow_down
   */
  async pollForToken(deviceCode: string): Promise<StoredToken | "pending" | "slow_down"> {
    const res = await this.post(TOKEN_PATH, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceCode,
      client_id: this.config.clientId,
      ...this.secret(),
    });
    if (res.ok) {
      return toStoredToken(res.body, this.now());
    }
    const { code, description } = this.oauthErrorOf(res.body);
    if (code === "authorization_pending") {
      return "pending";
    }
    // A 429 without an OAuth code is the token endpoint's own rate limit: slowing
    // down is the answer, not polling on at the same interval.
    if (code === "slow_down" || (code === undefined && res.status === 429)) {
      return "slow_down";
    }
    throw new OAuthError(
      `Device flow failed: ${describe(code, description, res.status)}`,
      code,
      description,
      res.status,
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
  async refresh(refreshToken: string): Promise<StoredToken> {
    const res = await this.post(TOKEN_PATH, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      ...this.secret(),
    });
    if (!res.ok) {
      const { code, description } = this.oauthErrorOf(res.body);
      throw new OAuthError(
        `Token refresh failed: ${describe(code, description, res.status)}`,
        code,
        description,
        res.status,
      );
    }
    return toStoredToken(res.body, this.now());
  }

  /**
   * The client secret as a form field — only when one is configured.
   *
   * @returns `{ client_secret }`, or nothing
   */
  private secret(): { client_secret?: string } {
    const secret = this.config.clientSecret?.trim();
    return secret ? { client_secret: secret } : {};
  }

  /**
   * Best-effort extraction of the OAuth `error` code and Home Connect's `error_description` from an
   * error response body.
   *
   * @param body the parsed (error) response body
   * @returns the code and the description, each undefined when absent
   */
  private oauthErrorOf(body: unknown): { code?: string; description?: string } {
    if (body === null || typeof body !== "object") {
      return {};
    }
    const b = body as Record<string, unknown>;
    return {
      code: typeof b.error === "string" && b.error.length > 0 ? b.error : undefined,
      description:
        typeof b.error_description === "string" && b.error_description.trim().length > 0
          ? b.error_description.trim()
          : undefined,
    };
  }
}

/**
 * One line for an OAuth failure: the code and Home Connect's own words, else the HTTP status.
 *
 * @param code the OAuth `error` code
 * @param description Home Connect's `error_description`
 * @param status the HTTP status
 * @returns e.g. `unauthorized_client (Invalid client id)`
 */
function describe(code: string | undefined, description: string | undefined, status: number): string {
  if (code && description) {
    return `${code} (${description})`;
  }
  return code ?? description ?? `status ${status}`;
}
