import React from "react";

import { Box, Button, TextField, Typography } from "@mui/material";
import CheckCircleIcon from "@mui/icons-material/CheckCircle";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlined";
import LoginIcon from "@mui/icons-material/Login";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import NetworkCheckIcon from "@mui/icons-material/NetworkCheck";
import RefreshIcon from "@mui/icons-material/Refresh";
import LogoutIcon from "@mui/icons-material/Logout";

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from "@iobroker/json-config";
import { I18n } from "@iobroker/gui-components";

// The adapter's own helpers — the panel imports them rather than keeping a second copy
// (fleet rule: the helper exists once per repo, `error-text-helper`).
import { errText } from "../../src/lib/err-text";
import { parseRefusal, signInProblem } from "../../src/lib/sign-in-help";

interface SignInState extends ConfigGenericState {
  /** The live verification URL (empty when none / already signed in). */
  url: string;
  /** Whether the adapter is signed in AND its live event stream is up (info.connection). */
  connected: boolean;
  /** Whether the adapter holds a usable Home Connect login (auth.signedIn). */
  signedIn: boolean;
  /** What Home Connect said when it refused the sign-in (auth.lastError): "" = fine, "Unknown" = nothing asked yet. */
  lastError: string;
  /** Whether a connection test is in flight. */
  testing: boolean;
  /** The last connection test's answer — the adapter's own words, not a guess. */
  testResult: { ok: boolean; text: string } | null;
  /** Whether a sign-in action (new link, reset) is in flight. */
  acting: boolean;
  /** Whether the reset waits for its confirmation. */
  confirmReset: boolean;
  /** The last sign-in action's answer — the adapter's own words. */
  actionResult: { ok: boolean; text: string } | null;
  /** The app access: what the user pasted so far (a draft of the panel's own — no setting, never saved). */
  pasted: string;
}

/**
 * How long the panel waits for the adapter's answer. The socket's `sendTo` has no timeout of its
 * own; the adapter's worst case (a connection test) is a GET, a token refresh and a second GET of
 * 20 s each — a shorter limit would report "no answer" while the adapter is still working.
 */
const ANSWER_TIMEOUT_MS = 70_000;

/**
 * The code a sign-in link carries (`…?user_code=XXXX-XXXX`), so the user can check it against the
 * page Home Connect shows.
 *
 * @param url the verification link
 * @returns the code, or undefined when the link carries none
 */
