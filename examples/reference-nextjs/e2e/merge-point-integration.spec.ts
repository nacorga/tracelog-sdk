import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { createApi } from "@tracelog/api";
import {
  createPool,
  PostgresIngestionStore,
  PostgresProjectMetadataPort,
} from "@tracelog/db";

import { integrationDatabaseUrl } from "./merge-point-database.js";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const captureDirectory = path.resolve(
  packageDirectory,
  "../../packages/capture-web",
);
const [captureSource, referenceSource] = await Promise.all([
  readFile(path.join(captureDirectory, "dist/tracelog.esm.js"), "utf8"),
  readFile(path.join(packageDirectory, "dist/reference-app.js"), "utf8"),
]);

const clock = { now: () => new Date("2026-01-08T00:00:10.000Z") };
const projectId = "merge-point-project";
const publicKey = `tl_pk_${"a".repeat(26)}`;

interface BrowserRuntime {
  init(options: { key: string; endpoint?: string }): void;
  consent: { grant(): void };
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

const database = createPool(integrationDatabaseUrl());
const api = createApi({
  clock,
  metadata: new PostgresProjectMetadataPort(database, clock),
  store: new PostgresIngestionStore(database),
  country: { countryCode: () => "ES" },
});

let apiUrl = "";

test.beforeAll(async () => {
  apiUrl = await api.listen({ host: "127.0.0.1", port: 0 });
  await database.query("BEGIN");
  try {
    await database.query("SET CONSTRAINTS ALL DEFERRED");
    await database.query(
      `INSERT INTO organizations (id, name, timezone)
       VALUES ('merge-point-organization', 'Merge point', 'UTC')`,
    );
    await database.query(
      `INSERT INTO projects
         (id, organization_id, name, timezone, created_at, initial_plan_id, initial_plan_version)
       VALUES ($1, 'merge-point-organization', 'Reference app', 'UTC', $2, 'merge-point-plan', 1)`,
      [projectId, clock.now()],
    );
    await database.query(
      `INSERT INTO plans (id, project_id, version, created_at)
       VALUES ('merge-point-plan', $1, 1, $2)`,
      [projectId, clock.now()],
    );
    await database.query(
      `INSERT INTO plan_conversions
         (id, plan_id, project_id, plan_version, type, event_name,
          identifier_label, expects_value, currency, is_primary)
       VALUES
         ('merge-point-conversion', 'merge-point-plan', $1, 1, 'purchase',
          'purchase_completed', 'order number', true, 'EUR', true)`,
      [projectId],
    );
    await database.query(
      `INSERT INTO plan_steps
         (plan_conversion_id, project_id, plan_version, position, event_name)
       VALUES ('merge-point-conversion', $1, 1, 0, 'checkout_started')`,
      [projectId],
    );
    await database.query(
      `INSERT INTO credentials
         (id, project_id, kind, value, hash, origin_allowlist, created_at)
       VALUES
         ('merge-point-browser-key', $1, 'browser', $2, NULL, ARRAY[$3], $4)`,
      [projectId, publicKey, apiUrl, clock.now()],
    );
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  }
});

test.afterAll(async () => {
  await api.close();
  await database.end();
});

test("the reference app batch is accepted and stored by PostgreSQL ingestion", async ({
  page,
}) => {
  await page.route(`${apiUrl}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/events") {
      await route.continue();
      return;
    }
    if (url.pathname === "/tracelog.esm.js") {
      await route.fulfill({
        status: 200,
        contentType: "text/javascript",
        body: captureSource,
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
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>TraceLog merge-point integration</title>",
    });
  });

  await page.clock.install({ time: new Date("2026-01-08T00:00:00.000Z") });
  await page.goto(
    `${apiUrl}/checkout?utm_source=search&utm_medium=organic&utm_campaign=merge_point`,
  );

  const receipt = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/v1/events" &&
      response.request().method() === "POST",
  );
  await page.evaluate(
    async ({ key }) => {
      const loadModule = (specifier: string) =>
        new Function("specifier", "return import(specifier)")(
          specifier,
        ) as Promise<Record<string, unknown>>;
      const reference = (await loadModule(
        "/reference-app.js",
      )) as unknown as ReferenceModule;
      const runtime = (await loadModule("/tracelog.esm.js"))
        .default as BrowserRuntime;

      reference.initializeReferenceApp(
        { key, endpoint: "/v1/events" },
        runtime,
      );
      runtime.consent.grant();
      reference.runDeclaredCheckoutPath("order_123", runtime);
    },
    { key: publicKey },
  );
  await page.clock.fastForward(5_000);

  const response = await receipt;
  expect(response.status()).toBe(202);
  expect(await response.json()).toEqual({ accepted: 3, rejected: [] });

  await expect
    .poll(async () => {
      const result = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM raw_events WHERE project_id=$1",
        [projectId],
      );
      return result.rows[0]?.count;
    })
    .toBe("3");

  const stored = await database.query<{
    project_id: string;
    kind: string;
    name: string;
  }>(
    `SELECT project_id, kind, name
     FROM raw_events
     WHERE project_id=$1
     ORDER BY CASE kind
       WHEN 'session_start' THEN 1 WHEN 'step' THEN 2 WHEN 'conversion' THEN 3
       ELSE 4 END`,
    [projectId],
  );
  expect(stored.rows).toEqual([
    {
      project_id: projectId,
      kind: "session_start",
      name: "session_started",
    },
    {
      project_id: projectId,
      kind: "step",
      name: "checkout_started",
    },
    {
      project_id: projectId,
      kind: "conversion",
      name: "purchase_completed",
    },
  ]);

  const receipts = await database.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM raw_event_receipts WHERE project_id=$1",
    [projectId],
  );
  expect(receipts.rows[0]?.count).toBe("3");

  const conversion = await database.query<{
    name: string;
    identifier: string;
  }>("SELECT name, identifier FROM conversions WHERE project_id=$1", [
    projectId,
  ]);
  expect(conversion.rows).toEqual([
    { name: "purchase_completed", identifier: "order_123" },
  ]);
});
