import { readFile } from "node:fs/promises";
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
 * else but the two fields of Meta's form. Every request is fulfilled here,
 * vendors' included, so none reaches a vendor's network — a request fulfilled
 * by `page.route` still leaves a Resource Timing entry in all three engines
 * (plans/2026-09-21-the-tag-sighting.md § What was measured), but for a form
 * posted into a frame, which leaves none in Chromium and Firefox and an
 * `iframe` entry in WebKit (plans/2026-09-21-the-tag-sighting.md § What was
 * measured, 2026-09-22). Time is the page's own: a fake clock would move
 * `performance.now()` away from the entries it dates.
 */
const iifePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/capture-web/dist/tracelog.iife.js",
);
const iife = await readFile(iifePath, "utf8");
const validKey = `tl_pk_${"a".repeat(26)}`;
/**
 * The runtime loads as a head script does — how the WooCommerce plugin loads
 * it, and where the snippet goes — so observation starts before the body
 * exists and every window is watched whole.
 */
const checkout = `<!doctype html><html><head><title>TraceLog reference checkout</title><script src="/tracelog.iife.js"></script><script>TraceLog.init({ key: "${validKey}", endpoint: "/v1/events" }); TraceLog.consent.grant();</script></head><body></body></html>`;
const pixelId = "1234567890123456";
const metaEndpoint = "https://www.facebook.com/tr/";
const metaPurchase = `${metaEndpoint}?id=${pixelId}&ev=Purchase&dl=http%3A%2F%2Freference.test%2Fcheckout&v=2.9.403`;
const ga4Purchase =
  "https://region1.google-analytics.com/g/collect?v=2&tid=G-TL0MEASURE1&cid=1495803112.1789989379&en=purchase&dl=http%3A%2F%2Freference.test%2Fcheckout";
/** A visitor's hashed email, as advanced matching puts it in Meta's form. */
const hashedEmail =
  "8a1f3b2c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";
const pixel = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
  "base64",
);

const metaSighting = { kind: "meta", id: pixelId, event: "Purchase" };
const ga4Sighting = { kind: "ga4", id: "G-TL0MEASURE1", event: null };

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
    if (
      url.hostname === "reference.test" &&
      url.pathname === "/tracelog.iife.js"
    ) {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: iife,
      });
      return;
    }
    if (url.hostname === "reference.test") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: checkout,
      });
      return;
    }
    recorded.vendors.push(request.url());
    // A form posted into a frame is a document request, answered as the
    // routed reading answered it: WebKit records the frame's `iframe` entry
    // only when its document has a body.
    if (request.resourceType() === "document") {
      await route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "ok",
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: "image/gif", body: pixel });
  });
  return recorded;
}

function conversionIn(batches: EventBatch[]): Event | undefined {
  return batches
    .flatMap((batch) => batch.events)
    .find((event) => event.kind === "conversion");
}

/**
 * The page converts and sends Meta's `Purchase` at once by `meta`'s road — an
 * image, a beacon, or a form posted into a hidden frame — and GA4 `ga4After`
 * later.
 */
async function convert(
  page: Page,
  options: {
    meta: "image" | "beacon" | "form";
    ga4After?: number;
    hideAfter?: number;
  },
): Promise<void> {
  await page.goto("http://reference.test/checkout");
  await page.evaluate(
    ({ meta, road, endpoint, id, hashed, ga4, ga4After, hideAfter }) => {
      const runtime = (
        globalThis as typeof globalThis & {
          TraceLog: {
            conversion(
              name: string,
              options: { identifier: string; value: number; currency: string },
            ): void;
          };
        }
      ).TraceLog;
      runtime.conversion("purchase_completed", {
        identifier: "order_123",
        value: 129.5,
        currency: "EUR",
      });
      if (road === "image") {
        new Image().src = meta;
      } else if (road === "beacon") {
        navigator.sendBeacon(
          endpoint,
          new URLSearchParams({ id, ev: "Purchase" }),
        );
      } else {
        const frame = document.createElement("iframe");
        frame.name = "tracelog-reading";
        frame.style.display = "none";
        document.body.appendChild(frame);
        const form = document.createElement("form");
        form.action = endpoint;
        form.method = "post";
        form.target = frame.name;
        for (const [name, value] of [
          ["id", id],
          ["ev", "Purchase"],
          ["ud[em]", hashed],
        ] as const) {
          const input = document.createElement("input");
          input.type = "hidden";
          input.name = name;
          input.value = value;
          form.appendChild(input);
        }
        document.body.appendChild(form);
        form.submit();
      }
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
      meta: metaPurchase,
      road: options.meta,
      endpoint: metaEndpoint,
      id: pixelId,
      hashed: hashedEmail,
      ga4: ga4Purchase,
      ga4After: options.ga4After,
      hideAfter: options.hideAfter,
    },
  );
}

