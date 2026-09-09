import type { Clock } from "@tracelog/config";
import { eventBatchSchema, MAX_BATCH_BYTES } from "@tracelog/event-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCaptureEngine,
  type AcquisitionContext,
  type CaptureStorage,
  type CaptureTransport,
  type DropCount,
  type TransportResponse,
} from "./index.js";
import type { Event } from "@tracelog/event-contract";

class MemoryStorage implements CaptureStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

class MutableClock implements Clock {
  constructor(private instant = new Date("2026-01-08T00:00:00.000Z")) {}

  now(): Date {
    return new Date(this.instant);
  }

  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}

const acquisition: AcquisitionContext = {
  referrer: "https://search.example/",
  utm: { source: "search", medium: "organic", campaign: "winter_launch" },
  landingPage: "https://shop.example/checkout",
  device: "desktop",
};

const validKey = `tl_pk_${"a".repeat(26)}`;

interface StoredQueueForTest {
  events: Event[];
  drops: Partial<Record<DropCount["reason"], number>>;
}

function queue(storage: MemoryStorage): StoredQueueForTest {
  return JSON.parse(
    storage.values.get("__tl.q") ?? '{"events":[],"drops":{}}',
  ) as StoredQueueForTest;
}

function setup(
  responses: Array<TransportResponse | Error> = [],
  captureAcquisition = acquisition,
) {
  const storage = new MemoryStorage();
  const clock = new MutableClock();
  const requests: Parameters<CaptureTransport["send"]>[0][] = [];
  const transport: CaptureTransport = {
    async send(request) {
      requests.push(request);
      const response = responses.shift() ?? { status: 202 };
      if (response instanceof Error) throw response;
      return response;
    },
  };
  const runtime = createCaptureEngine(
    { transport, storage, clock },
    captureAcquisition,
  );
  runtime.engine.init({ key: validKey });
  return { runtime, storage, clock, requests };
}

