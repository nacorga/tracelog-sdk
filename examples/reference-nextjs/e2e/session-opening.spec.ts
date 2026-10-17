import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { eventBatchSchema, type Event } from "@tracelog/event-contract";

/**
 * A session is one record per visit, opened on the first page the visitor
 * loads once consent is granted, and every consented page keeps it open
 * ([spec/capture.md] § The session). The visit arrives from another origin,
 * so the referrer is the browser's own, and every page of the site grants as
 * a banner does on each load while consent stands.
 */
const captureDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/capture-web",
);
const [esmSource, iifeSource] = await Promise.all([
  readFile(path.join(captureDirectory, "dist/tracelog.esm.js"), "utf8"),
  readFile(path.join(captureDirectory, "dist/tracelog.iife.js"), "utf8"),
]);
const validKey = `tl_pk_${"a".repeat(26)}`;
const landing = "http://shop.test/landing?utm_source=newsletter";
const MINUTE = 60 * 1000;

type BuildFormat = "esm" | "iife";

function shopPage(format: BuildFormat): string {
  const start = `TraceLog.init({ key: "${validKey}", endpoint: "/v1/events" });
TraceLog.consent.grant();
window.TraceLog = TraceLog;`;
  return format === "esm"
    ? `<!doctype html><title>Shop</title><script type="module">import TraceLog from "/tracelog.esm.js";
${start}
</script>`
    : `<!doctype html><title>Shop</title><script src="/tracelog.iife.js"></script>
<script>
${start}
</script>`;
}

async function routeVisit(
  context: BrowserContext,
  format: BuildFormat,
  events: Event[],
): Promise<void> {
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname === "news.test") {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>News</title><a id="visit" href="${landing}">Read on</a>`,
      });
    } else if (url.hostname === "framer.test") {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Framer</title><iframe src="${landing}"></iframe>`,
      });
    } else if (url.pathname === "/tracelog.esm.js") {
      await route.fulfill({ contentType: "text/javascript", body: esmSource });
    } else if (url.pathname === "/tracelog.iife.js") {
      await route.fulfill({ contentType: "text/javascript", body: iifeSource });
    } else if (url.pathname === "/v1/events") {
      const batch = eventBatchSchema.parse(request.postDataJSON());
      events.push(...batch.events);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: batch.events.length, rejected: [] }),
      });
    } else {
      await route.fulfill({ contentType: "text/html", body: shopPage(format) });
    }
  });
}

/** The visit's first page, reached from a link on another origin. */
async function arrive(page: Page): Promise<void> {
  await page.goto("http://news.test/article");
  await Promise.all([page.waitForURL(landing), page.click("#visit")]);
}

/** Once the page's queue is empty, everything it recorded has arrived. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const queue = localStorage.getItem("__tl.q");
        return queue === null
          ? 0
          : (JSON.parse(queue) as { events: unknown[] }).events.length;
      }),
    )
    .toBe(0);
}

/** A step this page takes, to know its sends have all been made. */
async function step(page: Page, name: string): Promise<void> {
  await page.waitForFunction(() => "TraceLog" in window);
  await page.evaluate((stepName) => {
    (
      window as unknown as { TraceLog: { step(name: string): void } }
    ).TraceLog.step(stepName);
  }, name);
}

const starts = (events: Event[]) =>
  events.filter((event) => event.kind === "session_start");

for (const format of ["esm", "iife"] as const) {
  test.describe(`${format} build`, () => {
    test("the landing page opens the session with where the visit came from", async ({
      context,
      page,
    }) => {
      const events: Event[] = [];
      await routeVisit(context, format, events);

      await arrive(page);
      await expect.poll(() => starts(events)).toHaveLength(1);
      await settled(page);

      expect(events).toEqual([
        expect.objectContaining({
          kind: "session_start",
          opening: "page",
          landingPage: landing,
          referrer: "http://news.test/",
          utm: { source: "newsletter" },
        }),
      ]);
    });

    test("the site's next page, and a second tab, join the visit", async ({
      context,
      page,
    }) => {
      const events: Event[] = [];
      await routeVisit(context, format, events);
      await arrive(page);
      await expect.poll(() => starts(events)).toHaveLength(1);

      await page.goto("http://shop.test/pricing");
      await step(page, "pricing_viewed");
      const tab = await context.newPage();
      await tab.goto("http://shop.test/cart");
      await step(tab, "cart_viewed");
      await expect
        .poll(() => events.filter((event) => event.kind === "step"))
        .toHaveLength(2);
      await settled(page);
      await settled(tab);

      const [start] = starts(events);
      expect(starts(events)).toHaveLength(1);
      expect(
        events
          .filter((event) => event.kind === "step")
          .map((event) => [event.name, event.sessionId]),
      ).toEqual([
        ["pricing_viewed", start?.sessionId],
        ["cart_viewed", start?.sessionId],
      ]);
    });

    test("a page framed by another sends nothing", async ({
      context,
      page,
    }) => {
      const events: Event[] = [];
      await routeVisit(context, format, events);

      await page.goto("http://framer.test/");
      const frame = page.frameLocator("iframe");
      await expect
        .poll(() =>
          frame.locator("html").evaluate(() =>
            "TraceLog" in window
              ? (
                  window as unknown as {
                    TraceLog: { consent: { state(): string } };
                  }
                ).TraceLog.consent.state()
              : "absent",
          ),
        )
        .toBe("granted");

      // The page's start would have been written at the grant.
      expect(
        await frame
          .locator("html")
          .evaluate(() => Object.keys(localStorage).sort()),
      ).toEqual([]);
      expect(events).toEqual([]);
    });

    test("a page restored from the cache after thirty-one minutes opens a new session", async ({
      context,
      page,
    }) => {
      const events: Event[] = [];
      await routeVisit(context, format, events);
      await page.clock.install({ time: new Date("2026-01-08T00:00:00.000Z") });

      await arrive(page);
      await expect.poll(() => starts(events)).toHaveLength(1);
      await page.clock.fastForward(31 * MINUTE);
      await page.evaluate(() => {
        window.dispatchEvent(
          new PageTransitionEvent("pageshow", { persisted: true }),
        );
      });

      await expect.poll(() => starts(events)).toHaveLength(2);
      const [first, restored] = starts(events);
      expect(restored).toMatchObject({ opening: "page" });
      expect(restored?.sessionId).not.toBe(first?.sessionId);
    });
  });
}
