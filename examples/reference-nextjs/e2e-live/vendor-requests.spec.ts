import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page, type Request } from "@playwright/test";
import {
  eventBatchSchema,
  TAG_SIGHTINGS_CONTEXT_KEY,
  tagSightingReportSchema,
  type Event,
  type EventBatch,
  type TagSightingReport,
} from "@tracelog/event-contract";

/**
 * The live reading ([spec/capture.md] § Tag sightings): the vendors' own
 * `gtag.js` and `fbevents.js`, from their own network, on a page carrying the
 * runtime, with made-up ids. Only `reference.test` is routed — the page and
 * the runtime's `/v1/events` — so every vendor request is the one the script
 * chose to make, by the road it chose. It asserts the property a watch rests
 * on — a tag request the page made is in the conversion's report, or the
 * report says it saw one it could not read — and that Meta's roads are still
 * the ones measured (plans/2026-09-21-the-tag-sighting.md § What was measured,
 * 2026-09-22). A change in the second is Meta moving, not a fault of the
 * runtime: the reading in the plan is taken again.
 */
const iifePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/capture-web/dist/tracelog.iife.js",
);
const iife = await readFile(iifePath, "utf8");
const validKey = `tl_pk_${"a".repeat(26)}`;
const ga4Id = "G-TL0READING1";
const adsId = "AW-1234567890";
const adsLabel = "AbC-D_efG";
const pixelId = "1234567890123456";
/**
 * The window a report covers: from thirty seconds before the conversion to ten
 * after it ([spec/capture.md] § Tag sightings, _The window_).
 */
const WINDOW_BEFORE_MS = 30_000;
const WINDOW_AFTER_MS = 10_000;
/** The measured landing address: a click id and three UTM parameters. */
const landing = `http://reference.test/checkout?fbclid=IwAR2${"x".repeat(180)}&utm_source=facebook&utm_medium=paid&utm_campaign=retargeting_autumn`;

interface Item {
  readonly id: string;
  readonly quantity: number;
  readonly item_price: number;
}

function items(count: number): Item[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `SKU-${1000 + index}-VARIANT-BLUE-XL`,
    quantity: 1,
    item_price: 24.95,
  }));
}

interface Reading {
  readonly value: number;
  readonly items: readonly Item[];
  /** `fbq('init')`'s advanced matching, when the page turns it on. */
  readonly matching?: Readonly<Record<string, string>>;
  readonly purchase: Readonly<Record<string, unknown>>;
}

const readings = {
  short: {
    value: 10,
    items: [],
    purchase: { value: 10, currency: "EUR" },
  },
  items: {
    value: 249.5,
    items: items(12),
    purchase: {
      value: 249.5,
      currency: "EUR",
      content_type: "product",
      contents: items(12),
    },
  },
  matched: {
    value: 74.85,
    items: items(3),
    matching: {
      em: "jane.doe@example.com",
      ph: "34600111222",
      fn: "jane",
      ln: "doe",
      ct: "madrid",
      st: "m",
      zp: "28001",
      country: "es",
      external_id: "cust-8812",
    },
    purchase: {
      value: 74.85,
      currency: "EUR",
      content_type: "product",
      contents: items(3),
      content_ids: items(3).map((item) => item.id),
      num_items: 3,
      order_id: "100234",
    },
  },
} satisfies Record<string, Reading>;

type ReadingName = keyof typeof readings;

