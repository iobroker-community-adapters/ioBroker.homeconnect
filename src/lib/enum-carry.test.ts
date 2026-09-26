import { enumsHolding, moveWithEnums, type EnumCarryAdapter } from "./enum-carry";

/**
 * A fake object store that records every call in order, so a test can prove the delete comes before the carry.
 *
 * @param enums the enum objects by id
 * @param opts failure switches
 * @param opts.listFails reject the enum listing
 * @param opts.writeFails reject every enum write
 */
function fakeStore(
  enums: Record<string, { common: { members: string[]; name?: string } }>,
  opts: { listFails?: boolean; writeFails?: boolean } = {},
): { adapter: EnumCarryAdapter; order: string[]; store: typeof enums; warn: ReturnType<typeof vi.fn> } {
  const order: string[] = [];
  const warn = vi.fn();
  const adapter: EnumCarryAdapter = {
    getForeignObjectsAsync: (pattern: string): Promise<Record<string, unknown>> => {
      order.push(`list ${pattern}`);
      return opts.listFails ? Promise.reject(new Error("db down")) : Promise.resolve(structuredClone(enums));
    },
    getForeignObjectAsync: (id: string): Promise<unknown> => {
      order.push(`read ${id}`);
      return Promise.resolve(structuredClone(enums[id] ?? null));
    },
    setForeignObject: (id: string, obj: Record<string, unknown>): Promise<unknown> => {
      order.push(`write ${id}`);
      if (opts.writeFails) {
        return Promise.reject(new Error("write refused"));
      }
      enums[id] = obj as (typeof enums)[string];
      return Promise.resolve({});
    },
    log: { warn },
  };
  return { adapter, order, store: enums, warn };
}

const errText = (e: unknown): string => `[via helper] ${e instanceof Error ? e.message : String(e)}`;

describe("enumsHolding", () => {
  it("lists the enums whose members contain the id, sorted", () => {
    const enums = {
      "enum.rooms.living": { common: { members: ["a.0.old", "a.0.x"] } },
      "enum.functions.light": { common: { members: ["a.0.old"] } },
      "enum.rooms.kitchen": { common: { members: ["a.0.x"] } },
      "enum.broken": { common: {} },
    };
    expect(enumsHolding(enums, "a.0.old")).toEqual(["enum.functions.light", "enum.rooms.living"]);
    expect(enumsHolding(undefined, "a.0.old")).toEqual([]);
  });
});

describe("moveWithEnums", () => {
  it("reads first, deletes second, writes the new id last — into exactly the enums that held the old id", async () => {
    const { adapter, order, store } = fakeStore({
      "enum.rooms.living": { common: { members: ["a.0.old", "a.0.x"], name: "Living" } },
      "enum.rooms.kitchen": { common: { members: ["a.0.x"] } },
    });
    const remove = vi.fn(() => {
      order.push("delete a.0.old");
      // The controller's removeIdFromAllEnums: the old id leaves every enum.
      store["enum.rooms.living"].common.members = store["enum.rooms.living"].common.members.filter(
        m => m !== "a.0.old",
      );
      return Promise.resolve();
    });
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", remove, errText)).resolves.toEqual(["enum.rooms.living"]);
    expect(order).toEqual(["list enum.*", "delete a.0.old", "read enum.rooms.living", "write enum.rooms.living"]);
    expect(store["enum.rooms.living"]).toEqual({ common: { members: ["a.0.x", "a.0.new"], name: "Living" } });
    expect(store["enum.rooms.kitchen"].common.members).toEqual(["a.0.x"]);
  });

  it("does not add the new id twice", async () => {
    const { adapter, store } = fakeStore({ "enum.rooms.living": { common: { members: ["a.0.old", "a.0.new"] } } });
    await moveWithEnums(adapter, "a.0.old", "a.0.new", () => Promise.resolve(), errText);
    expect(store["enum.rooms.living"].common.members).toEqual(["a.0.new"]);
  });

  it("still deletes and warns through the caller's helper when the enums cannot be read", async () => {
    const { adapter, warn } = fakeStore({}, { listFails: true });
    const remove = vi.fn(() => Promise.resolve());
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", remove, errText)).resolves.toEqual([]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe(
      "Room and function assignments of a.0.old could not be read: [via helper] db down",
    );
  });

  it("warns per enum when a write fails and reports only what was carried", async () => {
    const { adapter, warn } = fakeStore(
      { "enum.rooms.living": { common: { members: ["a.0.old"] } } },
      { writeFails: true },
    );
    await expect(moveWithEnums(adapter, "a.0.old", "a.0.new", () => Promise.resolve(), errText)).resolves.toEqual([]);
    expect(warn.mock.calls[0][0]).toBe(
      "Assignment enum.rooms.living could not be carried to a.0.new: [via helper] write refused",
    );
  });

  it("lets a failed delete surface to the caller", async () => {
    const { adapter } = fakeStore({ "enum.rooms.living": { common: { members: ["a.0.old"] } } });
    await expect(
      moveWithEnums(adapter, "a.0.old", "a.0.new", () => Promise.reject(new Error("gone")), errText),
    ).rejects.toThrow("gone");
  });
});
