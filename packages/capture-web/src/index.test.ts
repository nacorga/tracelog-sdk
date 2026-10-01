import { describe, expect, it, vi } from "vitest";

import TraceLog from "./index.js";

interface Recorded {
  readonly requests: { url: string; body: unknown; keepalive: boolean }[];
  hidden(): Promise<void>;
}

interface Page {
  href?: string;
  opener?: { postMessage(message: unknown): void } | null;
  /** The tab's `sessionStorage`, shared by the pages of one tab. */
  tab?: Map<string, string>;
}

function storageOf(values: Map<string, string>) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, item: string) => values.set(key, item),
    removeItem: (key: string) => values.delete(key),
  };
}

/** The narrow browser surface the runtime touches, and nothing more. */
function browser(page: Page = {}): Recorded {
  const listeners = new Map<string, (event: unknown) => void>();
  const documentListeners = new Map<string, (event: unknown) => void>();
  const storage = new Map<string, string>();
  const requests: { url: string; body: unknown; keepalive: boolean }[] = [];
  const value = {
    location: { href: page.href ?? "https://shop.example/checkout" },
    opener: page.opener ?? null,
    navigator: { userAgent: "Mozilla/5.0 (Macintosh)" },
    localStorage: storageOf(storage),
    sessionStorage: storageOf(page.tab ?? new Map<string, string>()),
    document: {
      referrer: "",
      visibilityState: "visible",
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        documentListeners.set(name, handler),
    },
    addEventListener: (name: string, handler: (event: unknown) => void) =>
      listeners.set(name, handler),
    async fetch(url: string, options: { body: string; keepalive: boolean }) {
      requests.push({
        url,
        body: JSON.parse(options.body) as unknown,
        keepalive: options.keepalive,
      });
      return {
        status: 202,
        json: async () => ({ accepted: 1, rejected: [] }),
      };
    },
  };
  (globalThis as { window?: unknown }).window = value;
  return {
    requests,
    async hidden() {
      value.document.visibilityState = "hidden";
      documentListeners.get("visibilitychange")?.(undefined);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("capture-web public API", () => {
  it("exposes exactly the documented operations", () => {
    expect(Object.keys(TraceLog)).toEqual([
      "init",
      "consent",
      "step",
      "conversion",
    ]);
    expect(Object.keys(TraceLog.consent)).toEqual(["grant", "deny", "state"]);
    expect(TraceLog.consent.state()).toBe("unknown");
  });

  it("marks a platform artifact's declared verification mode on every event", async () => {
    const recorded = browser();

    TraceLog.init({
      key: `tl_pk_${"a".repeat(26)}`,
      endpoint: "https://api.tracelog.io/v1/events",
      mode: "verification",
    });
    TraceLog.consent.grant();
    TraceLog.conversion("purchase", {
      identifier: "wc-1042",
      value: 129.5,
      currency: "EUR",
    });
    await recorded.hidden();

    const batch = recorded.requests[0]?.body as {
      events: { kind: string; mode?: string; identifier?: string }[];
    };
    expect(recorded.requests[0]?.url).toBe("https://api.tracelog.io/v1/events");
    // Every send outlives the page that started it ([spec/capture.md] § Delivery).
    expect(recorded.requests.map((request) => request.keepalive)).toEqual([
      true,
    ]);
    expect(batch.events.map((event) => event.mode)).toEqual([
      "verification",
      "verification",
    ]);
    expect(
      batch.events.find((event) => event.kind === "conversion")?.identifier,
    ).toBe("wc-1042");
  });
});

/** A page load: the module's state is the page's, so each load imports anew. */
async function load(page: Page): Promise<{
  TraceLog: typeof TraceLog;
  recorded: Recorded;
}> {
  const recorded = browser(page);
  vi.resetModules();
  return { TraceLog: (await import("./index.js")).default, recorded };
}

const key = `tl_pk_${"a".repeat(26)}`;
const endpoint = "https://api.tracelog.io/v1/events";

async function purchaseModes(
  page: Page,
): Promise<{ modes: (string | undefined)[]; diagnostics: unknown[] }> {
  const diagnostics: unknown[] = [];
  const { TraceLog: runtime, recorded } = await load({
    ...page,
    ...(page.opener === undefined
      ? {}
      : {
          opener:
            page.opener === null
              ? null
              : {
                  postMessage: (message: unknown) => diagnostics.push(message),
                },
        }),
  });
  runtime.init({ key, endpoint });
  runtime.consent.grant();
  runtime.conversion("purchase", { identifier: "wc-1042" });
  await recorded.hidden();
  const events = recorded.requests.flatMap(
    (request) => (request.body as { events: { mode?: string }[] }).events,
  );
  return { modes: events.map((event) => event.mode), diagnostics };
}

/**
 * The verification mark follows its tab once consent is granted there: to the
 * site's next pages, and back from a payment taken elsewhere
 * ([spec/capture.md] § Verification mode).
 */
describe("capture-web verification mode", () => {
  const opener = { postMessage: () => undefined };

  it("keeps the mark for the tab from the grant, and marks the tab's next page", async () => {
    const tab = new Map<string, string>();
    const { TraceLog: first } = await load({
      href: "https://shop.example/product?__tl_verify=nonce_1",
      opener,
      tab,
    });
    first.init({ key, endpoint });
    expect([...tab.keys()]).toEqual([]);
    first.consent.grant();
    expect([...tab.entries()]).toEqual([["__tl.v", "nonce_1"]]);

    // Back from the payment page, which severed the opener.
    const next = await purchaseModes({
      href: "https://shop.example/order/received",
      opener: null,
      tab,
    });
    expect(next.modes).toEqual(["verification", "verification"]);
    expect(next.diagnostics).toEqual([]);
  });

  it("marks nothing and keeps nothing for a marker without an opener", async () => {
    const tab = new Map<string, string>();
    const { modes } = await purchaseModes({
      href: "https://shop.example/checkout?__tl_verify=nonce_1",
      opener: null,
      tab,
    });
    expect(modes).toEqual([undefined, undefined]);
    expect([...tab.keys()]).toEqual([]);
  });

  it("forgets the mark on a denial", async () => {
    const tab = new Map([["__tl.v", "nonce_1"]]);
    const { TraceLog: runtime } = await load({
      href: "https://shop.example/checkout",
      tab,
    });
    runtime.init({ key, endpoint });
    runtime.consent.deny();
    expect([...tab.keys()]).toEqual([]);
  });

  it("still tells the opener when the kept mark's page has one", async () => {
    const tab = new Map([["__tl.v", "nonce_1"]]);
    const { diagnostics } = await purchaseModes({
      href: "https://shop.example/order/received",
      opener,
      tab,
    });
    expect(diagnostics).toContainEqual(
      expect.objectContaining({ type: "tracelog:diag", nonce: "nonce_1" }),
    );
  });
});
