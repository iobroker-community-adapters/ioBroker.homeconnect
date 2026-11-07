// Fleet master — the release run copies this file byte for byte into every adapter; change it in
// Entwicklung/.consistency-master, never in an adapter.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // The admin component (src-admin/) runs its own suite with its own config (`npm run test:admin`).
    include: ["src/**/*.test.ts", "test/standards/*.test.ts", "tools/**/*.test.ts"],
    watch: false,
    // one process per test file: src/lib/diagnostics/placeholders.test.ts bounds the CPU time of its own process
    // (`process.cpuUsage`) — under threads the siblings of the file would count in (round 157)
    pool: "forks",
    coverage: {
      // vitest 5 measures exactly what include names — a source outside it silently drops out of the report.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/*.d.ts"],
    },
  },
});
