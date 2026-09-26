import { describe, it, expect } from "vitest";
import { ID_SCHEME, deviceIdFor, legacyRootOf, modelPart, pieceNumber } from "./device-id";

describe("pieceNumber", () => {
  it("takes the whole haId when it is one number", () => {
    expect(pieceNumber("015090396331005775")).toBe("015090396331005775");
  });

  it("takes the part after the last hyphen of a brand-model-number haId", () => {
    expect(pieceNumber("SIEMENS-HCS02DWH1-83D908F0FC7F")).toBe("83d908f0fc7f");
    expect(pieceNumber("BOSCH-WAT28420-68A40E251CB1")).toBe("68a40e251cb1");
  });

  it("keeps letters and digits only, and falls back to the whole id when the last part is empty", () => {
    expect(pieceNumber("SIEMENS-HC.S02-")).toBe("siemenshcs02");
    expect(pieceNumber("---")).toBeUndefined();
  });
});

describe("modelPart", () => {
  it("prefers the model code", () => {
    expect(modelPart({ haId: "x", vib: "SX87TX02CE", enumber: "SX87TX02CE/60", type: "Dishwasher" })).toBe(
      "sx87tx02ce",
    );
  });

  it("takes the E-number without its variant when there is no model code", () => {
    expect(modelPart({ haId: "x", enumber: "KG49NSBBF/03" })).toBe("kg49nsbbf");
    expect(modelPart({ haId: "x", vib: "  ", enumber: "WN54C2A40/05" })).toBe("wn54c2a40");
  });

  it("falls back to the appliance type, then to device", () => {
    expect(modelPart({ haId: "x", type: "WasherDryer" })).toBe("washerdryer");
    expect(modelPart({ haId: "x", vib: 42, enumber: "/", type: "" })).toBe("device");
  });
});

describe("deviceIdFor", () => {
  it("is the model and the last four characters of the piece number", () => {
    expect(deviceIdFor({ haId: "015090396331005775", vib: "SX87TX02CE" }, new Set())).toBe("sx87tx02ce-5775");
    expect(deviceIdFor({ haId: "505090394546005180", vib: "KG49NSBBF" }, new Set())).toBe("kg49nsbbf-5180");
    expect(deviceIdFor({ haId: "875070392600001079", vib: "WN54C2A40" }, new Set())).toBe("wn54c2a40-1079");
    expect(deviceIdFor({ haId: "SIEMENS-HCS02DWH1-83D908F0FC7F", vib: "HCS02DWH1" }, new Set())).toBe("hcs02dwh1-fc7f");
  });

  it("gives two appliances of one model two ids", () => {
    const first = deviceIdFor({ haId: "015090396331005775", vib: "SX87TX02CE" }, new Set());
    const second = deviceIdFor({ haId: "015090396331008812", vib: "SX87TX02CE" }, new Set([first]));
    expect([first, second]).toEqual(["sx87tx02ce-5775", "sx87tx02ce-8812"]);
  });

  it("gives the whole piece number when another appliance of the model holds the same four characters", () => {
    expect(deviceIdFor({ haId: "015090396331015775", vib: "SX87TX02CE" }, new Set(["sx87tx02ce-5775"]))).toBe(
      "sx87tx02ce-015090396331015775",
    );
  });

  it("counts on only when even the whole piece number is taken", () => {
    expect(deviceIdFor({ haId: "HA-1", vib: "OVEN" }, new Set(["oven-1"]))).toBe("oven-1-2");
    expect(deviceIdFor({ haId: "---", vib: "OVEN" }, new Set(["oven"]))).toBe("oven-2");
  });

  it("never hands out the instance's own roots", () => {
    expect(deviceIdFor({ haId: "---", vib: "info" }, new Set())).toBe("info-2");
    expect(deviceIdFor({ haId: "---", type: "auth" }, new Set())).toBe("auth-2");
  });
});

describe("legacyRootOf", () => {
  it("is the haId as the community 1.6.x adapter used it: without a trailing -001", () => {
    expect(legacyRootOf("015090396331005775")).toBe("015090396331005775");
    expect(legacyRootOf("SIEMENS-HCS02DWH1-83D908F0FC7F")).toBe("SIEMENS-HCS02DWH1-83D908F0FC7F");
    expect(legacyRootOf("BOSCH-HCS06COM1-A1B2C3-001")).toBe("BOSCH-HCS06COM1-A1B2C3");
  });
});

describe("ID_SCHEME", () => {
  it("is the third generation of the rule (name, E-number, model + piece number)", () => {
    expect(ID_SCHEME).toBe(3);
  });
});
