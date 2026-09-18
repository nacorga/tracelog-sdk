import { defineConfig } from "@playwright/test";

import { sdkBrowserTargets } from "../../tools/sdk-browser-targets.mjs";

export default defineConfig({
  metadata: {
    browserFloor: sdkBrowserTargets,
  },
  testDir: "./e2e",
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
