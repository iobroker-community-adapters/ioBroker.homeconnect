// Fleet master — the release run copies this file byte for byte into every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
import config from "@iobroker/eslint-config";

export default [
  ...config,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Only files no tsconfig covers stand here — typescript-eslint refuses a file that is in both. The root
          // tsconfig covers src/ and test/**/*.ts, test/tsconfig.json the test hooks (*.cjs, *.mjs).
          allowDefaultProject: ["*.mjs", "*.mts", "scripts/*.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // No finding is switched off in the code: an inline `eslint-disable` (or any other inline config) has no effect and
    // lint names it, and `@ts-expect-error` is banned like `@ts-ignore` — a finding is fixed, or its exception goes
    // through the workshop with krobi's go (round 109).
    linterOptions: {
      noInlineConfig: true,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false },
      ],
    },
  },
  {
    ignores: [
      // Session files of the note-taking hook: its cooldown marker tmp/last-ndc.ts is a timestamp, not TypeScript.
      ".remember/**",
      ".dev-server/",
      ".vscode/",
      "*.test.js",
      // The ioBroker template files and the mocha inventory harness under test/ run outside the TypeScript project.
      "test/*.js",
      "*.config.mjs",
      "tasks.js",
      "build",
      // Generated coverage report (npm run coverage) — never lint it.
      "coverage",
      "admin",
      // The admin component is its own project with its own eslint.config.mjs.
      "src-admin",
      "node_modules",
      "**/adapter-config.d.ts",
    ],
  },
];
