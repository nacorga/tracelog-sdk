import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";
import { MAX_CONTEXT_BYTES, type EventBatch } from "@tracelog/event-contract";

/**
 * A visitor who leaves the page is the case every other suite routes around:
 * here the page, the ingestion door and the page the visitor goes to are
 * three real servers on three origins, so the send at exit crosses a real
 * CORS preflight and a real navigation ([spec/capture.md] § Delivery).
 */
const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const iifeSource = await readFile(
  path.resolve(
    packageDirectory,
    "../../packages/capture-web/dist/tracelog.iife.js",
  ),
  "utf8",
);
const validKey = `tl_pk_${"a".repeat(26)}`;

interface Door {
  origin: string;
  received: EventBatch["events"];
  /** Holds the first preflight open, so the first send is still in flight. */
  holdFirstPreflight: boolean;
  preflightHeld: Promise<void>;
  /** Answers the held preflight, the way a slow network finally does. */
  release(): void;
  close(): Promise<void>;
}

function listen(
  host: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ server: Server; origin: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://${host}:${port}` });
    });
  });
}

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function openDoor(): Promise<Door> {
  const held: { response: ServerResponse; origin: string }[] = [];
  let preflights = 0;
  let signalHeld: () => void = () => undefined;
  const door: Door = {
    origin: "",
    received: [],
    holdFirstPreflight: false,
    preflightHeld: new Promise((resolve) => {
      signalHeld = resolve;
    }),
    release: () => undefined,
    close: async () => undefined,
  };
  const { server, origin } = await listen("localhost", (request, response) => {
    const cors = {
      "Access-Control-Allow-Origin": request.headers.origin ?? "*",
      "Access-Control-Allow-Methods": "POST",
      "Access-Control-Allow-Headers": "authorization, content-type",
      "Access-Control-Max-Age": "0",
    };
    if (request.method === "OPTIONS") {
      preflights += 1;
      if (door.holdFirstPreflight && preflights === 1) {
        held.push({ response, origin: cors["Access-Control-Allow-Origin"] });
        signalHeld();
        return;
      }
      response.writeHead(204, cors).end();
      return;
    }
    void body(request).then((text) => {
      const batch = JSON.parse(text) as EventBatch;
      door.received.push(...batch.events);
      response
        .writeHead(202, { ...cors, "Content-Type": "application/json" })
        .end(JSON.stringify({ accepted: batch.events.length, rejected: [] }));
    });
  });
  door.origin = origin;
  door.release = () => {
    for (const { response, origin: allowed } of held.splice(0)) {
      response
        .writeHead(204, {
          "Access-Control-Allow-Origin": allowed,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Max-Age": "0",
        })
        .end();
    }
  };
  door.close = () =>
    new Promise((resolve) => {
      for (const { response } of held) response.destroy();
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return door;
}

let door: Door;
let site: { server: Server; origin: string };
let elsewhere: { server: Server; origin: string };

test.beforeEach(async () => {
  door = await openDoor();
  site = await listen("127.0.0.1", (request, response) => {
    /**
     * WebKit on macOS was measured firing neither `pagehide` nor
     * `visibilitychange` on a navigation to another site; `?silent` stops
     * both before the runtime hears them, so every engine can show it.
     */
    const silent = request.url?.includes("silent") === true;
    if (request.url === "/tracelog.js") {
      response
        .writeHead(200, { "Content-Type": "text/javascript" })
        .end(iifeSource);
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" }).end(
      `<!doctype html><title>Pricing</title>
${silent ? '<script>for (const name of ["visibilitychange", "pagehide"]) window.addEventListener(name, (event) => event.stopImmediatePropagation(), true);</script>' : ""}
<script src="/tracelog.js"></script>
<script>
TraceLog.init({ key: ${JSON.stringify(validKey)}, endpoint: ${JSON.stringify(`${door.origin}/v1/events`)} });
TraceLog.consent.grant();
</script>
<a id="leave" href="${elsewhere.origin}/signup">Sign up</a>`,
    );
  });
  elsewhere = await listen("localhost", (_request, response) => {
    response
      .writeHead(200, { "Content-Type": "text/html" })
      .end("<!doctype html><title>Sign up</title>");
  });
});

test.afterEach(async () => {
  await door.close();
  site.server.closeAllConnections();
  elsewhere.server.closeAllConnections();
  await Promise.all(
    [site, elsewhere].map(
      ({ server }) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
});

async function leave(page: import("@playwright/test").Page): Promise<void> {
  await Promise.all([
    page.waitForURL(`${elsewhere.origin}/signup`),
    page.click("#leave"),
  ]);
}

const names = () => door.received.map((event) => event.name);

test("a step taken just before leaving arrives", async ({ page }) => {
  await page.goto(`${site.origin}/pricing`);
  await page.evaluate(() => {
    (
      window as unknown as { TraceLog: { step(name: string): void } }
    ).TraceLog.step("signup_started");
  });
  await leave(page);

  await expect.poll(names, { timeout: 5_000 }).toContain("signup_started");
});

test("a step whose send is still in flight when the visitor leaves arrives", async ({
  page,
}) => {
  door.holdFirstPreflight = true;
  await page.goto(`${site.origin}/pricing`);
  await page.evaluate(() => {
    (
      window as unknown as { TraceLog: { step(name: string): void } }
    ).TraceLog.step("signup_started");
  });
  // The runtime's first send carries the step; its preflight is held open.
  await door.preflightHeld;
  await leave(page);
  door.release();

  await expect.poll(names, { timeout: 5_000 }).toContain("signup_started");
});

test("a queue larger than a keepalive body still sends at exit", async ({
  page,
}) => {
  await page.goto(`${site.origin}/pricing`);
  await page.evaluate(
    (padding) => {
      const runtime = (
        window as unknown as {
          TraceLog: { step(name: string, context?: object): void };
        }
      ).TraceLog;
      for (let index = 0; index < 12; index += 1) {
        runtime.step("bulk_step", { padding });
      }
    },
    "x".repeat(MAX_CONTEXT_BYTES - 64),
  );
  await leave(page);

  await expect.poll(names, { timeout: 5_000 }).toContain("bulk_step");
});

test("a step taken just before leaving arrives when the page fires no hide event", async ({
  page,
}) => {
  await page.goto(`${site.origin}/pricing?silent`);
  await page.evaluate(() => {
    (
      window as unknown as { TraceLog: { step(name: string): void } }
    ).TraceLog.step("signup_started");
  });
  await leave(page);

  await expect.poll(names, { timeout: 5_000 }).toContain("signup_started");
});
