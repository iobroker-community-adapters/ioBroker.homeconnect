import { describe, it, expect } from "vitest";
import { planLegacyCleanup, type CleanupObject } from "./legacy-cleanup";

const state = (): CleanupObject => ({ type: "state", native: {} });

describe("planLegacyCleanup", () => {
  it("flags an old-generation haId tree (upper-case root) for removal", () => {
    const objects = {
      "SIEMENS-HCS02DWH1-0123456789AB": { type: "folder", native: {} },
      "SIEMENS-HCS02DWH1-0123456789AB.status.BSH_Common_Status_DoorState": state(),
      "SIEMENS-HCS02DWH1-0123456789AB.settings.BSH_Common_Setting_PowerState": state(),
      "BOSCH-WTX87K90-0011223344556677.status.BSH_Common_Status_OperationState": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual(["BOSCH-WTX87K90-0011223344556677", "SIEMENS-HCS02DWH1-0123456789AB"]);
  });

  it("never touches auth, info, or our own speaking device trees", () => {
    const objects = {
      "auth.session": state(),
      "auth.verificationUrl": state(),
      "info.connection": state(),
      geschirrspueler: { type: "device", native: { haId: "SIEMENS-HCS02DWH1-0123456789AB" } },
      "geschirrspueler.status.doorState": state(),
      "geschirrspueler.info.reachable": state(),
      "geschirrspueler.programs.selectedProgram": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual([]);
  });

  it("catches a legacy tree via its underscored raw-key leaves even with a lower-case root", () => {
    const objects = {
      "somedevice.status.BSH_Common_Status_DoorState": state(),
      "somedevice.events.Dishcare_Dishwasher_Event_SaltNearlyEmpty": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual(["somedevice"]);
  });

  it("does not flag our trees just because a root object is missing", () => {
    // A speaking tree whose device object was not returned (edge): camelCase
    // leaves carry no underscore fingerprint → left alone.
    const objects = {
      "waschtrockner.status.operationState": state(),
      "waschtrockner.options.spinSpeed": state(),
      "waschtrockner.programs.start": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual([]);
  });

  it("removes an old haId root even when its leaves carry no raw-key fingerprint", () => {
    // A legacy tree the previous adapter only got as far as creating the root for,
    // or whose leaves were already pruned. The upper-case root IS the fingerprint —
    // the speaking tree's roots are strictly lower-case slugs.
    const objects = {
      "SIEMENS-HCS02DWH1-0123456789AB": { type: "folder", native: {} } as CleanupObject,
      "SIEMENS-HCS02DWH1-0123456789AB.status": { type: "channel", native: {} } as CleanupObject,
    };
    expect(planLegacyCleanup(objects)).toEqual(["SIEMENS-HCS02DWH1-0123456789AB"]);
  });

  it("only protects a root that is a DEVICE object carrying the haId", () => {
    // The old generation also stored the haId in native, but on a folder. Treating
    // "has a haId" as "is ours" would make the migration a no-op for those users.
    const objects = {
      "SIEMENS-HCS02DWH1-0123456789AB": {
        type: "folder",
        native: { haId: "SIEMENS-HCS02DWH1-0123456789AB" },
      } as CleanupObject,
      "SIEMENS-HCS02DWH1-0123456789AB.status.BSH_Common_Status_DoorState": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual(["SIEMENS-HCS02DWH1-0123456789AB"]);
  });

  it("judges each root by its OWN leaves, not by a legacy tree elsewhere", () => {
    // Without the per-root filter, one old tree anywhere condemns every other root
    // in the instance — the update would wipe the new tree it just built.
    const objects = {
      "somedevice.status.BSH_Common_Status_DoorState": state(),
      "waschtrockner.status.operationState": state(),
      "waschtrockner.programs.start": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual(["somedevice"]);
  });

  it("ignores an object id that has no root segment", () => {
    // js-controller has handed out ids starting with a dot after a bad delete.
    // Splitting one yields an empty root — planning a recursive delete for "" is
    // a delete of the whole instance.
    expect(planLegacyCleanup({ "": state(), ".status.BSH_Common_Status_DoorState": state() })).toEqual([]);
  });

  it("handles the mixed picture of an update: old tree goes, new tree and auth stay", () => {
    const objects = {
      "auth.session": state(),
      "info.connection": state(),
      "SIEMENS-HCS02DWH1-0123456789AB.programs.selected.options.BSH_Common_Option_StartInRelative": state(),
      geschirrspueler: { type: "device", native: { haId: "SIEMENS-HCS02DWH1-0123456789AB" } },
      "geschirrspueler.status.doorState": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual(["SIEMENS-HCS02DWH1-0123456789AB"]);
  });
});

describe("planLegacyCleanup — a numeric haId root", () => {
  it("recognises a 1.6.x tree whose root is an all-digit haId by its raw-key leaves", () => {
    // Siemens appliances measured live carry an 18-digit haId: lower-case by nature,
    // so only the underscored leaves can give the tree away.
    const objects = {
      "015090396331005775": { type: "device", native: {} } as CleanupObject,
      "015090396331005775.general.connected": state(),
      "015090396331005775.commands.BSH_Common_Command_StopProgram": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual(["015090396331005775"]);
  });

  it("does not flag a tree of the current rule — lower-case, a device object with the haId, camelCase leaves", () => {
    const objects = {
      "sx87tx02ce-5775": { type: "device", native: { haId: "015090396331005775", idScheme: 3 } } as CleanupObject,
      "sx87tx02ce-5775.status.operationState": state(),
      "sx87tx02ce-5775.commands.stopProgram": state(),
    };
    expect(planLegacyCleanup(objects)).toEqual([]);
  });
});
