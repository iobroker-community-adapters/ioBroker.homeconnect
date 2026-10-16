// Fleet master — the release run copies this file byte for byte into every adapter's src-admin/; change it in
// Entwicklung/.consistency-master, never in an adapter.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
