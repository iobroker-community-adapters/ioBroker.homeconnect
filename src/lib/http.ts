// Thin fetch-based HTTP for the Home Connect API. Node 22 global `fetch` +
// `AbortSignal.timeout` — no extra dependency, no manual timer to leak.
// `postForm` for the OAuth endpoints, `getJson`/`putJson`/`deleteJson` over one
// `requestJson` core for the REST calls.

import type { FormPostResult } from "./oauth";
import { cleanLabel, errMessage } from "./pure-helpers";

/** Default per-request timeout (Home Connect research pins request timeout at 20 s). */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Hard cap on a single response body. Real Home Connect answers are a few KB;
 * only a broken proxy or a compromised endpoint streams megabytes — that must
 * end in a failed call, not in the adapter process growing until it is killed.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/**
 * POST an `application/x-www-form-urlencoded` body and return status + parsed JSON.
 * Used for the OAuth token endpoints. A network error or timeout maps to a
 * non-ok result (status 0) rather than throwing, so the auth layer treats
 * transport failures and HTTP errors uniformly.
 *
 * @param baseUrl the region base URL, e.g. "https://api.home-connect.com"
 * @param path the endpoint path, e.g. "/security/oauth/token"
 * @param form the form fields to url-encode
 * @param timeoutMs abort the request after this many ms
 * @returns the HTTP status, ok flag and parsed JSON body (null if none/invalid)
 */
export async function postForm(
  baseUrl: string,
  path: string,
  form: Record<string, string>,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<FormPostResult> {
  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { status: 0, ok: false, body: { error: "network_error", error_description: errMessage(e) } };
  }
  // fetch resolves with the headers; the body can still break off (socket reset,
  // the timeout firing mid-stream). That is a transport failure like any other.
  let parsed: { json: unknown; tooLarge: boolean };
  try {
    parsed = await parseJsonBody(res);
  } catch (e) {
    return { status: 0, ok: false, body: { error: "network_error", error_description: errMessage(e) } };
  }
  if (parsed.tooLarge) {
    return { status: 0, ok: false, body: { error: "response_too_large" } };
  }
  return { status: res.status, ok: res.ok, body: parsed.json };
}

/** Result of a bearer-token JSON request (GET/PUT/DELETE): status, ok, the unwrapped `data`, and an error key on failure. */
export interface JsonResult {
  /** HTTP status code (0 on a transport error). */
  status: number;
  /** Whether the status is 2xx. */
  ok: boolean;
  /** The unwrapped `data` field of the `{ data: … }` envelope, or undefined on failure. */
  data: unknown;
  /** The BSH `error.key`, `status <n>`, `network_error: …` or `response too large` on failure, else undefined. */
  error: string | undefined;
  /** On a 429, the `Retry-After` window in ms (from the header), else undefined. */
  retryAfterMs?: number;
  /**
   * Home Connect's own words on a failure (`error.description`) — on a 429 the only place that names the limit
   * ("50 calls in 1 minute", "10 successive error calls in 10 minutes", "1000 calls in 1 day") and how long it
   * blocks. Undefined when the body carries none.
   */
  description?: string;
}

/**
 * GET a Home Connect JSON resource with a bearer token. Unwraps the `{ data: … }`
 * envelope and surfaces the BSH `error.key` on failure. A network error or timeout
 * maps to status 0.
 *
 * @param baseUrl the region base URL
 * @param path the endpoint path, e.g. "/api/homeappliances"
 * @param accessToken the OAuth bearer access token
 * @param acceptLanguage optional Accept-Language for localized names
 * @param timeoutMs abort the request after this many ms
 * @returns status, ok, unwrapped data and (on failure) the error key
 */
export function getJson(
  baseUrl: string,
  path: string,
  accessToken: string,
  acceptLanguage?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<JsonResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: "application/vnd.bsh.sdk.v1+json",
  };
  if (acceptLanguage) {
    headers["accept-language"] = acceptLanguage;
  }
  return requestJson(baseUrl, path, { method: "GET", headers }, timeoutMs);
}

/**
 * PUT a `{ data }` body (a Home Connect write: setting, program, option, command)
 * with a bearer token.
 *
 * @param baseUrl the region base URL
 * @param path the endpoint path
 * @param accessToken the OAuth bearer access token
 * @param data the value to wrap as `{ data }`
 * @param timeoutMs abort the request after this many ms
 * @returns status, ok and (on failure) the error key
 */
export function putJson(
  baseUrl: string,
  path: string,
  accessToken: string,
  data: unknown,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<JsonResult> {
  return requestJson(
    baseUrl,
    path,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/vnd.bsh.sdk.v1+json",
      },
      body: JSON.stringify({ data }),
    },
    timeoutMs,
  );
}

/**
 * DELETE a Home Connect resource (e.g. stop the active program) with a bearer token.
 *
 * @param baseUrl the region base URL
 * @param path the endpoint path
 * @param accessToken the OAuth bearer access token
 * @param timeoutMs abort the request after this many ms
 * @returns status, ok and (on failure) the error key
 */
export function deleteJson(
  baseUrl: string,
  path: string,
  accessToken: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<JsonResult> {
  return requestJson(
    baseUrl,
    path,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/vnd.bsh.sdk.v1+json" },
    },
    timeoutMs,
  );
}

/**
 * The shared fetch for all bearer-token JSON calls: one place for the timeout
 * signal, the network-error → status-0 mapping and the result normalization.
 *
 * @param baseUrl the region base URL
 * @param path the endpoint path
 * @param init HTTP method, headers and optional body
 * @param init.method the HTTP method
 * @param init.headers the request headers
 * @param init.body the raw request body, if any
 * @param timeoutMs abort the request after this many ms
 * @returns the normalized JSON result
 */
