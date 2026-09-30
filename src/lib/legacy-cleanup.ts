// Decide which objects are left-overs of the previous adapter generation
// (TA2k/Lucky-ESA ≤ 1.6.x) so the adapter can sort them out itself on update
// (delete, or hold for adoption when rooms/aliases point into them) — the user
// must not clean up by hand. Pure — the caller deletes or holds them — so the "what is legacy" logic is unit-testable without a
// live adapter (pattern: fakeroku's object-cleanup).
//
// The old generation built its trees directly under the appliance's haId
// ("SIEMENS-HCS02DWH1-0123456789AB.status.BSH_Common_Status_DoorState"): the
// root segment carries upper-case letters, the leaves carry the raw BSH key
// with dots replaced by underscores. Our generation uses strictly lower-case
// slug device roots (device objects carrying native.haId) and
// camelCase leaf ids — the two cannot collide. `auth` and `info` are shared
// between both generations (the sign-in is taken over) and are never touched.

/** The minimal object shape the plan needs (id → type + native). */
export interface CleanupObject {
  /** The ioBroker object type ("device", "state", …). */
  type?: string;
  /** The object's native data (our devices carry `haId` here). */
  native?: unknown;
}

/** Leaf names of the old generation: a raw BSH key with dots turned into underscores. */
export const LEGACY_LEAF = /^[A-Z][A-Za-z0-9]*(_[A-Za-z0-9]+)+$/;

/**
 * Find the previous adapter generation's object trees.
 *
 * A root (first path segment) is legacy when it is not one of ours (`auth`,
 * `info`, or a device object carrying `native.haId`) AND shows an old-generation
 * fingerprint: upper-case letters in the root itself (an haId), or at least one
 * descendant whose leaf name is an underscored raw BSH key.
 *
 * @param objects the instance's objects, keyed by namespace-RELATIVE id
 * @returns the relative legacy root ids (sorted, de-duplicated)
 */
export function planLegacyCleanup(objects: Readonly<Record<string, CleanupObject>>): string[] {
  const ourDeviceRoots = new Set<string>();
  const rootsInUse = new Set<string>();
  for (const [id, obj] of Object.entries(objects)) {
    const root = id.split(".")[0];
    if (!root) {
      continue;
    }
    rootsInUse.add(root);
    if (
      id === root &&
      obj.type === "device" &&
      typeof (obj.native as { haId?: unknown } | undefined)?.haId === "string"
    ) {
      ourDeviceRoots.add(root);
    }
  }

  const legacy = new Set<string>();
  for (const root of rootsInUse) {
    // `auth` / `info` are the adapter's own fixed roots. Their leaves are
    // camelCase, so neither fingerprint below can match them — the names are
    // listed anyway so the intent does not depend on that coincidence.
    if (root === "auth" || root === "info" || ourDeviceRoots.has(root)) {
      continue;
    }
    if (/[A-Z]/.test(root)) {
      legacy.add(root); // an haId root — our slug ids are strictly lower-case
      continue;
    }
    const hasLegacyLeaf = Object.keys(objects).some(id => {
      if (!id.startsWith(`${root}.`)) {
        return false;
      }
      const leaf = id.split(".").at(-1) ?? "";
      return LEGACY_LEAF.test(leaf);
    });
    if (hasLegacyLeaf) {
      legacy.add(root);
    }
  }
  return [...legacy].sort();
}
