/**
 * The public client of the Home Connect app, used by the app access (beta).
 *
 * The app access signs in with the client the Home Connect app itself uses, under the user's own account — no developer
 * account and no Client ID of the adapter (core decision H-11). The person signs in in the browser (the page shows a
 * captcha, so the adapter never opens it itself) and pastes the address of the page it ends on back into the settings;
 * the adapter exchanges the code with PKCE.
 *
 * Source of the values (client, redirect, scopes, the three forms of the pasted address): Home Connect NG
 * (renaudallard/homeassistant_homeconnect, BSD-2-Clause, commit 67fbb08, `custom_components/homeconnect/const.py:54,68,
 * 75-86`, `auth.py:100-194`); the same client, redirect and scopes stand in the Home Connect app 12.6.0 itself
 * (Ressourcen/homeconnect/app-analyse-2026-11-10.md). The code is our own.
 */
import { createHash, randomBytes } from "node:crypto";

export const APP_CLIENT_ID = "9B75AC9EC512F36C84256AC47D813E2C1DD0D6520DF774B020E1E6E2EB29B1F3";

/** Where the browser lands after the sign-in — the page whose address the user pastes back. */
export const APP_REDIRECT_URI = "https://qr.home-connect.com/authorize/prod/";

/** The scopes the app client asks for — the set tried with this client (NG, app 12.6.0). */
export const APP_SCOPES: readonly string[] = [
  "Control",
  "DeleteAppliance",
  "IdentifyAppliance",
  "Images",
  "Monitor",
  "ReadAccount",
  "ReadOrigApi",
  "Settings",
  "WriteAppliance",
  "WriteOrigApi",
];

/** The sign-in page, relative to the API base URL. */
export const AUTHORIZE_PATH = "/security/oauth/authorize";

/** The schemes of a sign-in answer the end page hands over in one base64 argument. */
const HANDED_OVER = ["homeconnect://", "hcalexa://"];

/** The answer when nothing usable was pasted. */
export const NOTHING_PASTED = "nothing was pasted — paste the address of the page the sign-in ended on";

/** How the pasted address carried the code — for the diagnostics report, never the code itself. */
export type PastedForm = "parameter" | "handedOver" | "bare";

/**
 * A fresh PKCE verifier: 64 random bytes in base64url, without padding (86 characters).
 *
 * @returns the verifier — kept in memory only
 */
export function makeVerifier(): string {
  return randomBytes(64).toString("base64url");
}

/**
 * What the verifier is published as: its SHA-256 in base64url, without padding (RFC 7636 S256).
 *
 * @param verifier the PKCE verifier
 * @returns the code challenge
 */
export function challengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/**
 * The sign-in page of the app client. Asking for the login prompt keeps a browser already signed in from handing back
 * a code without showing whose account it is.
 *
 * @param baseUrl the API base URL
 * @param verifier the PKCE verifier of this sign-in
 * @param state a random value sent along (not checked: the bare code carries none — PKCE protects the exchange)
 * @param nonce a random value sent along
 * @returns the address to open in the browser
 */
export function appAuthorizeUrl(baseUrl: string, verifier: string, state: string, nonce: string): string {
  const query = new URLSearchParams({
    client_id: APP_CLIENT_ID,
    response_type: "code",
    redirect_uri: APP_REDIRECT_URI,
    scope: APP_SCOPES.join(" "),
    prompt: "login",
    state,
    nonce,
    code_challenge: challengeOf(verifier),
    code_challenge_method: "S256",
  });
  return `${baseUrl}${AUTHORIZE_PATH}?${query.toString()}`;
}

/**
 * The address hidden in one base64 argument of the query, if one is hidden there. Read from the query as written: a
 * parsed query turns the "+" of base64 into a space.
 *
 * @param query the raw query of the pasted address
 * @returns the handed-over address, or undefined
 */
function handedOver(query: string): string | undefined {
  for (const argument of query.split("&")) {
    // either alphabet — the two differ only in the two characters a URL would otherwise escape
    const plainly = argument.replace(/-/g, "+").replace(/_/g, "/");
    const padded = plainly + "=".repeat((4 - (plainly.length % 4)) % 4);
    if (padded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) {
      continue;
    }
    let plain: string;
    try {
      plain = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(padded, "base64"));
    } catch {
      continue;
    }
    if (HANDED_OVER.some(scheme => plain.startsWith(scheme))) {
      return plain;
    }
  }
  return undefined;
}

/**
 * The code of an address, if it carries one as a parameter.
 *
 * @param query a query string
 * @returns the code, or undefined
 */
function codeParameter(query: string): string | undefined {
  const code = new URLSearchParams(query).get("code");
  return code ? code : undefined;
}

/**
 * The query of an address as written (after the first "?", without a fragment).
 *
 * @param address the address
 * @returns the raw query, "" when there is none
 */
function rawQuery(address: string): string {
  const at = address.indexOf("?");
  return at < 0 ? "" : (address.slice(at + 1).split("#")[0] ?? "");
}

/**
 * The one-time code out of whatever the user pasted back. Three forms are taken: the address carrying the code as a
 * parameter, the address carrying the whole hand-off in one base64 argument (how the end page is told what to do on a
 * phone), and a bare code the user picked out — it has no query and no scheme.
 *
 * @param pasted what was pasted (unchecked input from the settings panel)
 * @returns the code and the form it came in, or why it was refused
 */
export function codeFrom(pasted: unknown): { code: string; form: PastedForm } | { refused: string } {
  if (typeof pasted !== "string" || pasted.trim().length === 0) {
    return { refused: NOTHING_PASTED };
  }
  const text = pasted.trim();
  const query = rawQuery(text);
  const plain = codeParameter(query);
  if (plain !== undefined) {
    return { code: plain, form: "parameter" };
  }
  const handed = handedOver(query);
  if (handed !== undefined) {
    const inside = codeParameter(rawQuery(handed));
    if (inside !== undefined) {
      return { code: inside, form: "handedOver" };
    }
  }
  const error = new URLSearchParams(query).get("error");
  if (error !== null) {
    return { refused: `the sign-in was refused: ${error}` };
  }
  if (text.includes("?") || text.includes("/")) {
    return { refused: "that address carries no code — paste the address of the page the sign-in ended on" };
  }
  return { code: text, form: "bare" };
}
