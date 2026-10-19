// Fleet master (.consistency-master/src-admin/src/DiagnosticsPanel.tsx) — never edit the copy in an adapter.
//
// The diagnostics card of every adapter with a report (krobi 2026-10-06, page "Diagnosebericht — Flottenstandard"):
// all devices, connected or not (DB-03); a short sentence, the list of what the report contains, one sentence on what
// comes next (DB-09, DB-13); "Saved as <file>" with a link that opens the issue form (DB-07); the outlined privacy box
// with two points (DB-13). The adapter mounts it in a thin ConfigGeneric class and hands in its issue form and tab ids.

import React from "react";

import {
  Alert,
  Box,
  Button,
  CircularProgress,
  FormControl,
  InputLabel,
  LinearProgress,
  Link,
  MenuItem,
  Select,
  Stack,
  Typography,
} from "@mui/material";
import { I18n } from "@iobroker/gui-components";

import { errText } from "../../src/lib/err-text";
import type { ReportDevice } from "../../src/lib/diagnostics/report-jobs";
import {
  InstanceUnavailableError,
  isReport,
  makeDiagnosticsApi,
  type DiagnosticsSocket,
  type DiagnosticsTimeouts,
} from "./diagnosticsApi";
import { registerDiagnosticsTexts } from "./diagnosticsTexts";
import { forgetLastTab } from "./tabMemory";

/**
 * The link to the adapter's issue form that asks for the report (`.github/ISSUE_TEMPLATE/device-support.yml`).
 *
 * @param repository the adapter's GitHub repository, e.g. `https://github.com/owner/ioBroker.demo`
 * @returns the URL that opens the form directly
 */
export function issueFormUrl(repository: string): string {
  return `${repository.replace(/\/+$/, "")}/issues/new?template=device-support.yml`;
}

/** Props of the diagnostics card. */
export interface DiagnosticsPanelProps {
  /** The admin socket for the sendTo round trips. */
  socket: unknown;
  /** The instance, e.g. `demo.0`. */
  namespace: string;
  /** The adapter's GitHub repository, e.g. `https://github.com/owner/ioBroker.demo`. */
  repository: string;
  /** The tab ids of the adapter's `admin/jsonConfig.json` — the settings open on the first one again. */
  tabIds: readonly string[];
  /** How long the card waits — the defaults outside tests. */
  timeouts?: DiagnosticsTimeouts;
}

/** What the card knows about its device list. */
type ListState =
  { status: "loading" } | { status: "ready"; devices: ReportDevice[] } | { status: "failed"; message: string };

/**
 * What the card says when a call got no answer: the instance is not running, it stopped while the card
 * waited, it did not answer in time — or the failure's own words, and the fallback when it has none.
 *
 * @param e the failure
 * @param fallback the words when the failure says nothing
 */
export function failureText(e: unknown, fallback: string): string {
  if (e instanceof InstanceUnavailableError) {
    if (e.reason === "notRunning") {
      return I18n.t("diag_notRunning");
    }
    if (e.reason === "stopped") {
      return I18n.t("diag_stopped");
    }
    return I18n.t("diag_noAnswer", String(e.seconds));
  }
  return e instanceof Error && e.message ? errText(e) : fallback;
}

/**
 * Hand the browser a file. The adapter writes the report nowhere and drops it once handed over, so the download is
 * the copy the user attaches to an issue.
 *
 * @param fileName the name to save it under
 * @param content the report JSON
 */
