/*
 * Tripwires, moved here from docs/build/state.md § Gaps. Each was recorded by
 * the build step named and is about this file. They bind nothing — they are what
 * the next person to work here should know before they change it.
 *
 * Step 20 → whoever revisits `examples/reference-nextjs`: `test:e2e` used to
 * match `merge-point-integration.spec.ts` as well, which needs the schema its
 * own `test:integration` config prepares in `globalSetup`; run under
 * `test:e2e` with a `DATABASE_URL` it failed with "relation organizations does
 * not exist". Closed: `testIgnore` below keeps it out, and CI's `sdk-e2e` job
 * runs `test:e2e` on every push; `test:integration` still needs a database
 * and runs by hand.
 */

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
