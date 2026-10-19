import { describe, expect, it } from "vitest";

import { CONNECTION_HISTORY, TrafficRecorder, haIdOfPath } from "./traffic-recorder";

const HA = "SIEMENS-WN54C2A40-68A40E123456";

describe("haIdOfPath", () => {
  it("reads the appliance of an appliance path, decoded", () => {
    expect(haIdOfPath(`/api/homeappliances/${encodeURIComponent(HA)}/status`)).toBe(HA);
    expect(haIdOfPath("/api/homeappliances/013090389567000143")).toBe("013090389567000143");
  });

  it("gives no appliance for an account path", () => {
    expect(haIdOfPath("/api/homeappliances")).toBeUndefined();
    expect(haIdOfPath("/security/oauth/token")).toBeUndefined();
  });
});

describe("TrafficRecorder", () => {
  it("keeps a GET under the appliance's rest, a write under its writes, an account path under the account", () => {
    const rec = new TrafficRecorder(() => 0);
    rec.rest({ method: "GET", path: `/api/homeappliances/${HA}/status`, status: 200, data: { status: [] } });
    rec.rest({ method: "PUT", path: `/api/homeappliances/${HA}/settings/X`, status: 409, error: "SDK.Error.X" });
    rec.rest({ method: "GET", path: "/api/homeappliances", status: 200, data: { homeappliances: [] } });
    const trail = rec.snapshot(HA);
    expect(trail.rest.map(e => e.content?.path)).toEqual([`/api/homeappliances/${HA}/status`]);
    expect(trail.writes.map(e => e.content?.error)).toEqual(["SDK.Error.X"]);
    expect(rec.account().rest.map(e => e.content?.path)).toEqual(["/api/homeappliances"]);
  });

  it("counts the same answer instead of stacking it (R1)", () => {
    const rec = new TrafficRecorder(() => 0);
    for (let i = 0; i < 5; i++) {
      rec.rest({ method: "GET", path: `/api/homeappliances/${HA}/status`, status: 200, data: { i } });
    }
    const [entry] = rec.snapshot(HA).rest;
    expect(entry.count).toBe(5);
    expect(entry.content?.data).toEqual({ i: 4 });
  });

  it("records the token endpoint by status and code only, never a body", () => {
    const rec = new TrafficRecorder(() => 0);
    rec.token("/security/oauth/token", 400, "invalid_grant");
    expect(rec.account().rest[0].content).toEqual({
      method: "POST",
      path: "/security/oauth/token",
      status: 400,
      error: "invalid_grant",
    });
  });

  it("files a stream event under the appliance its data or id names, one without under the account", () => {
    const rec = new TrafficRecorder(() => 0);
    const data = JSON.stringify({ haId: HA, items: [{ key: "BSH.Common.Status.DoorState", value: "Open" }] });
    rec.stream({ event: "STATUS", data, id: undefined });
    rec.stream({ event: "NOTIFY", data: "{}", id: HA });
    rec.stream({ event: "STATUS", data: "{}", id: undefined });
    expect(rec.snapshot(HA).stream.map(e => e.content)).toEqual([
      { event: "STATUS", data: JSON.parse(data) },
      { event: "NOTIFY", data: {} },
    ]);
    expect(rec.account().stream.map(e => e.content?.event)).toEqual(["STATUS"]);
  });

  it("keeps two different item keys of one event type apart", () => {
    const rec = new TrafficRecorder(() => 0);
    const send = (key: string): void =>
      rec.stream({ event: "NOTIFY", data: JSON.stringify({ items: [{ key, value: 1 }] }), id: HA });
    send("BSH.Common.Option.RemainingProgramTime");
    send("BSH.Common.Option.ProgramProgress");
    expect(rec.snapshot(HA).stream).toHaveLength(2);
  });

  it("folds stream values by event and item keys — the last value stands", () => {
    const rec = new TrafficRecorder(() => 0);
    const send = (value: number): void =>
      rec.stream({
        event: "NOTIFY",
        data: JSON.stringify({ items: [{ key: "BSH.Common.Option.RemainingProgramTime", value }] }),
        id: HA,
      });
    send(60);
    send(30);
    const entries = rec.snapshot(HA).stream;
    expect(entries).toHaveLength(1);
    expect(entries[0].count).toBe(2);
    expect(JSON.stringify(entries[0].content)).toContain('"value":30');
  });

  it("keeps the connection history in order and bounded", () => {
    let t = 0;
    const rec = new TrafficRecorder(() => t);
    for (let i = 0; i < CONNECTION_HISTORY + 5; i++) {
      t = i * 1000;
      rec.stream({ event: i % 2 === 0 ? "DISCONNECTED" : "CONNECTED", data: "", id: HA });
    }
    const history = rec.snapshot(HA).connection;
    expect(history).toHaveLength(CONNECTION_HISTORY);
    expect(history.at(-1)).toEqual({
      at: new Date((CONNECTION_HISTORY + 4) * 1000).toISOString(),
      event: "DISCONNECTED",
    });
    expect(history[0].event).toBe("CONNECTED");
  });

  it("forgets an appliance that left the account", () => {
    const rec = new TrafficRecorder(() => 0);
    rec.rest({ method: "GET", path: `/api/homeappliances/${HA}/status`, status: 200 });
    rec.stream({ event: "DEPAIRED", data: "", id: HA });
    expect(rec.snapshot(HA)).toEqual({ rest: [], writes: [], stream: [], connection: [] });
  });

  it("hands out copies — the report never changes a ring", () => {
    const rec = new TrafficRecorder(() => 0);
    rec.stream({ event: "CONNECTED", data: "", id: HA });
    rec.snapshot(HA).connection.push({ at: "x", event: "x" });
    expect(rec.snapshot(HA).connection).toHaveLength(1);
  });

  it("records what the stream itself did under the account", () => {
    const rec = new TrafficRecorder(() => 0);
    rec.streamState("refused", "429 quota");
    expect(rec.account().stream[0].content).toEqual({ event: "stream refused", data: "429 quota" });
  });
});
