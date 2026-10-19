// Fleet master — the release run copies this file byte for byte into every adapter's src-admin/; change it in
// Entwicklung/.consistency-master, never in an adapter.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // vitest 5's default, written out so vitest 4 behaves the same: every mock's calls are cleared before each test — a
    // test that passes only by reading a call an earlier test made is red on every version (round 128).
    clearMocks: true,
  },
});
