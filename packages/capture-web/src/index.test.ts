import { describe, expect, it, vi } from "vitest";

import TraceLog from "./index.js";

interface Recorded {
  readonly requests: { url: string; body: unknown; keepalive: boolean }[];
  hidden(): Promise<void>;
  /** The browser shows the page, or restores it from its cache. */
  pageshow(persisted: boolean): void;
  /** A prerendered page is shown. */
  activated(): void;
}

interface Page {
  href?: string;
  opener?: { postMessage(message: unknown): void } | null;
  /** The tab's `sessionStorage`, shared by the pages of one tab. */
  tab?: Map<string, string>;
  /** The page is inside a frame: its `top` is another window. */
  framed?: boolean;
  prerendering?: boolean;
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
    top: undefined as unknown,
    document: {
      referrer: "",
      visibilityState: "visible",
      prerendering: page.prerendering ?? false,
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
  value.top = page.framed === true ? {} : value;
  (globalThis as { window?: unknown }).window = value;
  return {
    requests,
    pageshow(persisted) {
      listeners.get("pageshow")?.({ persisted });
    },
    activated() {
      value.document.prerendering = false;
      documentListeners.get("prerenderingchange")?.(undefined);
    },
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

    const events = recorded.requests.flatMap(
      (request) =>
        (
          request.body as {
            events: { kind: string; mode?: string; identifier?: string }[];
          }
        ).events,
    );
    expect(recorded.requests[0]?.url).toBe("https://api.tracelog.io/v1/events");
    // Every send outlives the page that started it ([spec/capture.md] § Delivery).
    expect(recorded.requests.map((request) => request.keepalive)).toEqual([
      true,
      true,
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      "session_start",
      "conversion",
    ]);
    expect(events.map((event) => event.mode)).toEqual([
      "verification",
      "verification",
    ]);
    expect(
      events.find((event) => event.kind === "conversion")?.identifier,
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

/**
 * A call made before `init` — a child component's effect, which React runs
 * before its parent's — is made once `init` has run, in order, up to 100.
 */
describe("capture-web calls before init", () => {
  it("makes them after init, in the order they were made", async () => {
    const { TraceLog: runtime, recorded } = await load({});
    runtime.step("checkout_started");
    runtime.consent.grant();
    runtime.conversion("purchase", { identifier: "wc-1042" });
    expect(runtime.consent.state()).toBe("unknown");

    runtime.init({ key, endpoint });
    await recorded.hidden();

    expect(runtime.consent.state()).toBe("granted");
    const events = recorded.requests.flatMap(
      (request) => (request.body as { events: { kind: string }[] }).events,
    );
    expect(events.map((event) => event.kind)).toEqual([
      "session_start",
      "step",
      "conversion",
    ]);
  });

  it("holds a step's third argument and makes the step with it", async () => {
    const { TraceLog: runtime, recorded } = await load({});
    const items = [{ id: "sku-1", name: "Linen shirt", quantity: 1 }];
    runtime.step("cart_viewed", undefined, { items });
    runtime.consent.grant();

    runtime.init({ key, endpoint });
    await recorded.hidden();

    const events = recorded.requests.flatMap(
      (request) => (request.body as { events: { kind: string }[] }).events,
    );
    expect(events.find((event) => event.kind === "step")).toMatchObject({
      items,
    });
  });

  it("drops the hundred and first", async () => {
    const { TraceLog: runtime } = await load({});
    for (let index = 0; index < 100; index += 1) runtime.step("cart_viewed");
    runtime.consent.grant();

    runtime.init({ key, endpoint });
    expect(runtime.consent.state()).toBe("unknown");
  });
});

type Sent = { kind: string; opening?: string; sessionId: string };

function sentEvents(recorded: Recorded): Sent[] {
  return recorded.requests.flatMap(
    (request) => (request.body as { events: Sent[] }).events,
  );
}

/**
 * The first page a consenting visitor loads opens the session, at once
 * ([spec/capture.md] § The session).
 */
describe("capture-web opens the session on the page", () => {
  it("sends the page's start at the grant", async () => {
    const { TraceLog: runtime, recorded } = await load({});
    runtime.init({ key, endpoint });
    runtime.consent.grant();

    expect(sentEvents(recorded)).toEqual([
      expect.objectContaining({ kind: "session_start", opening: "page" }),
    ]);
  });

  it("sends the start before a step held for init", async () => {
    const { TraceLog: runtime, recorded } = await load({});
    runtime.step("checkout_started");
    runtime.consent.grant();
    runtime.init({ key, endpoint });

    const events = sentEvents(recorded);
    expect(events.map((event) => [event.kind, event.opening])).toEqual([
      ["session_start", "page"],
      ["step", undefined],
    ]);
    expect(events[1]?.sessionId).toBe(events[0]?.sessionId);
  });

  it("opens nothing inside a frame", async () => {
    const { TraceLog: runtime, recorded } = await load({ framed: true });
    runtime.init({ key, endpoint });
    runtime.consent.grant();
    await recorded.hidden();

    expect(recorded.requests).toEqual([]);
  });

  it("opens a prerendered page only once it is shown", async () => {
    const { TraceLog: runtime, recorded } = await load({ prerendering: true });
    runtime.init({ key, endpoint });
    runtime.consent.grant();
    await recorded.hidden();
    expect(recorded.requests).toEqual([]);

    recorded.activated();
    expect(sentEvents(recorded)).toEqual([
      expect.objectContaining({ kind: "session_start", opening: "page" }),
    ]);
  });

  it("tells the engine of a page restored from the cache, and of no other show", async () => {
    const restored = vi.fn();
    vi.doMock("@tracelog/capture-core", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("@tracelog/capture-core")>();
      return {
        ...actual,
        createCaptureEngine(
          ...args: Parameters<typeof actual.createCaptureEngine>
        ) {
          const engine = actual.createCaptureEngine(...args);
          return { ...engine, pageRestored: restored };
        },
      };
    });
    try {
      const { TraceLog: runtime, recorded } = await load({});
      runtime.init({ key, endpoint });

      recorded.pageshow(false);
      expect(restored).not.toHaveBeenCalled();
      recorded.pageshow(true);
      expect(restored).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("@tracelog/capture-core");
    }
  });
});
