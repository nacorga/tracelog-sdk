import { defineConfig } from "@playwright/test";

import { sdkBrowserTargets } from "../../tools/sdk-browser-targets.mjs";

export default defineConfig({
  metadata: {
    browserFloor: sdkBrowserTargets,
  },
  testDir: "./e2e",
  /**
   * The merge-point integration spec has a config of its own — it needs a
   * PostgreSQL and the global setup that creates its schema — and matching it
   * here ran it three times without either. `pnpm test:integration` is where
   * it belongs.
   */
  testIgnore: "merge-point-integration.spec.ts",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
