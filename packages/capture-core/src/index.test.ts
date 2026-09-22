import {
  eventBatchSchema,
  MAX_BATCH_BYTES,
  MAX_CONTEXT_BYTES,
  TAG_SIGHTINGS_CONTEXT_KEY,
  tagSightingReportSchema,
} from "@tracelog/event-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCaptureEngine,
  TAG_SIGHTING_AFTER_MS,
  type AcquisitionContext,
  type CaptureStorage,
  type CaptureTransport,
  type DropCount,
  type TagSighting,
  type TagSightingKind,
  type TagSightingPort,
  type TransportResponse,
  type Clock,
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
  sightings?: TagSightingPort,
  storage = new MemoryStorage(),
) {
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
    {
      transport,
      storage,
      clock,
      ...(sightings === undefined ? {} : { sightings }),
    },
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

  /**
   * A refusal is the one thing remembered before any grant: one key, no
   * identifier, nothing else, so the visitor who refused is not asked again by
   * the runtime on the next load ([spec/capture.md] § Consent first).
   */
  it("remembers a denial before any grant as one key and nothing else", () => {
    const { runtime, storage, requests } = setup();
    runtime.engine.step("checkout_started");
    runtime.engine.consent.deny();

    expect([...storage.values.entries()]).toEqual([["__tl.c", "denied"]]);
    expect(requests).toEqual([]);

    const next = createCaptureEngine(
      {
        transport: { send: async () => ({ status: 202 }) },
        storage,
        clock: new MutableClock(),
      },
      acquisition,
    );
    next.engine.init({ key: validKey });
    next.engine.step("checkout_started");
    expect(next.engine.consent.state()).toBe("denied");
    expect([...storage.values.entries()]).toEqual([["__tl.c", "denied"]]);
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

  /**
   * No batch can carry an event over the budget on its own, so left at the
   * head of the queue it would hold everything behind it until overflow shifted
   * it out. It is dropped and counted instead, and the queue moves.
   */
  it("drops an event no batch can carry as invalid and keeps delivering", async () => {
    const { runtime, storage, requests } = setup([], {
      ...acquisition,
      landingPage: `https://shop.example/?q=${"x".repeat(MAX_BATCH_BYTES)}`,
    });
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");
    expect(queue(storage).events.map((event) => event.kind)).toEqual([
      "session_start",
      "step",
    ]);

    await runtime.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.batch.events.map((event) => event.kind)).toEqual([
      "step",
    ]);
    expect(queue(storage)).toEqual({ events: [], drops: { invalid_event: 1 } });
    expect(runtime.drops()).toEqual([{ reason: "invalid_event", count: 1 }]);
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

/**
 * A port the test drives: whether it observes, and what it answers. The one
 * that reads the page is `capture-web`'s; the engine only asks.
 */
class FakeSightingPort implements TagSightingPort {
  started = 0;
  stopped = 0;
  supported = true;
  answer: TagSighting[] | null = [];
  readonly asked: Date[] = [];
  private active = false;

  start(): void {
    this.started += 1;
    this.active = this.supported;
  }

  stop(): void {
    this.stopped += 1;
    this.active = false;
  }

  observing(): boolean {
    return this.active;
  }

  around(at: Date): TagSighting[] | null {
    this.asked.push(at);
    return this.answer;
  }
}

/** A port that can also say which kinds it saw requested and could not read. */
class FakeUnreadPort extends FakeSightingPort {
  unread: TagSightingKind[] | null = [];
  readonly askedUnread: Date[] = [];

  unreadAround(at: Date): TagSightingKind[] | null {
    this.askedUnread.push(at);
    return this.unread;
  }
}

const metaPurchase: TagSighting = {
  kind: "meta",
  id: "123456789012345",
  event: "Purchase",
};
const ga4: TagSighting = { kind: "ga4", id: "G-ABC123XYZ9", event: null };

/** The engine's clock and its timers move together, a tenth of a second at a time. */
async function elapse(clock: MutableClock, milliseconds: number) {
  for (let passed = 0; passed < milliseconds; passed += 100) {
    clock.advance(100);
    await vi.advanceTimersByTimeAsync(100);
  }
}

function sent(requests: Parameters<CaptureTransport["send"]>[0][]): Event[] {
  return requests.flatMap((request) => request.batch.events);
}

function conversionsSent(
  requests: Parameters<CaptureTransport["send"]>[0][],
): Event[] {
  return sent(requests).filter((event) => event.kind === "conversion");
}

function reportOf(event: Event | undefined) {
  return event?.context?.[TAG_SIGHTINGS_CONTEXT_KEY];
}

/** [spec/capture.md] § Tag sightings */
describe("tag sightings", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("holds a conversion ten seconds, then sends exactly what the port saw around it, complete", async () => {
    const port = new FakeSightingPort();
    port.answer = [metaPurchase, ga4];
    const { runtime, clock, requests } = setup([], acquisition, port);
    runtime.engine.consent.grant();
    const at = clock.now();
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });

    await elapse(clock, TAG_SIGHTING_AFTER_MS - 100);
    expect(sent(requests).map((event) => event.kind)).toEqual([
      "session_start",
    ]);

    await elapse(clock, 100);
    const [conversion] = conversionsSent(requests);
    expect(conversion?.context).toEqual({
      [TAG_SIGHTINGS_CONTEXT_KEY]: {
        complete: true,
        sightings: [metaPurchase, ga4],
      },
    });
    expect(
      tagSightingReportSchema.safeParse(reportOf(conversion)).success,
    ).toBe(true);
    expect(port.asked).toEqual([at]);
  });

  it("carries the kinds the port could not read after the sightings, and only when it answers them", async () => {
    async function reportFrom(port: TagSightingPort, hideAfter?: number) {
      const { runtime, clock, requests } = setup([], acquisition, port);
      runtime.engine.consent.grant();
      runtime.engine.conversion("purchase_completed", {
        identifier: "order_123",
      });
      if (hideAfter === undefined) {
        await elapse(clock, TAG_SIGHTING_AFTER_MS);
      } else {
        clock.advance(hideAfter);
        await runtime.flush(true);
      }
      return { requests };
    }

    const unread = new FakeUnreadPort();
    unread.answer = [ga4];
    unread.unread = ["meta"];
    const withMeta = await reportFrom(unread);
    const reported = reportOf(conversionsSent(withMeta.requests)[0]);
    expect(reported).toEqual({
      complete: true,
      sightings: [ga4],
      unread: ["meta"],
    });
    expect(Object.keys(reported as object)).toEqual([
      "complete",
      "sightings",
      "unread",
    ]);
    expect(tagSightingReportSchema.safeParse(reported).success).toBe(true);
    expect(unread.askedUnread).toEqual(unread.asked);

    const none = new FakeUnreadPort();
    none.answer = [ga4];
    none.unread = [];
    expect(
      reportOf(conversionsSent((await reportFrom(none)).requests)[0]),
    ).toEqual({ complete: true, sightings: [ga4], unread: [] });

    const unanswered = new FakeUnreadPort();
    unanswered.answer = [ga4];
    unanswered.unread = null;
    const without = new FakeSightingPort();
    without.answer = [ga4];
    for (const port of [unanswered, without]) {
      const report = reportOf(
        conversionsSent((await reportFrom(port)).requests)[0],
      );
      expect(report).toEqual({ complete: true, sightings: [ga4] });
      expect(Object.keys(report as object)).not.toContain("unread");
    }

    // `complete` does not read the list: cut short with it and without it.
    const cutWith = new FakeUnreadPort();
    cutWith.answer = [ga4];
    cutWith.unread = ["meta"];
    const cutWithout = new FakeSightingPort();
    cutWithout.answer = [ga4];
    expect(
      reportOf(conversionsSent((await reportFrom(cutWith, 3_000)).requests)[0]),
    ).toEqual({ complete: false, sightings: [ga4], unread: ["meta"] });
    expect(
      reportOf(
        conversionsSent((await reportFrom(cutWithout, 3_000)).requests)[0],
      ),
    ).toEqual({ complete: false, sightings: [ga4] });
  });

  it("releases every held conversion at page hide: cut short before ten seconds, complete after them", async () => {
    const early = new FakeSightingPort();
    early.answer = [metaPurchase];
    const before = setup([], acquisition, early);
    before.runtime.engine.consent.grant();
    before.runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });
    before.clock.advance(3_000);
    await before.runtime.flush(true);

    expect(before.requests[0]?.keepalive).toBe(true);
    expect(reportOf(conversionsSent(before.requests)[0])).toEqual({
      complete: false,
      sightings: [metaPurchase],
    });

    const late = new FakeSightingPort();
    late.answer = [metaPurchase];
    const after = setup([], acquisition, late);
    after.runtime.engine.consent.grant();
    after.runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });
    after.clock.advance(TAG_SIGHTING_AFTER_MS);
    await after.runtime.flush(true);

    expect(reportOf(conversionsSent(after.requests)[0])).toEqual({
      complete: true,
      sightings: [metaPurchase],
    });
  });

  it("cuts an answer of seventeen to the first sixteen, and says it was cut", async () => {
    const port = new FakeSightingPort();
    port.answer = Array.from({ length: 17 }, (_, index) => ({
      kind: "meta" as const,
      id: String(100_000 + index),
      event: null,
    }));
    const { runtime, clock, requests } = setup([], acquisition, port);
    runtime.engine.consent.grant();
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });
    await elapse(clock, TAG_SIGHTING_AFTER_MS);

    const report = reportOf(conversionsSent(requests)[0]);
    expect(report).toEqual({
      complete: false,
      sightings: port.answer.slice(0, 16),
    });
    expect(tagSightingReportSchema.safeParse(report).success).toBe(true);
  });

  it("sends no key when the port cannot answer, and keeps the customer's context", async () => {
    const port = new FakeSightingPort();
    port.answer = null;
    const { runtime, clock, requests } = setup([], acquisition, port);
    runtime.engine.consent.grant();
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
      context: { checkoutVersion: "v2" },
    });
    await elapse(clock, TAG_SIGHTING_AFTER_MS);

    expect(conversionsSent(requests)[0]?.context).toEqual({
      checkoutVersion: "v2",
    });
    expect(port.asked).toHaveLength(1);
  });

  it("holds nothing while the port is not observing", async () => {
    const port = new FakeSightingPort();
    port.supported = false;
    const { runtime, clock, requests } = setup([], acquisition, port);
    runtime.engine.consent.grant();
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });
    await elapse(clock, 5_000);

    expect(sent(requests).map((event) => event.kind)).toEqual([
      "session_start",
      "conversion",
    ]);
    expect(conversionsSent(requests)[0]?.context).toBeUndefined();
    expect(port.asked).toEqual([]);
  });

  it("holds nothing in verification mode and sends no key", async () => {
    const port = new FakeSightingPort();
    port.answer = [metaPurchase];
    const { runtime, clock, requests } = setup(
      [],
      { ...acquisition, mode: "verification" },
      port,
    );
    runtime.engine.consent.grant();
    expect(port.observing()).toBe(true);
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });
    await elapse(clock, 5_000);

    const [conversion] = conversionsSent(requests);
    expect(conversion?.mode).toBe("verification");
    expect(conversion?.context).toBeUndefined();
    expect(port.asked).toEqual([]);
  });

  it("stops the port on deny and forgets every held conversion", async () => {
    const port = new FakeSightingPort();
    port.answer = [metaPurchase];
    const { runtime, storage, requests } = setup([], acquisition, port);
    runtime.engine.consent.grant();
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });
    runtime.engine.consent.deny();

    expect(port.stopped).toBe(1);
    expect(port.observing()).toBe(false);
    expect([...storage.values.entries()]).toEqual([["__tl.c", "denied"]]);

    runtime.engine.consent.grant();
    await runtime.flush(true);
    expect(port.asked).toEqual([]);
    expect(requests).toEqual([]);
  });

  it("removes a customer's __tl. keys from a step's and a conversion's context, and keeps the rest", () => {
    const port = new FakeSightingPort();
    const { runtime, storage } = setup([], acquisition, port);
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started", {
      "__tl.tags": { complete: true, sightings: [] },
      "__tl.c": "granted",
      __tlx: 1,
      cartItems: 2,
    });
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
      context: { "__tl.tags": "forged", checkoutVersion: "v2" },
    });

    const [step, conversion] = queue(storage).events.filter(
      (event) => event.kind !== "session_start",
    );
    expect(step?.context).toEqual({ __tlx: 1, cartItems: 2 });
    expect(conversion?.context).toEqual({ checkoutVersion: "v2" });
  });

  it("leaves an oversized result as the customer's context, with no key", async () => {
    const port = new FakeSightingPort();
    port.answer = [metaPurchase, ga4];
    const { runtime, clock, requests } = setup([], acquisition, port);
    runtime.engine.consent.grant();
    const context = { padding: "x".repeat(MAX_CONTEXT_BYTES - 40) };
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
      context,
    });
    await elapse(clock, TAG_SIGHTING_AFTER_MS);

    expect(conversionsSent(requests)[0]?.context).toEqual(context);
  });

  it("never holds a step, a session start or an error", async () => {
    const port = new FakeSightingPort();
    const { runtime, clock, requests } = setup([], acquisition, port);
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");
    runtime.captureError("payment widget failed");
    await elapse(clock, 5_000);

    expect(sent(requests).map((event) => event.kind)).toEqual([
      "session_start",
      "step",
      "error",
    ]);
    expect(port.asked).toEqual([]);
  });

  it("sends a conversion an earlier page left in the queue as it is", async () => {
    const earlier = new MemoryStorage();
    const left = setup([], acquisition, undefined, earlier);
    left.runtime.engine.consent.grant();
    left.runtime.engine.conversion("purchase_completed", {
      identifier: "order_122",
      context: { checkoutVersion: "v1" },
    });
    const queued = queue(earlier).events.find(
      (event) => event.kind === "conversion",
    );
    // The earlier page is gone, and its timers with it.
    vi.clearAllTimers();

    const port = new FakeSightingPort();
    port.answer = [metaPurchase];
    const { clock, requests } = setup([], acquisition, port, earlier);
    await elapse(clock, 5_000);

    expect(conversionsSent(requests)).toEqual([queued]);
    expect(port.asked).toEqual([]);
  });

  it("starts the port on a grant and on a remembered grant, and never before", () => {
    const port = new FakeSightingPort();
    const { runtime } = setup([], acquisition, port);
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });
    expect(port.started).toBe(0);
    runtime.engine.consent.grant();
    expect(port.started).toBe(1);

    const remembered = new MemoryStorage();
    remembered.setItem("__tl.c", "granted");
    const rememberedPort = new FakeSightingPort();
    setup([], acquisition, rememberedPort, remembered);
    expect(rememberedPort.started).toBe(1);

    const refused = new MemoryStorage();
    refused.setItem("__tl.c", "denied");
    const refusedPort = new FakeSightingPort();
    setup([], acquisition, refusedPort, refused);
    expect(refusedPort.started).toBe(0);
  });

  it("places a conversion buffered before the grant at the grant, and never calls its report complete", async () => {
    const port = new FakeSightingPort();
    port.answer = [metaPurchase];
    const { runtime, clock, requests } = setup([], acquisition, port);
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });
    clock.advance(20_000);
    const grantedAt = clock.now();
    runtime.engine.consent.grant();

    await elapse(clock, TAG_SIGHTING_AFTER_MS - 100);
    expect(conversionsSent(requests)).toEqual([]);
    await elapse(clock, 100);

    expect(reportOf(conversionsSent(requests)[0])).toEqual({
      complete: false,
      sightings: [metaPurchase],
    });
    expect(port.asked).toEqual([grantedAt]);
  });

  it("sends at page hide without waiting for a send in flight, and neither send removes what the other delivered", async () => {
    const port = new FakeSightingPort();
    port.answer = [metaPurchase];
    const storage = new MemoryStorage();
    const clock = new MutableClock();
    const requests: Parameters<CaptureTransport["send"]>[0][] = [];
    let settleFirst: (response: TransportResponse) => void = () => undefined;
    const runtime = createCaptureEngine(
      {
        transport: {
          send(request) {
            requests.push(request);
            if (requests.length > 1) return Promise.resolve({ status: 202 });
            return new Promise((resolve) => {
              settleFirst = resolve;
            });
          },
        },
        storage,
        clock,
        sightings: port,
      },
      acquisition,
    );
    runtime.engine.init({ key: validKey });
    runtime.engine.consent.grant();
    runtime.engine.step("checkout_started");
    runtime.engine.conversion("purchase_completed", {
      identifier: "order_123",
    });

    const first = runtime.flush();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.batch.events.map((event) => event.kind)).toEqual([
      "session_start",
      "step",
    ]);

    clock.advance(2_000);
    await runtime.flush(true);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.keepalive).toBe(true);
    expect(requests[1]?.batch.events.map((event) => event.kind)).toEqual([
      "conversion",
    ]);
    expect(reportOf(requests[1]?.batch.events[0])).toEqual({
      complete: false,
      sightings: [metaPurchase],
    });
    expect(queue(storage).events.map((event) => event.kind)).toEqual([
      "session_start",
      "step",
    ]);

    settleFirst({ status: 202 });
    await first;
    expect(queue(storage).events).toEqual([]);
    expect(runtime.circuitState()).toBe("closed");
  });
});