/** The runtime's two scripts first in `<head>`, then the vendors' own snippets. */
function checkout(reading: Reading): string {
  const js = JSON.stringify;
  const ga4Items = reading.items.map((item) => ({
    item_id: item.id,
    price: item.item_price,
    quantity: item.quantity,
  }));
  return `<!doctype html><html><head><title>TraceLog reference checkout</title>
<script src="/tracelog.iife.js"></script>
<script>TraceLog.init({ key: ${js(validKey)}, endpoint: "/v1/events" }); TraceLog.consent.grant();</script>
<script async src="https://www.googletagmanager.com/gtag/js?id=${ga4Id}"></script>
<script>window.dataLayer = window.dataLayer || []; function gtag(){dataLayer.push(arguments);} gtag("js", new Date());
gtag("config", ${js(ga4Id)}, { user_data: { email: "jane.doe@example.com", phone_number: "+34600111222" } });
gtag("config", ${js(adsId)}, { allow_enhanced_conversions: true });</script>
<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq("init", ${js(pixelId)}${reading.matching === undefined ? "" : `, ${js(reading.matching)}`}); fbq("track", "PageView");
addEventListener("load", () => setTimeout(() => {
  TraceLog.conversion("purchase_completed", { identifier: "100234", value: ${js(reading.value)}, currency: "EUR" });
  gtag("event", "purchase", { transaction_id: "100234", value: ${js(reading.value)}, currency: "EUR", items: ${js(ga4Items)} });
  gtag("event", "conversion", { send_to: ${js(`${adsId}/${adsLabel}`)}, value: ${js(reading.value)}, currency: "EUR", transaction_id: "100234" });
  fbq("track", "Purchase", ${js(reading.purchase)});
}, 500));</script>
</head><body><p>Thank you for your order.</p></body></html>`;
}

interface VendorRequest {
  readonly method: string;
  readonly type: string;
  readonly url: string;
  readonly body: string | null;
  readonly request: Request;
}

interface Recorded {
  readonly batches: EventBatch[];
  readonly vendors: VendorRequest[];
}

async function serve(page: Page, reading: Reading): Promise<Recorded> {
  const recorded: Recorded = { batches: [], vendors: [] };
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "reference.test") return;
    recorded.vendors.push({
      method: request.method(),
      type: request.resourceType(),
      url: request.url(),
      body: request.postData(),
      request,
    });
  });
  await page.route("http://reference.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/v1/events") {
      const parsed = eventBatchSchema.parse(request.postDataJSON());
      recorded.batches.push(parsed);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: parsed.events.length, rejected: [] }),
      });
      return;
    }
    if (url.pathname === "/tracelog.iife.js") {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: iife,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: checkout(reading),
    });
  });
  return recorded;
}

function conversionIn(batches: EventBatch[]): Event | undefined {
  return batches
    .flatMap((batch) => batch.events)
    .find((event) => event.kind === "conversion");
}

/** A field of a request's address, or of its body, urlencoded or multipart. */
function field(request: VendorRequest, name: string): string | null {
  const inAddress = new URL(request.url).searchParams.get(name);
  if (inAddress !== null || request.body === null) return inAddress;
  const encoded = new URLSearchParams(request.body).get(name);
  if (encoded !== null) return encoded;
  const part = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`).exec(
    request.body,
  );
  return part?.[1] ?? null;
}

function isMeta(request: VendorRequest): boolean {
  const url = new URL(request.url);
  return (
    (url.hostname === "facebook.com" ||
      url.hostname.endsWith(".facebook.com")) &&
    (url.pathname === "/tr" || url.pathname === "/tr/")
  );
}

const adsConversionPath =
  /^\/pagead\/(?:conversion|viewthroughconversion|1p-conversion)\/([0-9]+)\/$/;

/** Each vendor request, as a line a failure can name. */
function described(request: VendorRequest): string {
  const url = new URL(request.url);
  const names = ["tid", "id", "ev", "label"]
    .map((name) => [name, field(request, name)] as const)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name}=${value}`)
    .join(" ");
  return `${request.method} ${request.type} ${url.host}${url.pathname} ${names}`.trim();
}

/**
 * Every tag request the page made inside the conversion's window is in its
 * report: a GA4 request's `tid` and a Google Ads conversion request's
 * `AW-<n>/<label>` as sightings, and each Meta request as a sighting with the
 * pixel and event it names, or through the report's `unread` naming Meta.
 */
