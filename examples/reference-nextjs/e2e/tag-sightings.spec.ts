import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import {
  eventBatchSchema,
  TAG_SIGHTINGS_CONTEXT_KEY,
  tagSightingReportSchema,
  type Event,
  type EventBatch,
} from "@tracelog/event-contract";

/**
 * The tag sighting in a real engine ([spec/capture.md] § Tag sightings): the
 * runtime reads what the browser recorded of the page's requests, and nothing
 * else. Every request is fulfilled here, vendors' included, so none reaches a
 * vendor's network — a request fulfilled by `page.route` still leaves a
 * Resource Timing entry in all three engines (plans/2026-09-21-the-tag-sighting.md
 * § What was measured). Time is the page's own: a fake clock would move
 * `performance.now()` away from the entries it dates.
 */
const iifePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/capture-web/dist/tracelog.iife.js",
);
const validKey = `tl_pk_${"a".repeat(26)}`;
const metaPurchase =
  "https://www.facebook.com/tr/?id=1234567890123456&ev=Purchase&dl=http%3A%2F%2Freference.test%2Fcheckout&v=2.9.403";
const ga4Purchase =
  "https://region1.google-analytics.com/g/collect?v=2&tid=G-TL0MEASURE1&cid=1495803112.1789989379&en=purchase&dl=http%3A%2F%2Freference.test%2Fcheckout";
const pixel = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

interface Recorded {
  readonly batches: EventBatch[];
  readonly vendors: string[];
  /** Every request the page made that the route did not answer: none may be. */
  unrouted(): string[];
}

async function serve(page: Page): Promise<Recorded> {
  const requested = new Set<string>();
  const routed = new Set<string>();
  const recorded: Recorded = {
    batches: [],
    vendors: [],
    unrouted: () => [...requested].filter((url) => !routed.has(url)),
  };
  page.on("request", (request) => requested.add(request.url()));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    routed.add(request.url());
    if (url.hostname === "reference.test" && url.pathname === "/v1/events") {
      const parsed = eventBatchSchema.parse(request.postDataJSON());
      recorded.batches.push(parsed);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: parsed.events.length, rejected: [] }),
      });
      return;
    }
    if (url.hostname === "reference.test") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>TraceLog reference checkout</title>",
      });
      return;
    }
    recorded.vendors.push(request.url());
    await route.fulfill({ status: 200, contentType: "image/gif", body: pixel });
  });
  return recorded;
}

function conversionIn(batches: EventBatch[]): Event | undefined {
  return batches
    .flatMap((batch) => batch.events)
    .find((event) => event.kind === "conversion");
}

/** The page converts, requests Meta's pixel at once and GA4 `ga4After` later. */
async function convert(
  page: Page,
  options: { ga4After?: number; hideAfter?: number },
): Promise<void> {
  await page.goto("http://reference.test/checkout");
  await page.addScriptTag({ path: iifePath });
  await page.evaluate(
    ({ key, meta, ga4, ga4After, hideAfter }) => {
      const runtime = (
        globalThis as typeof globalThis & {
          TraceLog: {
            init(options: { key: string; endpoint: string }): void;
            consent: { grant(): void };
            conversion(
              name: string,
              options: { identifier: string; value: number; currency: string },
            ): void;
          };
        }
      ).TraceLog;
      runtime.init({ key, endpoint: "/v1/events" });
      runtime.consent.grant();
      runtime.conversion("purchase_completed", {
        identifier: "order_123",
        value: 129.5,
        currency: "EUR",
      });
      new Image().src = meta;
      if (ga4After !== undefined) {
        setTimeout(() => {
          void fetch(ga4, { method: "POST", mode: "no-cors", keepalive: true });
        }, ga4After);
      }
      if (hideAfter !== undefined) {
        setTimeout(() => {
          Object.defineProperty(document, "visibilityState", {
            configurable: true,
            get: () => "hidden",
          });
          document.dispatchEvent(new Event("visibilitychange"));
        }, hideAfter);
      }
    },
    {
      key: validKey,
      meta: metaPurchase,
      ga4: ga4Purchase,
      ga4After: options.ga4After,
      hideAfter: options.hideAfter,
    },
  );
}

test("a conversion carries the tags the page requested around it, in a complete report", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const recorded = await serve(page);
  await convert(page, { ga4After: 5_000 });

  await expect.poll(() => recorded.vendors.length, { timeout: 8_000 }).toBe(2);
  expect(conversionIn(recorded.batches)).toBeUndefined();

  await expect
    .poll(() => conversionIn(recorded.batches), { timeout: 15_000 })
    .toBeDefined();
  const report = tagSightingReportSchema.parse(
    conversionIn(recorded.batches)?.context?.[TAG_SIGHTINGS_CONTEXT_KEY],
  );
  expect(report).toEqual({
    complete: true,
    sightings: [
      { kind: "meta", id: "1234567890123456", event: "Purchase" },
      { kind: "ga4", id: "G-TL0MEASURE1", event: null },
    ],
  });
  expect(recorded.vendors).toEqual([metaPurchase, ga4Purchase]);
  expect(recorded.unrouted()).toEqual([]);
});

test("a page hidden inside the window sends the conversion at once, with what it saw, cut short", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const recorded = await serve(page);
  await convert(page, { hideAfter: 3_000 });

  // Well inside the ten seconds: what sends it is the hide, not the window.
  await expect
    .poll(() => conversionIn(recorded.batches), { timeout: 8_000 })
    .toBeDefined();
  const report = tagSightingReportSchema.parse(
    conversionIn(recorded.batches)?.context?.[TAG_SIGHTINGS_CONTEXT_KEY],
  );
  expect(report).toEqual({
    complete: false,
    sightings: [{ kind: "meta", id: "1234567890123456", event: "Purchase" }],
  });
  expect(recorded.unrouted()).toEqual([]);
});
