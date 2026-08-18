import { describe, expect, it } from "vitest";

import TraceLog from "./index.js";

interface Recorded {
  readonly requests: { url: string; body: unknown }[];
  hidden(): Promise<void>;
}

/** The narrow browser surface the runtime touches, and nothing more. */
function browser(): Recorded {
  const listeners = new Map<string, (event: unknown) => void>();
  const documentListeners = new Map<string, (event: unknown) => void>();
  const storage = new Map<string, string>();
  const requests: { url: string; body: unknown }[] = [];
  const value = {
    location: { href: "https://shop.example/checkout" },
    opener: null,
    navigator: { userAgent: "Mozilla/5.0 (Macintosh)" },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, item: string) => storage.set(key, item),
      removeItem: (key: string) => storage.delete(key),
    },
    document: {
      referrer: "",
      visibilityState: "visible",
      addEventListener: (name: string, handler: (event: unknown) => void) =>
        documentListeners.set(name, handler),
    },
    addEventListener: (name: string, handler: (event: unknown) => void) =>
      listeners.set(name, handler),
    async fetch(url: string, options: { body: string }) {
      requests.push({ url, body: JSON.parse(options.body) as unknown });
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
    expect(batch.events.map((event) => event.mode)).toEqual([
      "verification",
      "verification",
    ]);
    expect(
      batch.events.find((event) => event.kind === "conversion")?.identifier,
    ).toBe("wc-1042");
  });
});