export function userCodeOf(url: string): string | undefined {
  try {
    const code = new URL(url).searchParams.get("user_code");
    return code && code.trim().length > 0 ? code.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `auth.lastError` reports a refusal worth showing — "" means all is well and "Unknown"
 * that nothing was asked yet (the fleet's reason-text rule).
 *
 * @param text the state value
 * @returns whether there is a refusal to show
 */
export function isRefusal(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed !== "Unknown";
}

/**
 * Live sign-in panel (jsonConfig `type: custom`). Reads `auth.verificationUrl`, `auth.signedIn`,
 * `auth.lastError` and `info.connection` over the admin socket and shows one of: signed in with live
 * updates, signed in but live updates down, the sign-in link with its code (open + copy), or — with
 * no link — a button to request one. A refusal by Home Connect shows what to do, in the admin's
 * language, with Home Connect's own words below it. "Test connection" asks the running adapter for a
 * real request to Home Connect; "Reset sign-in" forgets the login and starts a new one.
 *
 * The app access (beta, setting `accessMode: "app"`): without an open sign-in page a button asks the adapter for
 * one (`appSignInLink`) and opens it in a new tab; with one open, the page as a link, a field for the address the
 * sign-in ended on and a button that hands it to the adapter (`appSignInComplete` with `{ address }`). The adapter's
 * answer stands below, word for word.
 */
export default class SignIn extends ConfigGeneric<ConfigGenericProps, SignInState> {
  private urlId = "";
  private connId = "";
  private signedInId = "";
  private lastErrorId = "";
  /** Set when the panel closes — async work that finishes afterwards subscribes and renders nothing. */
  private unmounted = false;

  /**
   * @param props the jsonConfig props of the custom component
   */
  constructor(props: ConfigGenericProps) {
    super(props);
    this.state = {
      ...this.state,
      url: "",
      connected: false,
      signedIn: false,
      lastError: "",
      testing: false,
      testResult: null,
      acting: false,
      confirmReset: false,
      actionResult: null,
      pasted: "",
    };
  }

  /**
   * Whether the settings choose the Home Connect app access — the form's value, so the panel follows the selection
   * before it is saved (the adapter answers for the access it runs with and says so).
   *
   * @returns true for the app access (beta)
   */
  private appMode(): boolean {
    return ConfigGeneric.getValue(this.props.data, "accessMode") === "app";
  }

  private readonly onUrl = (_id: string, state: ioBroker.State | null | undefined): void => {
    this.setState({ url: typeof state?.val === "string" ? state.val : "" });
  };

  private readonly onConn = (_id: string, state: ioBroker.State | null | undefined): void => {
    this.setState({ connected: state?.val === true });
  };

  private readonly onSignedIn = (_id: string, state: ioBroker.State | null | undefined): void => {
    this.setState({ signedIn: state?.val === true });
  };

  private readonly onLastError = (_id: string, state: ioBroker.State | null | undefined): void => {
    this.setState({ lastError: typeof state?.val === "string" ? state.val : "" });
  };

  /** Reads the sign-in states once, then follows them live. */
  async componentDidMount(): Promise<void> {
    void super.componentDidMount?.();
    const ctx = this.props.oContext;
    const ns = `${ctx.adapterName}.${ctx.instance}`;
    this.urlId = `${ns}.auth.verificationUrl`;
    this.connId = `${ns}.info.connection`;
    this.signedInId = `${ns}.auth.signedIn`;
    this.lastErrorId = `${ns}.auth.lastError`;
    try {
      const [url, conn, signedIn, lastError] = await Promise.all([
        ctx.socket.getState(this.urlId),
        ctx.socket.getState(this.connId),
        ctx.socket.getState(this.signedInId),
        ctx.socket.getState(this.lastErrorId),
      ]);
      if (this.unmounted) {
        return;
      }
      this.setState({
        url: typeof url?.val === "string" ? url.val : "",
        connected: conn?.val === true,
        signedIn: signedIn?.val === true,
        lastError: typeof lastError?.val === "string" ? lastError.val : "",
      });
    } catch {
      // The states may not exist until the adapter first runs — the hint below covers it.
    }
    // Subscribed regardless of the first read: a panel opened before the
    // adapter's first run used to stay frozen for the rest of the session
    // because a failed read skipped the subscriptions along with it. Not after
    // the panel closed during the reads: the unsubscribe already ran, and these
    // subscriptions would leak with handlers rendering into nothing.
    if (this.unmounted) {
      return;
    }
    try {
      await ctx.socket.subscribeState(this.urlId, this.onUrl);
      await ctx.socket.subscribeState(this.connId, this.onConn);
      await ctx.socket.subscribeState(this.signedInId, this.onSignedIn);
      await ctx.socket.subscribeState(this.lastErrorId, this.onLastError);
    } catch {
      // No live updates then — the reads above already set what is known.
    }
  }

  /** Stops following the sign-in states. */
  componentWillUnmount(): void {
    this.unmounted = true;
    const socket = this.props.oContext?.socket;
    if (socket && this.urlId) {
      socket.unsubscribeState(this.urlId, this.onUrl);
      socket.unsubscribeState(this.connId, this.onConn);
      socket.unsubscribeState(this.signedInId, this.onSignedIn);
      socket.unsubscribeState(this.lastErrorId, this.onLastError);
    }
    super.componentWillUnmount?.();
  }

  /**
   * Send a command to the running adapter and read its `{ result }` / `{ error }` answer — with a
   * time limit, because the socket's `sendTo` never gives up on its own (an instance that died after
   * the click left the button busy until the page was reloaded).
   *
   * @param command the message command
   * @param message the message body
   * @returns the answer, or `{ ok: false, text }` for no answer or a failing socket
   */
  private async ask(command: string, message: Record<string, unknown> = {}): Promise<{ ok: boolean; text: string }> {
    const ctx = this.props.oContext;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<undefined>(resolve => {
        timer = setTimeout(() => resolve(undefined), ANSWER_TIMEOUT_MS);
      });
      const answer = await Promise.race([
        ctx.socket.sendTo<{ result?: unknown; error?: unknown } | null | undefined>(
          `${ctx.adapterName}.${ctx.instance}`,
          command,
          message,
        ),
        timeout,
      ]);
      if (answer && typeof answer.error === "string") {
        return { ok: false, text: answer.error };
      }
      if (answer && typeof answer.result === "string") {
        return { ok: true, text: answer.result };
      }
      return { ok: false, text: I18n.t("hc_noAnswer") };
    } catch (e) {
      return { ok: false, text: errText(e) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Ask the running adapter for a real connection check and show its answer verbatim. */
  private async runTest(): Promise<void> {
    this.setState({ testing: true, testResult: null });
    const result = await this.ask("checkConnection");
    if (this.unmounted) {
      return;
    }
    this.setState({ testResult: result });
    this.setState({ testing: false });
  }

  /**
   * Run a sign-in action (a new link, or the reset) and show the adapter's answer.
   *
   * @param command `requestSignIn` or `resetLogin`
   */
  private async runAction(command: "requestSignIn" | "resetLogin"): Promise<void> {
    this.setState({ acting: true, actionResult: null, confirmReset: false });
    const result = await this.ask(command);
    if (this.unmounted) {
      return;
    }
    this.setState({ actionResult: result });
    this.setState({ acting: false });
  }

  /**
   * The app access: ask the adapter for a sign-in page and open it in a new tab. The page also shows as a link in
   * the panel (a browser that blocks the tab leaves the user that link); the new tab gets no handle on the admin.
   */
  private async openAppPage(): Promise<void> {
    this.setState({ acting: true, actionResult: null, confirmReset: false });
    const result = await this.ask("appSignInLink");
    if (this.unmounted) {
      return;
    }
    if (result.ok) {
      this.setState({ url: result.text });
      const tab = window.open(result.text, "_blank");
      if (tab) {
        tab.opener = null;
      }
    } else {
      this.setState({ actionResult: result });
    }
    this.setState({ acting: false });
  }

  /** The app access: hand the pasted address to the adapter; a sign-in that worked empties the field. */
  private async finishAppSignIn(): Promise<void> {
    this.setState({ acting: true, actionResult: null, confirmReset: false });
    const result = await this.ask("appSignInComplete", { address: this.state.pasted });
    if (this.unmounted) {
      return;
    }
    if (result.ok) {
      this.setState({ actionResult: result, pasted: "" });
    } else {
      this.setState({ actionResult: result });
    }
    this.setState({ acting: false });
  }

  private renderProblem(): React.JSX.Element | null {
    if (this.state.signedIn || !isRefusal(this.state.lastError)) {
      return null;
    }
    const { code, description } = parseRefusal(this.state.lastError);
    // The developer access's hints point to the Client ID and the developer portal — the app access has neither,
    // its way out of every refusal is a new sign-in.
    const hint = this.appMode() ? I18n.t("hc_appProblem") : I18n.t(`hc_problem_${signInProblem(code, description)}`);
    return (
      <Box
        sx={{ mb: 2, color: "error.main" }}
        data-testid="hc-problem"
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <ErrorOutlineIcon />
          <Typography>{hint}</Typography>
        </Box>
        <Typography
          variant="body2"
          sx={{ mt: 0.5, opacity: 0.8 }}
        >
          {I18n.t("hc_problemAnswer", this.state.lastError)}
        </Typography>
      </Box>
    );
  }

  private renderStatus(): React.JSX.Element {
    if (this.state.connected) {
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "success.main" }}>
          <CheckCircleIcon />
          <Typography>{I18n.t("hc_signedIn")}</Typography>
        </Box>
      );
    }
    if (this.state.signedIn) {
      return (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "warning.main" }}>
          <WarningAmberIcon />
          <Typography>{I18n.t("hc_signedInNoStream")}</Typography>
        </Box>
      );
    }
    if (this.appMode()) {
      return this.renderAppSignIn();
    }
    if (this.state.url) {
      const code = userCodeOf(this.state.url);
      return (
        <Box>
          <Typography sx={{ mb: 1 }}>{I18n.t("hc_signInPrompt")}</Typography>
          {code ? (
            <Box sx={{ mb: 1 }}>
              <Typography
                variant="body2"
                sx={{ opacity: 0.8 }}
              >
                {I18n.t("hc_codeLabel")}
              </Typography>
              <Typography
                variant="h5"
                sx={{ fontFamily: "monospace", letterSpacing: "0.1em" }}
                data-testid="hc-user-code"
              >
                {code}
              </Typography>
            </Box>
          ) : null}
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
            <Button
              variant="contained"
              color="primary"
              startIcon={<LoginIcon />}
              href={this.state.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {I18n.t("hc_openSignIn")}
            </Button>
            <Button
              variant="outlined"
              startIcon={<ContentCopyIcon />}
              onClick={() => void navigator.clipboard?.writeText(this.state.url)}
            >
              {I18n.t("hc_copyLink")}
            </Button>
          </Box>
        </Box>
      );
    }
    const alive = this.props.alive === true;
    return (
      <Box>
        <Typography sx={{ opacity: 0.8, mb: 1 }}>{I18n.t("hc_signInWaiting")}</Typography>
        <Button
          variant="contained"
          color="primary"
          startIcon={<RefreshIcon />}
          disabled={!alive || this.state.acting}
          onClick={() => void this.runAction("requestSignIn")}
          data-testid="hc-request-link"
        >
          {I18n.t("hc_requestLink")}
        </Button>
      </Box>
    );
  }

  /**
   * The app access while not signed in: "sign-in needed" comes from the states alone (no login, no open page) —
   * with a page open, its link, the field for the address the sign-in ended on and the button to finish.
   *
   * @returns the app access's sign-in steps
   */
  private renderAppSignIn(): React.JSX.Element {
    const alive = this.props.alive === true;
    if (!this.state.url) {
      return (
        <Box>
          <Typography sx={{ mb: 1 }}>{I18n.t("hc_appSignInNeeded")}</Typography>
          <Button
            variant="contained"
            color="primary"
            startIcon={<LoginIcon />}
            disabled={!alive || this.state.acting}
            onClick={() => void this.openAppPage()}
            data-testid="hc-app-open"
          >
            {I18n.t("hc_openSignIn")}
          </Button>
        </Box>
      );
    }
    return (
      <Box>
        <Typography sx={{ mb: 1 }}>{I18n.t("hc_appSignInSteps")}</Typography>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center", mb: 2 }}>
          <Button
            variant="outlined"
            color="primary"
            startIcon={<LoginIcon />}
            href={this.state.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="hc-app-link"
          >
            {I18n.t("hc_openSignIn")}
          </Button>
        </Box>
        <TextField
          fullWidth
          size="small"
          label={I18n.t("hc_appPasteLabel")}
          value={this.state.pasted}
          onChange={e => this.setState({ pasted: e.target.value })}
          data-testid="hc-app-paste"
        />
        <Button
          sx={{ mt: 1 }}
          variant="contained"
          color="primary"
          disabled={!alive || this.state.acting || this.state.pasted.trim() === ""}
          onClick={() => void this.finishAppSignIn()}
          data-testid="hc-app-finish"
        >
          {I18n.t("hc_appFinish")}
        </Button>
      </Box>
    );
  }

  private renderActions(): React.JSX.Element {
    const alive = this.props.alive === true;
    return (
      <Box sx={{ mt: 2 }}>
        <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", alignItems: "center" }}>
          <Button
            variant="outlined"
            startIcon={<NetworkCheckIcon />}
            disabled={!alive || this.state.testing}
            onClick={() => void this.runTest()}
            data-testid="hc-test-connection"
          >
            {I18n.t(this.state.testing ? "hc_testing" : "hc_testConnection")}
          </Button>
          {this.state.confirmReset ? null : (
            <Button
              variant="outlined"
              color="warning"
              startIcon={<LogoutIcon />}
              disabled={!alive || this.state.acting}
              onClick={() => this.setState({ confirmReset: true, actionResult: null })}
              data-testid="hc-reset"
            >
              {I18n.t("hc_resetLogin")}
            </Button>
          )}
          {!alive ? <Typography sx={{ opacity: 0.8 }}>{I18n.t("hc_notRunning")}</Typography> : null}
        </Box>
        {this.state.confirmReset ? (
          <Box
            sx={{ mt: 1 }}
            data-testid="hc-reset-confirm"
          >
            <Typography sx={{ mb: 1 }}>{I18n.t("hc_resetConfirm")}</Typography>
            <Box sx={{ display: "flex", gap: 1 }}>
              <Button
                variant="contained"
                color="warning"
                disabled={!alive || this.state.acting}
                onClick={() => void this.runAction("resetLogin")}
                data-testid="hc-reset-yes"
              >
                {I18n.t("hc_resetYes")}
              </Button>
              <Button
                variant="outlined"
                onClick={() => this.setState({ confirmReset: false })}
              >
                {I18n.t("hc_cancel")}
              </Button>
            </Box>
          </Box>
        ) : null}
        {this.state.testResult ? (
          <Typography
            sx={{ mt: 1, color: this.state.testResult.ok ? "success.main" : "error.main" }}
            data-testid="hc-test-result"
          >
            {this.state.testResult.text}
          </Typography>
        ) : null}
        {this.state.actionResult ? (
          <Typography
            sx={{ mt: 1, color: this.state.actionResult.ok ? "success.main" : "error.main" }}
            data-testid="hc-action-result"
          >
            {this.state.actionResult.text}
          </Typography>
        ) : null}
      </Box>
    );
  }

  /**
   * @returns the sign-in panel
   */
  renderItem(): React.JSX.Element {
    // The wrapper always mounts (whatever the sign-in state) — the render-check keys on it.
    return (
      <Box data-testid="hc-signin">
        {this.renderProblem()}
        {this.renderStatus()}
        {this.renderActions()}
      </Box>
    );
  }
}
