// Fleet master — the release run copies this file into every adapter's src-admin/ and keeps only the adapter's own
// Module-Federation name (the jsonConfig of the adapter refers to it); change it in Entwicklung/.consistency-master.
import react from "@vitejs/plugin-react";
import { federation } from "@module-federation/vite";
import { moduleFederationShared } from "@iobroker/gui-components/modulefederation.admin.config";
import { readFileSync } from "node:fs";

// The admin provides each of these modules itself (eager, one copy for every component), so the component takes them
// from the admin and bundles no fallback of its own: a fallback the admin never loads, megabytes per package, that
// vite reports as a chunk over its size limit. `import: false` needs a federation plugin whose export scan accepts a
// trailing comma in an export list (the gui-components entry has them; CLAUDE_ADMIN_UI.md names the pin).
const shared = Object.fromEntries(
  Object.entries(moduleFederationShared(JSON.parse(readFileSync("./package.json").toString()))).map(([pkg, cfg]) => [
    pkg,
    { ...cfg, import: false as const },
  ]),
);

const config = {
  plugins: [
    federation({
      // The component imports the adapter's own rules from ../src/lib; the plugin's type step would compile them
      // under rootDir src-admin/src and fail (TS6059). The admin loads the remote at runtime — nothing consumes
      // its types.
      dts: false,
      manifest: true,
      name: "HomeConnectComponentSet",
      filename: "customComponents.js",
      exposes: {
        "./Components": "./src/Components.tsx",
      },
      remotes: {},
      shared,
    }),
    react(),
  ],
  // Vite 8 resolves tsconfig paths natively — replaces the vite-tsconfig-paths plugin.
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 3000,
  },
  base: "./",
  build: {
    target: "chrome89",
    outDir: "./build",
  },
};

export default config;
