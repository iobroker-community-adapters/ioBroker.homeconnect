import type { NativeKeyMigration } from "./native-key-migration";

/**
 * Instance keys an earlier manifest declared and this adapter no longer reads. js-controller never
 * deletes one on an update, so they would stay in every existing installation for good — among
 * them the account name and password the previous adapter generation (1.6.x) stored. The fleet
 * helper nulls them once, in one write. `common.nogit` is not among them: since 2.0 the adapter is
 * installed from npm, and the flag keeps the admin from offering the GitHub install.
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
  { commonDrop: "plugins" },
  { commonDrop: "restartAdapters" },
  { commonDrop: "supportCustoms" },
];
