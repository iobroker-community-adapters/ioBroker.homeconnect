import { describe, expect, it, vi } from "vitest";

import { LogRing } from "./log-ring";
import { leaked } from "./placeholders";
import { ReportJobs } from "./report-jobs";
import {
  HomeConnectReportSource,
  LIVE_PATHS,
  SECRET_MARK,
  blankSecrets,
  type LiveAnswer,
  type ReportAppliance,
  type ReportHost,
} from "./report-source";
import { TrafficRecorder } from "./traffic-recorder";

const WASHER: ReportAppliance = {
  id: "wn54c2a40-3456",
  haId: "SIEMENS-WN54C2A40-012345678901234567",
  name: "Waschküche Trockner",
  connected: true,
};
const FRIDGE: ReportAppliance = {
  id: "kg49nsbbf-0143",
  haId: "013090389567000143",
  name: "Kühlschrank Oma",
  connected: false,
};
const TOKEN = "eyJ.access.token-value-0123456789";
const CLIENT_ID = "A1B2C3D4E5F6A7B8C9D0E1F2A3B4C5D6E7F8A9B0C1D2E3F4A5B6C7D8E9F0A1B2";

/**
 * A running adapter with two appliances, the washer reachable.
 *
 * @param over what a test changes
 * @returns the host
 */
function makeHost(over: Partial<ReportHost> = {}): ReportHost & { reads: string[] } {
  const recorder = new TrafficRecorder(() => 0);
  const logRing = new LogRing(100, () => 0);
  const reads: string[] = [];
  const ns = "homeconnect.0";
  return {
    reads,
    namespace: ns,
    version: "2.0.0",
    hostName: "server",
    systemLanguage: "de",
    startedAt: 0,
    logRing,
    recorder,
    log: { info: vi.fn(), warn: vi.fn() },
    appliances: () => [WASHER, FRIDGE],
    config: () => ({ clientIdSet: true, clientSecretSet: false }),
    adapterState: () => ({ signedIn: true, streamUp: true, token: TOKEN }),
    applianceState: () => ({ unsupportedPrograms: [] }),
    secrets: () => [TOKEN, CLIENT_ID],
    liveReadBlocked: () => undefined,
    readRaw: path => {
      reads.push(path);
      return Promise.resolve({ path, status: 200, data: { haId: WASHER.haId, name: WASHER.name } });
    },
    getForeignObjectAsync: id =>
      Promise.resolve(
        id === `${ns}.${WASHER.id}`
          ? (structuredClone({
              type: "device",
              common: { name: WASHER.name },
              native: { haId: WASHER.haId, vib: "WN54C2A40" },
            }) as never)
          : null,
      ),
    getForeignStatesAsync: () =>
      Promise.resolve({
        [`${ns}.${WASHER.id}.programs.programName`]: { val: "Omas Wolle", ack: true, ts: 0 } as ioBroker.State,
        [`${ns}.${WASHER.id}.status.operationState`]: { val: "ready", ack: true, ts: 0 } as ioBroker.State,
      }),
    getObjectViewAsync: () =>
      Promise.resolve({
        rows: [
          {
            id: `${ns}.${WASHER.id}.programs.programName`,
            value: { common: { type: "string", role: "text" } } as never,
          },
          {
            id: `${ns}.${WASHER.id}.status.operationState`,
            value: { common: { type: "string", role: "text" } } as never,
          },
        ],
      }),
    ...over,
  };
}

