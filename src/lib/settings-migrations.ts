import type { NativeKeyMigration } from "./native-key-migration";

/**
 * Instance keys an earlier manifest declared and this adapter no longer reads. js-controller never
 * deletes one on an update, so they would stay in every existing installation for good — among
 * them the account name and password the previous adapter generation (1.6.x) stored, and
 * `common.nogit` (1.17.0), which blocks the install from GitHub — the only way to this adapter
 * while the ioBroker repository entry under its name is the community package. The fleet helper
 * nulls them once, in one write.
 */
export const SETTINGS_MIGRATIONS: NativeKeyMigration[] = [
  { drop: "authUri" },
  { drop: "disableFetchConnect" },
  { drop: "language" },
  { drop: "mySelect" },
  { drop: "ownRequest" },
  { drop: "password" },
  { drop: "resetAccess" },
  { drop: "scope" },
  { drop: "test1" },
  { drop: "test2" },
  { drop: "username" },
  { commonDrop: "license" },
  { commonDrop: "main" },
  { commonDrop: "materialize" },
  { commonDrop: "nogit" },
  { commonDrop: "plugins" },
  { commonDrop: "restartAdapters" },
  { commonDrop: "supportCustoms" },
];
