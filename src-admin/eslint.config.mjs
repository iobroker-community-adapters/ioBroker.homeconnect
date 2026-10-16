// Fleet master — the release run copies this file byte for byte into every adapter's src-admin/; change it in
// Entwicklung/.consistency-master, never in an adapter. No rule is switched off here: the component and its tests
// are linted like the adapter itself.
import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    // Same as the adapter's master: an inline eslint config has no effect, `@ts-expect-error` is banned (round 109).
    linterOptions: {
      noInlineConfig: true,
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false },
      ],
    },
  },
  {
    ignores: [".__mf__temp/", "admin/", "build/", "*.config.mjs"],
  },
];