function reportIn(batches: EventBatch[]) {
  return tagSightingReportSchema.parse(
    conversionIn(batches)?.context?.[TAG_SIGHTINGS_CONTEXT_KEY],
  );
}

test("a conversion carries the tags the page requested around it, in a complete report", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const recorded = await serve(page);
  await convert(page, { meta: "image", ga4After: 5_000 });

  await expect.poll(() => recorded.vendors.length, { timeout: 8_000 }).toBe(2);
  expect(conversionIn(recorded.batches)).toBeUndefined();

  await expect
    .poll(() => conversionIn(recorded.batches), { timeout: 15_000 })
    .toBeDefined();
  expect(reportIn(recorded.batches)).toEqual({
    complete: true,
    sightings: [metaSighting, ga4Sighting],
    unread: [],
  });
  expect(recorded.vendors).toEqual([metaPurchase, ga4Purchase]);
  expect(recorded.unrouted()).toEqual([]);
});

test("a page hidden inside the window sends the conversion at once, with what it saw, cut short", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const recorded = await serve(page);
  await convert(page, { meta: "image", hideAfter: 3_000 });

  // Well inside the ten seconds: what sends it is the hide, not the window.
  await expect
    .poll(() => conversionIn(recorded.batches), { timeout: 8_000 })
    .toBeDefined();
  expect(reportIn(recorded.batches)).toEqual({
    complete: false,
    sightings: [metaSighting],
    unread: [],
  });
  expect(recorded.unrouted()).toEqual([]);
});

test("Meta's beacon, whose entry names no pixel, is reported as Meta, unread", async ({
  page,
}) => {
  test.setTimeout(45_000);
  const recorded = await serve(page);
  await convert(page, { meta: "beacon", ga4After: 5_000 });

  await expect
    .poll(() => conversionIn(recorded.batches), { timeout: 20_000 })
    .toBeDefined();
  expect(reportIn(recorded.batches)).toEqual({
    complete: true,
    sightings: [ga4Sighting],
    unread: ["meta"],
  });
  expect(recorded.vendors).toEqual([metaEndpoint, ga4Purchase]);
  expect(recorded.unrouted()).toEqual([]);
});

test("Meta's form is read from the two fields that name the pixel and the event, and no other", async ({
  page,
  browserName,
}) => {
  test.setTimeout(45_000);
  const recorded = await serve(page);
  await convert(page, { meta: "form" });

  await expect
    .poll(() => conversionIn(recorded.batches), { timeout: 20_000 })
    .toBeDefined();
  expect(reportIn(recorded.batches)).toEqual({
    complete: true,
    sightings: [metaSighting],
    // WebKit's routed form leaves an `iframe` entry on Meta's bare endpoint,
    // which is an unread request; Safari takes the beacon instead, so no real
    // page reaches it.
    unread: browserName === "webkit" ? ["meta"] : [],
  });
  const delivered = JSON.stringify(recorded.batches);
  expect(delivered).not.toContain(hashedEmail);
  expect(delivered).not.toContain("ud[em]");
  expect(recorded.vendors).toEqual([metaEndpoint]);
  expect(recorded.unrouted()).toEqual([]);
});
