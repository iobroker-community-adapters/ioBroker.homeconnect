// What a Home Connect sign-in refusal means and what to do about it — pure, shared by the adapter
// (its log line) and the settings panel (its hint in the admin's language).
//
// Home Connect answers a refused sign-in with an OAuth code AND its own explanation
// (`error_description`); the code alone does not tell the cases apart — "Invalid client id",
// "request rejected by client authorization authority (developer portal)" and "client not
// authorized for this oauth flow (grant_type)" all come as `unauthorized_client`. The texts are
// the ones Home Connect sends (api-docs, Authorization → Authorization Errors; the same texts
// homebridge-homeconnect matches in `api-ua-auth-help.ts`).

/** The kinds of refusal a user can do something about, each with its own hint. */
export type SignInProblem =
  | "clientId"
  | "notActive"
  | "wrongFlow"
  | "clientSecret"
  | "account"
  | "codeExpired"
  | "loginRevoked"
  | "scope"
  | "other";

/**
 * Sort a refusal into the kind of problem it is.
 *
 * @param code the OAuth `error` code
 * @param description Home Connect's `error_description`
 * @returns the kind of problem
 */
export function signInProblem(code: string | undefined, description: string | undefined): SignInProblem {
  const text = (description ?? "").toLowerCase();
  switch (code) {
    case "unauthorized_client":
      if (text.includes("invalid client id")) {
        return "clientId";
      }
      if (text.includes("oauth flow") || text.includes("grant_type")) {
        return "wrongFlow";
      }
      return "notActive";
    case "invalid_client":
      return "clientSecret";
    case "access_denied":
      return "account";
    case "expired_token":
      return "codeExpired";
    case "invalid_grant":
      return "loginRevoked";
    case "invalid_scope":
      return "scope";
    default:
      return "other";
  }
}

/** The English hint for the log — the admin panel shows the same one in the user's language. */
const HINTS: Record<SignInProblem, string> = {
  clientId:
    "Home Connect does not know this Client ID — copy it again from the developer portal (64 hexadecimal characters).",
  notActive:
    "Home Connect does not accept the application (yet) — a new or edited application takes 15 to 60 minutes to become active, and its status must be Enabled.",
  wrongFlow:
    "The application was created with another OAuth flow — create a new one with the OAuth flow 'Device Flow' (it cannot be changed afterwards).",
  clientSecret: "Home Connect rejected the Client Secret — check it in the adapter settings.",
  account:
    "Home Connect refused this account — check that it works in the Home Connect app (SingleKey ID, accepted terms of use).",
  codeExpired: "The sign-in code expired before it was confirmed.",
  loginRevoked: "The stored login is no longer valid — a new sign-in is needed.",
  scope: "The application may not use the requested permissions — check it in the developer portal.",
  other: "Home Connect refused the sign-in — check the Client ID and Client Secret in the adapter settings.",
};

/**
 * The hint for the log line of a refused sign-in.
 *
 * @param code the OAuth `error` code
 * @param description Home Connect's `error_description`
 * @returns one sentence
 */
export function signInHint(code: string | undefined, description: string | undefined): string {
  return HINTS[signInProblem(code, description)];
}

/**
 * Home Connect's own words for a refusal, as `auth.lastError` carries them: `code: description`,
 * or whichever of the two it sent.
 *
 * @param code the OAuth `error` code
 * @param description Home Connect's `error_description`
 * @returns the text, or undefined when Home Connect said nothing
 */
export function refusalText(code: string | undefined, description: string | undefined): string | undefined {
  if (code && description) {
    return `${code}: ${description}`;
  }
  return code ?? description;
}

/**
 * Read `auth.lastError` back into its two halves — what {@link refusalText} wrote.
 *
 * @param text the state value
 * @returns the code and the description
 */
export function parseRefusal(text: string): { code?: string; description?: string } {
  const match = /^([a-z_]+)(?::\s*(.*))?$/s.exec(text.trim());
  if (!match) {
    return { description: text.trim() || undefined };
  }
  return { code: match[1], description: match[2]?.trim() || undefined };
}

/**
 * Whether a text has the form of a Home Connect client ID: 64 hexadecimal characters (the
 * developer portal's form; homebridge-homeconnect checks the same).
 *
 * @param clientId the configured client ID, already trimmed
 * @returns whether it has that form
 */
export function looksLikeClientId(clientId: string): boolean {
  return /^[0-9A-Fa-f]{64}$/.test(clientId);
}