describe("capture engine", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("creates no storage, identifier, or request before consent and caps memory at 100", async () => {
    const { runtime, storage, requests } = setup();

    for (let index = 0; index < 101; index += 1) {
      runtime.engine.step("checkout_started", { index });
    }
    await vi.advanceTimersByTimeAsync(60_000);

    expect([...storage.values.keys()]).toEqual([]);
    expect(requests).toEqual([]);

    runtime.engine.consent.grant();
    expect(queue(storage).events).toHaveLength(101);
  });

  it("denial clears buffered and persisted capture state", () => {
    const { runtime, storage } = setup();
    runtime.engine.step("checkout_started");
    runtime.engine.consent.grant();
    runtime.engine.consent.deny();

    expect([...storage.values.entries()]).toEqual([["__tl.c", "denied"]]);
    expect(runtime.engine.consent.state()).toBe("denied");
  });

  it("rotates a UUIDv7 session at 30 minutes and emits session_start first", () => {
    const { runtime, storage, clock } = setup();
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");
    const firstSession = storage.values.get("__tl.s");

    clock.advance(30 * 60 * 1000);
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
      value: 99.95,
      currency: "EUR",
    });

    const events = queue(storage).events;
    const secondSession = storage.values.get("__tl.s");
    expect(firstSession).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(secondSession).not.toBe(firstSession);
    expect(events.map((event) => event.kind)).toEqual([
      "session_start",
      "step",
      "session_start",
      "conversion",
    ]);
    expect(events[2]?.sessionId).toBe(secondSession);
  });

  it("keeps 200 queued events FIFO, drops oldest, and counts overflow", () => {
    const { runtime, storage } = setup();
    runtime.engine.consent.grant();
    for (let index = 0; index < 201; index += 1) {
      runtime.engine.step("checkout_started", { index });
    }

    const stored = queue(storage);
    expect(stored.events).toHaveLength(200);
    expect(stored.events[0]).toMatchObject({
      kind: "step",
      context: { index: 1 },
    });
    expect(stored.drops).toEqual({ queue_overflow: 2 });
  });

  it("limits batches by event count and the contract byte budget", async () => {
    const { runtime, requests } = setup();
    runtime.engine.consent.grant();
    for (let index = 0; index < 80; index += 1) {
      runtime.engine.step("checkout_started", {
        index,
        padding: "x".repeat(7_500),
      });
    }

    await runtime.flush();
    const batch = requests[0]?.batch;
    expect(batch).toBeDefined();
    expect(eventBatchSchema.safeParse(batch).success).toBe(true);
    expect(batch!.events.length).toBeLessThanOrEqual(50);
    expect(
      new TextEncoder().encode(JSON.stringify(batch)).byteLength,
    ).toBeLessThanOrEqual(MAX_BATCH_BYTES);
  });

  it("marks verification traffic and preserves keepalive delivery", async () => {
    const { runtime, requests } = setup([], {
      ...acquisition,
      mode: "verification",
    });
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");

    await runtime.flush(true);

    expect(requests[0]?.keepalive).toBe(true);
    expect(
      requests[0]?.batch.events.every((event) => event.mode === "verification"),
    ).toBe(true);
  });

  it("uses deterministic exponential retry delays", async () => {
    const { runtime, requests, clock } = setup([
      new Error("offline"),
      new Error("offline"),
      { status: 202 },
    ]);
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");

    await runtime.flush();
    expect(requests).toHaveLength(1);
    clock.advance(999);
    await vi.advanceTimersByTimeAsync(999);
    expect(requests).toHaveLength(1);
    clock.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
    clock.advance(1_999);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(requests).toHaveLength(2);
    clock.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(3);
  });

  it("opens after five failures and admits one half-open probe after 60 seconds", async () => {
    const { runtime, requests, clock } = setup([
      new Error("offline"),
      new Error("offline"),
      { status: 503 },
      { status: 500 },
      new Error("offline"),
      { status: 202 },
    ]);
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");

    await runtime.flush();
    for (const delay of [1_000, 2_000, 4_000, 8_000]) {
      clock.advance(delay);
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(requests).toHaveLength(5);
    expect(runtime.circuitState()).toBe("open");

    clock.advance(59_999);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(requests).toHaveLength(5);
    clock.advance(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(6);
    expect(runtime.circuitState()).toBe("closed");
  });

  it("does not retry 4xx batches and counts every rejected event", async () => {
    const { runtime, storage, requests } = setup([{ status: 403 }]);
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");

    await runtime.flush();
    expect(requests).toHaveLength(1);
    expect(queue(storage)).toEqual({
      events: [],
      drops: { server_rejected: 2 },
    });
  });

  /**
   * The one 4xx that is transient by construction: the ingestion limit is per
   * public key, so a busy minute refuses sound events. They are kept and
   * retried, never counted as rejected ([spec/capture.md] § Delivery).
   */
  it("keeps a rate-limited batch and retries it", async () => {
    const { runtime, storage, requests } = setup([
      { status: 429 },
      { status: 202 },
    ]);
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");

    await runtime.flush();
    expect(requests).toHaveLength(1);
    expect(queue(storage).events).toHaveLength(2);
    expect(queue(storage).drops).toEqual({});

    await vi.advanceTimersByTimeAsync(1000);
    expect(requests).toHaveLength(2);
    expect(queue(storage)).toEqual({ events: [], drops: {} });
  });

  it("captures errors only after a declared event and attaches the latest name", () => {
    const { runtime, storage } = setup();
    runtime.engine.consent.grant();
    runtime.captureError("outside the path");
    runtime.engine.step("checkout_started");
    runtime.captureError("é".repeat(600));

    const errors = queue(storage).events.filter(
      (event) => event.kind === "error",
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "capture_error",
      stepName: "checkout_started",
    });
    expect(new TextEncoder().encode(errors[0]!.message).byteLength).toBe(1024);
  });
});
