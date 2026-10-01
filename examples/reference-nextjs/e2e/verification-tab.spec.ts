import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { eventBatchSchema, type Event } from "@tracelog/event-contract";

/**
 * The verification mark follows its tab ([spec/capture.md] § Verification
 * mode): opened from a verification session, granted there, it marks the
 * site's next page and the page a payment taken elsewhere returns to — through
 * a gateway that sends `Cross-Origin-Opener-Policy: same-origin`, as PayPal's
 * does, which severs the opener and moves the tab to a new browsing context
 * group on the way out and again on the way back.
 */
const iife = await readFile(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../packages/capture-web/dist/tracelog.iife.js",
  ),
  "utf8",
);
const validKey = `tl_pk_${"a".repeat(26)}`;

function shopPage(body: string): string {
  return `<!doctype html><title>Shop</title><script src="/tracelog.js"></script>
<script>
TraceLog.init({ key: "${validKey}", endpoint: "/v1/events" });
TraceLog.consent.grant();
${body}
</script>`;
}

test("the mark follows the tab to its next page and back from a payment taken elsewhere", async ({
  context,
  page,
}) => {
  const events: Event[] = [];
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "app.test") {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>TraceLog</title>",
      });
    } else if (url.hostname === "pay.test") {
      await route.fulfill({
        contentType: "text/html",
        headers: { "Cross-Origin-Opener-Policy": "same-origin" },
        body: `<!doctype html><title>Pay</title><script>location.replace("https://shop.test/order/received");</script>`,
      });
    } else if (url.pathname === "/tracelog.js") {
      await route.fulfill({ contentType: "text/javascript", body: iife });
    } else if (url.pathname === "/v1/events") {
      events.push(...eventBatchSchema.parse(request.postDataJSON()).events);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: 1, rejected: [] }),
      });
    } else if (url.pathname === "/order/received") {
      await route.fulfill({
        contentType: "text/html",
        body: shopPage(
          'TraceLog.conversion("purchase", { identifier: "order_1" });',
        ),
      });
    } else {
      await route.fulfill({
        contentType: "text/html",
        body: shopPage(
          `TraceLog.step(${JSON.stringify(url.pathname.slice(1))});`,
        ),
      });
    }
  });

  await page.goto("https://app.test/installation");
  const [tab] = await Promise.all([
    context.waitForEvent("page"),
    page.evaluate(() =>
      window.open("https://shop.test/product?__tl_verify=nonce_1", "_blank"),
    ),
  ]);
  await tab.waitForLoadState();
  await tab.goto("https://shop.test/cart");
  await tab.goto("https://pay.test/redirect");
  await tab.waitForURL("https://shop.test/order/received");
  await tab.waitForLoadState();

  // The gateway severed the opener: only the tab's own storage carried the mark.
  expect(await tab.evaluate(() => window.opener === null)).toBe(true);

  await expect
    .poll(() => events.filter((event) => event.kind !== "session_start"))
    .toHaveLength(3);
  expect(
    events
      .filter((event) => event.kind !== "session_start")
      .map((event) => [event.name, event.mode]),
  ).toEqual([
    ["product", "verification"],
    ["cart", "verification"],
    ["purchase", "verification"],
  ]);
});