describe("HomeConnectReportSource", () => {
  it("lists every appliance with its connection", () => {
    const source = new HomeConnectReportSource(makeHost());
    expect(source.devices()).toEqual([
      { id: WASHER.id, label: WASHER.name, connected: true },
      { id: FRIDGE.id, label: FRIDGE.name, connected: false },
    ]);
  });

  it("reads the fixed resources of the appliance in order", async () => {
    const host = makeHost();
    const answers = await new HomeConnectReportSource(host).readLive(WASHER.id);
    const base = `/api/homeappliances/${encodeURIComponent(WASHER.haId)}`;
    expect(host.reads).toEqual(LIVE_PATHS.map(p => `${base}${p}`));
    expect(answers.map(a => a.path)).toEqual(LIVE_PATHS.map(p => p || "/"));
  });

  it("refuses a device it does not know", async () => {
    await expect(new HomeConnectReportSource(makeHost()).readLive("nope")).rejects.toThrow(/unknown device 'nope'/);
  });

  it("blanks a secret in texts, keys, lists and nested objects, and keeps lists lists", () => {
    const out = blankSecrets({ [TOKEN]: [TOKEN, { deep: `Bearer ${TOKEN}` }, 3], n: null }, [TOKEN, " "]);
    expect(out).toEqual({ [SECRET_MARK]: [SECRET_MARK, { deep: `Bearer ${SECRET_MARK}` }, 3], n: null });
  });

  it("records a stream event with an empty or a non-object body under its type alone", () => {
    const recorder = new TrafficRecorder(() => 0);
    recorder.stream({ event: "KEEP", data: "", id: WASHER.haId });
    recorder.stream({ event: "NOTIFY", data: "null", id: WASHER.haId });
    expect(recorder.snapshot(WASHER.haId).stream.map(e => e.content)).toEqual([
      { event: "KEEP", data: "" },
      { event: "NOTIFY", data: null },
    ]);
  });

  it("asks an appliance without programs no program path (each would be an error answer)", async () => {
    const host = makeHost({ applianceState: () => ({ type: "FridgeFreezer", unsupportedPrograms: [] }) });
    const answers = await new HomeConnectReportSource(host).readLive(WASHER.id);
    expect(answers.map(a => a.path)).toEqual(["/", "/status", "/settings"]);
    expect(host.reads.filter(path => path.includes("/programs"))).toEqual([]);
  });

  it("stops at the first request nobody answered, and fails when nothing answered (DB-02)", async () => {
    const host = makeHost({
      readRaw: path => Promise.resolve({ path, status: 0, error: "This operation was aborted" }),
    });
    await expect(new HomeConnectReportSource(host).readLive(WASHER.id)).rejects.toThrow(/answered nothing/);
    const reads: string[] = [];
    const silentLater = makeHost({
      readRaw: path => {
        reads.push(path);
        return Promise.resolve(reads.length === 1 ? { path, status: 200, data: {} } : { path, status: 0 });
      },
    });
    const answers = await new HomeConnectReportSource(silentLater).readLive(WASHER.id);
    expect(answers.map(a => a.status)).toEqual([200, 0]);
  });

  it("sends no request while requests are blocked, and says why", async () => {
    const host = makeHost({ liveReadBlocked: () => "Home Connect blocks requests for another 40 s" });
    await expect(new HomeConnectReportSource(host).readLive(WASHER.id)).rejects.toThrow(/40 s/);
    expect(host.reads).toEqual([]);
  });

  it("takes the recorded traffic before the live read", async () => {
    const host = makeHost();
    host.recorder.rest({ method: "GET", path: `/api/homeappliances/${WASHER.haId}/status`, status: 503 });
    const readRaw = host.readRaw;
    host.readRaw = (path: string): Promise<LiveAnswer> => {
      host.recorder.rest({ method: "GET", path, status: 200 });
      return readRaw(path);
    };
    const source = new HomeConnectReportSource(host);
    const live = await source.readLive(WASHER.id);
    const body = await source.build(WASHER.id, live, undefined);
    const traffic = body.content.traffic as { rest: Array<{ content: { status: number } }> };
    expect(traffic.rest.map(e => e.content.status)).toEqual([503]);
  });

  it("says why there is no live read", async () => {
    const body = await new HomeConnectReportSource(makeHost()).build(FRIDGE.id, undefined, undefined);
    // not connected: the frame says so, the body adds no fixed sentence (DB-14)
    expect(body.content.live).toBeUndefined();
    const failed = await new HomeConnectReportSource(makeHost()).build(WASHER.id, undefined, "quota");
    expect(failed.content.live).toEqual({ error: "quota" });
  });

  it("shows no serial, name, token or client id of the user in plain text (DB-04, DB-05)", async () => {
    const host = makeHost();
    host.logRing.add("info", `${WASHER.name} (${WASHER.id}): finished — ${FRIDGE.haId} is offline`);
    host.logRing.add("debug", "appliance serial 012345678901234567 answered");
    host.recorder.rest({ method: "GET", path: "/api/homeappliances", status: 200, data: { homeappliances: [FRIDGE] } });
    host.recorder.stream({ event: "STATUS", data: JSON.stringify({ haId: WASHER.haId, items: [] }), id: WASHER.haId });
    const jobs = new ReportJobs(new HomeConnectReportSource(host), () => 0);
    const report = await new HomeConnectReportSource(host).build(
      WASHER.id,
      await host.readRaw("/").then(a => [a]),
      undefined,
    );
    const text = JSON.stringify(report.content);
    expect(
      leaked(text, [
        WASHER.haId,
        FRIDGE.haId,
        "012345678901234567",
        WASHER.name!,
        FRIDGE.name!,
        "Omas Wolle",
        TOKEN,
        CLIENT_ID,
      ]),
    ).toEqual([]);
    expect(text).toContain(SECRET_MARK);
    expect(report.fileId).toBe(WASHER.id);
    expect(jobs.list().map(d => d.connected)).toEqual([false, true]);
  });

  it("hides a haId whose last part is too short to stand alone as a serial", async () => {
    const odd: ReportAppliance = { id: "t58ts6bn0-0815", haId: "NEFF-T58TS6BN0-0815", connected: false };
    const host = makeHost({ appliances: () => [WASHER, odd] });
    host.recorder.rest({
      method: "GET",
      path: "/api/homeappliances",
      status: 200,
      data: { homeappliances: [{ haId: odd.haId }] },
    });
    const report = await new HomeConnectReportSource(host).build(WASHER.id, undefined, undefined);
    expect(leaked(JSON.stringify(report.content), [odd.haId])).toEqual([]);
  });

  it("keeps the log lines about another appliance out of the report", async () => {
    const host = makeHost();
    host.logRing.add("info", `${FRIDGE.id}: door open`);
    host.logRing.add("info", `${WASHER.id}: finished`);
    host.logRing.add("info", "event stream connected");
    const body = await new HomeConnectReportSource(host).build(WASHER.id, undefined, undefined);
    expect((body.content.logs as Array<{ msg: string }>).map(l => l.msg)).toEqual([
      `${WASHER.id}: finished`,
      "event stream connected",
    ]);
  });

  it("keeps the appliance's datapoints with type, role and value", async () => {
    const body = await new HomeConnectReportSource(makeHost()).build(WASHER.id, undefined, undefined);
    expect(body.content.objectTree).toContainEqual(
      expect.objectContaining({ id: "status.operationState", type: "string", role: "text", val: "ready" }),
    );
  });
});

describe("blankSecrets", () => {
  it("replaces a secret in values and keys, the longest first", () => {
    expect(blankSecrets({ [`k-${TOKEN}`]: [`x ${TOKEN} y`, 3] }, [TOKEN, "eyJ", " "])).toEqual({
      [`k-${SECRET_MARK}`]: [`x ${SECRET_MARK} y`, 3],
    });
  });
});
