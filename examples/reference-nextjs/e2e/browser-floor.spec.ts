import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { eventBatchSchema, type EventBatch } from "@tracelog/event-contract";
import { validEventBatchFixtures } from "@tracelog/testkit";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const captureDirectory = path.resolve(
  packageDirectory,
  "../../packages/capture-web",
);
const [esmSource, referenceSource] = await Promise.all([
  readFile(path.join(captureDirectory, "dist/tracelog.esm.js"), "utf8"),
  readFile(path.join(packageDirectory, "dist/reference-app.js"), "utf8"),
]);
const iifePath = path.join(captureDirectory, "dist/tracelog.iife.js");
const validKey = `tl_pk_${"a".repeat(26)}`;

type BuildFormat = "esm" | "iife";

interface BrowserRuntime {
  init(options: { key: string; endpoint?: string }): void;
  consent: {
    grant(): void;
    deny(): void;
    state(): "unknown" | "granted" | "denied";
  };
  step(name: string, context?: object): void;
  conversion(
    name: string,
    options: {
      identifier: string;
      value?: number;
      currency?: string;
      context?: object;
    },
  ): void;
}

interface ReferenceModule {
  initializeReferenceApp(
    options: { key: string; endpoint?: string },
    runtime: BrowserRuntime,
  ): void;
  runDeclaredCheckoutPath(identifier: string, runtime: BrowserRuntime): void;
}

async function routeReference(
  page: Page,
  batches: EventBatch[],
): Promise<void> {
  await page.route("http://reference.test/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/tracelog.esm.js") {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: esmSource,
      });
      return;
    }
    if (url.pathname === "/reference-app.js") {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: referenceSource,
      });
      return;
    }
    if (url.pathname === "/v1/events") {
      expect(request.headers().authorization).toBe(`Bearer ${validKey}`);
      const parsed = eventBatchSchema.parse(request.postDataJSON());
      batches.push(parsed);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: parsed.events.length, rejected: [] }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>TraceLog reference checkout</title>",
    });
  });
}

async function installBuild(page: Page, format: BuildFormat): Promise<void> {
  if (format === "iife") await page.addScriptTag({ path: iifePath });
}

async function driveReference(
  page: Page,
  format: BuildFormat,
  grant: boolean,
): Promise<void> {
  await page.evaluate(
    async ({ selectedFormat, key, shouldGrant }) => {
      const loadModule = (specifier: string) =>
        new Function("specifier", "return import(specifier)")(
          specifier,
        ) as Promise<Record<string, unknown>>;
      const reference = (await loadModule(
        "/reference-app.js",
      )) as unknown as ReferenceModule;
      const runtime =
        selectedFormat === "esm"
          ? ((await loadModule("/tracelog.esm.js")).default as BrowserRuntime)
          : ((globalThis as typeof globalThis & { TraceLog: BrowserRuntime })
              .TraceLog as BrowserRuntime);

      reference.initializeReferenceApp(
        { key, endpoint: "/v1/events" },
        runtime,
      );
      if (shouldGrant) runtime.consent.grant();
      reference.runDeclaredCheckoutPath("order_123", runtime);
    },
    { selectedFormat: format, key: validKey, shouldGrant: grant },
  );
}

for (const format of ["esm", "iife"] as const) {
  test.describe(`${format} build`, () => {
    test("writes no storage and sends no request before grant", async ({
      page,
    }) => {
      const batches: EventBatch[] = [];
      await routeReference(page, batches);
      await page.clock.install({ time: new Date("2026-01-08T00:00:00.000Z") });
      await page.goto("http://reference.test/checkout");
      await installBuild(page, format);
      await driveReference(page, format, false);
      await page.clock.fastForward(60_000);

      expect(batches).toEqual([]);
      expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    });

    test("drives the declared path as contract-compatible wire events", async ({
      page,
    }) => {
      const batches: EventBatch[] = [];
      await routeReference(page, batches);
      await page.clock.install({ time: new Date("2026-01-08T00:00:00.000Z") });
      await page.goto(
        "http://reference.test/checkout?utm_source=search&utm_medium=organic&utm_campaign=winter_launch",
      );
      await installBuild(page, format);
      await driveReference(page, format, true);
      // Every engine of the floor observes the page's requests, so the
      // conversion is held for its tag sighting window — capture-core's
      // `TAG_SIGHTING_AFTER_MS` — before it is sent ([spec/capture.md] § Tag
      // sightings).
      await page.clock.fastForward(10_000);
      await expect.poll(() => batches.length).toBe(1);

      const events = batches.flatMap((batch) => batch.events);
      expect(events.map((event) => event.kind)).toEqual([
        "session_start",
        "step",
        "conversion",
      ]);
      expect(events[0]).toMatchObject({
        kind: "session_start",
        name: validEventBatchFixtures.session_start.events[0].name,
        utm: {
          source: "search",
          medium: "organic",
          campaign: "winter_launch",
        },
        device: "desktop",
      });
      expect(events[1]).toMatchObject({
        kind: "step",
        name: validEventBatchFixtures.step.events[0].name,
        context: validEventBatchFixtures.step.events[0].context,
      });
      expect(events[2]).toMatchObject({
        kind: "conversion",
        name: validEventBatchFixtures.conversion.events[0].name,
        identifier: validEventBatchFixtures.conversion.events[0].identifier,
        value: validEventBatchFixtures.conversion.events[0].value,
        currency: validEventBatchFixtures.conversion.events[0].currency,
        context: validEventBatchFixtures.conversion.events[0].context,
      });
      expect(
        await page.evaluate(() => Object.keys(localStorage).sort()),
      ).toEqual(["__tl.a", "__tl.c", "__tl.q", "__tl.s"]);
    });
  });
}

test("verification handshake reports only diagnostic state", async ({
  page,
}) => {
  const batches: EventBatch[] = [];
  await routeReference(page, batches);
  await page.goto("http://reference.test/checkout?__tl_verify=nonce_123");
  await page.evaluate(() => {
    const host = window as typeof window & { diagnostic?: unknown };
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: {
        postMessage(message: unknown) {
          host.diagnostic = message;
        },
      },
    });
  });
  await page.addScriptTag({ path: iifePath });
  await page.evaluate((key) => {
    const runtime = (
      globalThis as typeof globalThis & {
        TraceLog: BrowserRuntime;
      }
    ).TraceLog;
    runtime.init({ key });
  }, validKey);

  const diagnostic = await page.evaluate(
    () => (window as typeof window & { diagnostic?: unknown }).diagnostic,
  );
  expect(diagnostic).toEqual({
    type: "tracelog:diag",
    nonce: "nonce_123",
    present: true,
    consent: "unknown",
    configValid: true,
    drops: [],
  });
  expect(JSON.stringify(diagnostic)).not.toContain("eventId");
  expect(JSON.stringify(diagnostic)).not.toContain("identifier");
  expect(batches).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