export function offerDownload(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start the download before the blob goes away.
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

/**
 * The diagnostics card: pick a device, press one button, get a file.
 *
 * @param root0 props
 * @param root0.socket the admin socket
 * @param root0.namespace the instance
 * @param root0.repository the adapter's GitHub repository
 * @param root0.tabIds the tab ids of the adapter's settings
 * @param root0.timeouts how long the card waits (tests only)
 */
export function DiagnosticsPanel({
  socket,
  namespace,
  repository,
  tabIds,
  timeouts,
}: DiagnosticsPanelProps): React.JSX.Element {
  registerDiagnosticsTexts((words, lang) => I18n.extendTranslations(words, lang as ioBroker.Languages));
  const api = React.useMemo(
    () => makeDiagnosticsApi(socket as DiagnosticsSocket, namespace, timeouts),
    [socket, namespace, timeouts],
  );
  const [list, setList] = React.useState<ListState>({ status: "loading" });
  const [selected, setSelected] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [done, setDone] = React.useState("");
  /** Seconds since the report was asked for — the read takes up to a minute, the card counts along. */
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (!busy) {
      return undefined;
    }
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  React.useEffect(() => {
    forgetLastTab(namespace, tabIds);
    return () => forgetLastTab(namespace, tabIds);
  }, [namespace, tabIds]);

  React.useEffect(() => {
    let alive = true;
    api
      .listDevices()
      .then(devices => {
        if (alive) {
          setList({ status: "ready", devices });
          // One device is the common case — pre-selected, the card is a single click.
          if (devices.length === 1) {
            setSelected(devices[0].value);
          }
        }
      })
      .catch((e: unknown) => {
        if (alive) {
          setList({ status: "failed", message: failureText(e, I18n.t("diag_listFailed")) });
        }
      });
    return () => {
      alive = false;
    };
  }, [api]);

  const onExport = React.useCallback((): void => {
    setBusy(true);
    setError("");
    setDone("");
    api
      .exportReport(selected)
      .then(res => {
        if (isReport(res)) {
          offerDownload(res.fileName, res.content);
          setDone(res.fileName);
        } else {
          setError(res.error || I18n.t("diag_exportFailed"));
        }
      })
      // A stopped or restarted instance, or no answer in time, ends the wait too — the button is free again.
      .catch((e: unknown) => setError(failureText(e, I18n.t("diag_exportFailed"))))
      .finally(() => setBusy(false));
  }, [api, selected]);

  if (list.status === "loading") {
    return (
      <Box sx={{ p: 2 }}>
        <Stack
          direction="row"
          spacing={2}
          sx={{ alignItems: "center" }}
        >
          <CircularProgress size={24} />
          <Typography variant="body2">{I18n.t("diag_loadingDevices")}</Typography>
        </Stack>
      </Box>
    );
  }
  if (list.status === "failed") {
    return (
      <Box sx={{ p: 2 }}>
        <Alert
          severity="error"
          data-testid="diag-list-failed"
        >
          {list.message}
        </Alert>
      </Box>
    );
  }
  const devices = list.devices;
  const chosen = devices.find(d => d.value === selected);

  return (
    <Box sx={{ p: 2, maxWidth: 720 }}>
      <Stack spacing={2}>
        <Box data-testid="diag-intro">
          <Typography variant="body2">{I18n.t("diag_intro")}</Typography>
          <Typography
            variant="body2"
            sx={{ mt: 1 }}
          >
            {I18n.t("diag_contains")}
          </Typography>
          <Box
            component="ul"
            sx={{ m: 0, pl: 3 }}
          >
            {(["diag_containsWhat", "diag_containsDatapoints", "diag_containsLog"] as const).map(key => (
              <Typography
                key={key}
                component="li"
                variant="body2"
              >
                {I18n.t(key)}
              </Typography>
            ))}
          </Box>
          <Typography
            variant="body2"
            sx={{ mt: 1 }}
          >
            {I18n.t("diag_after")}
          </Typography>
        </Box>

        {devices.length === 0 ? (
          <Alert
            severity="info"
            data-testid="diag-no-devices"
          >
            {I18n.t("diag_noDevices")}
          </Alert>
        ) : (
          <>
            <FormControl fullWidth>
              <InputLabel id="diag-device">{I18n.t("diag_device")}</InputLabel>
              <Select
                data-testid="diag-device-select"
                labelId="diag-device"
                label={I18n.t("diag_device")}
                value={selected}
                onChange={e => setSelected(String(e.target.value))}
              >
                {devices.map(d => (
                  <MenuItem
                    key={d.value}
                    value={d.value}
                  >
                    {d.connected ? d.label : `${d.label} — ${I18n.t("diag_notConnected")}`}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>

            {chosen && !chosen.connected ? <Alert severity="warning">{I18n.t("diag_offlineHint")}</Alert> : null}

            <Box>
              <Button
                data-testid="diag-export"
                variant="contained"
                disabled={!selected || busy}
                onClick={onExport}
                startIcon={busy ? <CircularProgress size={16} /> : undefined}
              >
                {busy ? I18n.t("diag_reading") : I18n.t("diag_export")}
              </Button>
            </Box>
          </>
        )}

        {busy ? (
          <Alert
            severity="info"
            data-testid="diag-generating"
          >
            <Typography variant="body2">{I18n.t("diag_generating")}</Typography>
            <LinearProgress sx={{ my: 1 }} />
            <Typography
              variant="caption"
              color="text.secondary"
              data-testid="diag-elapsed"
            >
              {I18n.t("diag_elapsed", String(elapsed))}
            </Typography>
          </Alert>
        ) : null}

        {done ? (
          <Alert
            severity="success"
            data-testid="diag-done"
          >
            {I18n.t("diag_done", done)}{" "}
            <Link
              href={issueFormUrl(repository)}
              target="_blank"
              rel="noreferrer"
            >
              {I18n.t("diag_openIssue")}
            </Link>
          </Alert>
        ) : null}
        {error ? (
          <Alert
            severity="error"
            data-testid="diag-error"
          >
            {error}
          </Alert>
        ) : null}

        <Alert
          severity="info"
          variant="outlined"
          data-testid="diag-privacy"
        >
          <Typography
            variant="body2"
            sx={{ fontWeight: 500 }}
          >
            {I18n.t("diag_privacyTitle")}
          </Typography>
          <Box
            component="ul"
            sx={{ m: 0, pl: 3 }}
          >
            {(["diag_privacyMarkers", "diag_privacyMemory"] as const).map(key => (
              <Typography
                key={key}
                component="li"
                variant="body2"
              >
                {I18n.t(key)}
              </Typography>
            ))}
          </Box>
        </Alert>
      </Stack>
    </Box>
  );
}