function unreported(
  requests: readonly VendorRequest[],
  report: TagSightingReport,
): string[] {
  const sighted = (kind: string, id: string, event: string | null) =>
    report.sightings.some(
      (sighting) =>
        sighting.kind === kind &&
        sighting.id === id &&
        sighting.event === event,
    );
  const missing: string[] = [];
  for (const request of requests) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/g/collect")) {
      const tid = field(request, "tid");
      if (tid === null || !sighted("ga4", tid, null)) {
        missing.push(described(request));
      }
      continue;
    }
    const ads = adsConversionPath.exec(url.pathname);
    if (ads !== null) {
      const label = url.searchParams.get("label");
      const id = label === null ? `AW-${ads[1]}` : `AW-${ads[1]}/${label}`;
      if (!sighted("google_ads", id, null)) missing.push(described(request));
      continue;
    }
    if (isMeta(request)) {
      const id = field(request, "id");
      const event = field(request, "ev");
      const read = id !== null && sighted("meta", id, event);
      if (!read && !(report.unread ?? []).includes("meta")) {
        missing.push(described(request));
      }
    }
  }
  return missing;
}

type Road = "GET image" | "POST ping" | "POST beacon" | "POST document";

/** The road each Meta event took, as measured on 2026-09-22, per project. */
function measuredRoads(
  reading: ReadingName,
  project: string,
): Record<"PageView" | "Purchase", Road[]> {
  const long: Road =
    project === "chrome"
      ? "POST document"
      : project === "chromium"
        ? "POST ping"
        : "POST beacon";
  switch (reading) {
    case "short":
      return { PageView: ["GET image"], Purchase: ["GET image"] };
    case "items":
      return { PageView: ["GET image"], Purchase: [long] };
    case "matched":
      return { PageView: [long], Purchase: [long] };
  }
}

function metaRoads(
  requests: readonly VendorRequest[],
): Record<"PageView" | "Purchase", string[]> {
  const roads = { PageView: new Set<string>(), Purchase: new Set<string>() };
  for (const request of requests) {
    if (!isMeta(request)) continue;
    const event = field(request, "ev");
    if (event === "PageView" || event === "Purchase") {
      roads[event].add(`${request.method} ${request.type}`);
    }
  }
  return {
    PageView: [...roads.PageView].sort(),
    Purchase: [...roads.Purchase].sort(),
  };
}

for (const name of Object.keys(readings) as ReadingName[]) {
  test(`${name}: every tag request the page made is in the conversion's report`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const recorded = await serve(page, readings[name]);
    await page.goto(landing);

    await expect
      .poll(() => conversionIn(recorded.batches), { timeout: 30_000 })
      .toBeDefined();
    const conversion = conversionIn(recorded.batches)!;
    const report = tagSightingReportSchema.parse(
      conversion.context?.[TAG_SIGHTINGS_CONTEXT_KEY],
    );
    // Both on the browser's clock: the conversion's instant, and each
    // request's start as the browser timed it. A request the browser gave no
    // timing — no answer yet, or none at all, which Chromium reports as a
    // start of 0 — counts as inside, so none is left out unasked.
    const at = Date.parse(conversion.occurredAt);
    const inWindow = recorded.vendors.filter(({ request }) => {
      const started = request.timing().startTime;
      return (
        started <= 0 ||
        (started >= at - WINDOW_BEFORE_MS && started <= at + WINDOW_AFTER_MS)
      );
    });
    const seen = inWindow.map(described);

    expect(
      report.complete && report.unread !== undefined,
      `a complete report carrying unread: ${JSON.stringify(report)}`,
    ).toBe(true);
    expect(
      unreported(inWindow, report),
      `requests in no report, of ${JSON.stringify(seen, null, 1)} and ${JSON.stringify(report)}`,
    ).toEqual([]);
    expect(
      metaRoads(inWindow),
      `Meta has moved: the reading in the plan is taken again. Seen: ${JSON.stringify(seen, null, 1)}`,
    ).toEqual(measuredRoads(name, testInfo.project.name));
  });
}