async function requestJson(
  baseUrl: string,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<JsonResult> {
  let res: Response;
  try {
    res = await fetch(new URL(path, baseUrl), { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    return { status: 0, ok: false, data: undefined, error: `network_error: ${errMessage(e)}` };
  }
  // fetch resolves with the headers; the body can still break off (socket reset,
  // the timeout firing mid-stream). A rejection here travelled up through the
  // appliance sync and ended the whole start-up chain — it is a transport
  // failure like any other.
  try {
    return await toJsonResult(res);
  } catch (e) {
    return { status: 0, ok: false, data: undefined, error: `network_error: ${errMessage(e)}` };
  }
}

/**
 * Turn a fetch Response into a {@link JsonResult}: unwrap the `{ data }` envelope
 * and surface the BSH error key on failure.
 *
 * @param res the fetch Response
 * @returns the normalized JSON result
 */
async function toJsonResult(res: Response): Promise<JsonResult> {
  const parsed = await parseJsonBody(res);
  if (parsed.tooLarge) {
    return { status: res.status, ok: false, data: undefined, error: "response too large" };
  }
  const body = parsed.json;
  const envelope = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  return {
    status: res.status,
    ok: res.ok,
    data: res.ok ? envelope.data : undefined,
    error: res.ok ? undefined : (errorKey(envelope) ?? `status ${res.status}`),
    retryAfterMs: res.status === 429 ? retryAfterMs(res.headers.get("retry-after")) : undefined,
    description: res.ok ? undefined : errorDescription(envelope),
  };
}

/**
 * Parse a `Retry-After` header into ms. Home Connect sends it as a number of
 * seconds. A missing or non-numeric value yields undefined (the caller then
 * applies its own fallback pause).
 *
 * @param header the raw `Retry-After` header value
 * @returns the delay in ms, or undefined
 */
export function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) {
    return undefined;
  }
  return parseInt(header.trim(), 10) * 1000;
}

/**
 * Pull the BSH `error.key` out of an `{ error: { key } }` body.
 *
 * @param body the parsed response body
 * @returns the error key, or undefined
 */
export function errorKey(body: Record<string, unknown>): string | undefined {
  const err = body.error;
  if (err !== null && typeof err === "object") {
    const key = (err as Record<string, unknown>).key;
    if (typeof key === "string") {
      return key;
    }
  }
  return undefined;
}

/**
 * A 429 in words a user reads: how long Home Connect blocks and which limit was hit. The limit comes from
 * Home Connect's description (`The rate limit "50 calls in 1 minute" was reached. Requests are blocked during
 * the remaining period of 54 seconds.`); the duration from there or from the Retry-After header.
 *
 * @param description Home Connect's `error.description`, if any
 * @param retryMs the Retry-After window in ms, if any
 * @returns e.g. `Home Connect blocks requests for 54 s (limit: 50 calls in 1 minute)`
 */
export function rateLimitText(description?: string, retryMs?: number): string {
  const match = /rate limit "([^"]+)".*?(\d+) seconds/.exec(description ?? "");
  const seconds = match ? Number(match[2]) : retryMs === undefined ? undefined : Math.round(retryMs / 1000);
  const limit = match ? ` (limit: ${match[1]})` : description ? ` (${description})` : "";
  return `Home Connect blocks requests${seconds === undefined ? "" : ` for ${spokenDuration(seconds)}`}${limit}`;
}

/**
 * A duration for a log line: seconds up to two minutes, then minutes, then hours and minutes.
 *
 * @param seconds the duration in seconds
 * @returns e.g. `54 s`, `9 min`, `5 h 5 min`
 */
function spokenDuration(seconds: number): string {
  if (seconds < 120) {
    return `${seconds} s`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/**
 * Pull Home Connect's `error.description` out of an `{ error: { description } }` body, cleaned for a log line.
 *
 * @param body the parsed response body
 * @returns the description, or undefined when there is none
 */
export function errorDescription(body: Record<string, unknown>): string | undefined {
  const err = body.error;
  if (err !== null && typeof err === "object") {
    return cleanLabel((err as Record<string, unknown>).description) || undefined;
  }
  return undefined;
}

/**
 * Read a response body as JSON, tolerating an empty or non-JSON body (→ null)
 * and refusing one beyond {@link MAX_RESPONSE_BYTES} (→ `tooLarge`).
 *
 * @param res the fetch Response to read
 * @returns the parsed JSON (null if empty / not JSON), and whether the body was refused for its size
 */
async function parseJsonBody(res: Response): Promise<{ json: unknown; tooLarge: boolean }> {
  const text = await readBodyCapped(res, MAX_RESPONSE_BYTES);
  if (text === undefined) {
    return { json: null, tooLarge: true };
  }
  if (text.length === 0) {
    return { json: null, tooLarge: false };
  }
  try {
    return { json: JSON.parse(text), tooLarge: false };
  } catch {
    return { json: null, tooLarge: false };
  }
}

/**
 * Read a response body as text, giving up as soon as it exceeds `maxBytes`
 * (the rest of the stream is cancelled, nothing is buffered beyond the cap).
 * A response without a readable body stream (a test double) falls back to
 * `text()`.
 *
 * @param res the fetch Response to read
 * @param maxBytes the cap in bytes
 * @returns the body text, or undefined when it was refused for its size
 */
export async function readBodyCapped(res: Response, maxBytes: number): Promise<string | undefined> {
  const declared = Number(res.headers?.get?.("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    return res.text();
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
