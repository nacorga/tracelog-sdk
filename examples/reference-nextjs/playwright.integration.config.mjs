import { defineConfig } from "@playwright/test";

export default defineConfig({
  globalSetup: "./e2e/merge-point-global-setup.ts",
  globalTeardown: "./e2e/merge-point-global-teardown.ts",
  testDir: "./e2e",
  testMatch: "merge-point-integration.spec.ts",
  fullyParallel: false,
  workers: 1,
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
