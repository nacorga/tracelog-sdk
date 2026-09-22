import { defineConfig } from "@playwright/test";

/**
 * The live reading: the vendors' own scripts, loaded from their own network
 * with made-up ids, read weekly by `.github/workflows/vendor-reading.yml`.
 * It is the one suite that reaches a vendor, which is why it has its own
 * directory and configuration — `test:e2e` never reads `./e2e-live` — and why
 * it retries: it rides the public network. `chrome` is Google Chrome, where
 * Meta's script takes the road no other engine is shown
 * ([spec/capture.md] § Tag sightings, _Meta's long request_).
 */
export default defineConfig({
  testDir: "./e2e-live",
  retries: 2,
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "chrome", use: { browserName: "chromium", channel: "chrome" } },
  ],
});
