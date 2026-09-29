import { describe, it, expect } from "vitest";
import { isDeviceInternalKey } from "./device-internal";

describe("appliance-internal keys (decision 48)", () => {
  it("names the connection and firmware keys of every appliance type", () => {
    expect(isDeviceInternalKey("BSH.Common.Status.BackendConnected")).toBe(true);
    expect(isDeviceInternalKey("BSH.Common.Setting.AllowBackendConnection")).toBe(true);
    expect(isDeviceInternalKey("BSH.Common.Command.DeactivateWiFi")).toBe(true);
    expect(isDeviceInternalKey("BSH.Common.Status.SoftwareUpdateTransactionID")).toBe(true);
    expect(isDeviceInternalKey("LaundryCare.Common.Status.Version.Smm.DomainFw")).toBe(true);
    expect(isDeviceInternalKey("LaundryCare.Common.Status.Version.E2e.Scope")).toBe(true);
    expect(isDeviceInternalKey("Dishcare.Dishwasher.Status.Version.Anything")).toBe(true);
  });

  it("keeps what a user reads or uses", () => {
    // A measured value, the update hints and the commands that release an update.
    expect(isDeviceInternalKey("BSH.Common.Status.WiFiSignalStrength")).toBe(false);
    expect(isDeviceInternalKey("BSH.Common.Event.SoftwareUpdateAvailable")).toBe(false);
    expect(isDeviceInternalKey("BSH.Common.Event.SoftwareUpdateSuccessful")).toBe(false);
    expect(isDeviceInternalKey("BSH.Common.Command.AllowSoftwareUpdate")).toBe(false);
    expect(isDeviceInternalKey("BSH.Common.Command.AllowSoftwareDownload")).toBe(false);
    // The user's own control over the service access.
    expect(isDeviceInternalKey("BSH.Common.Status.CustomerServiceConnectionAllowed")).toBe(false);
    // Its content is not documented anywhere — the rule does not guess.
    expect(isDeviceInternalKey("LaundryCare.Dryer.Status.ConnectedDry.Version")).toBe(false);
    expect(isDeviceInternalKey("BSH.Common.Status.OperationState")).toBe(false);
    expect(isDeviceInternalKey("BSH.Common.Setting.PowerState")).toBe(false);
  });
});
