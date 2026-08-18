import { describe, expect, it } from "vitest";

import {
  conversionEventSchema,
  contextSchema,
  errorMessageSchema,
  eventBatchSchema,
  eventIdSchema,
  eventNameSchema,
  occurredAtSchema,
  sessionStartEventSchema,
  validateEventBatch,
} from "./index.js";

const clock = { now: () => new Date("2026-01-08T00:00:00.000Z") };

describe("event contract schemas", () => {
  it("pins event names and UTC millisecond timestamps", () => {
    expect(
      eventIdSchema.safeParse("018f0e80-7b20-7000-8000-000000000001").success,
    ).toBe(true);
    expect(
      eventIdSchema.safeParse("018f0e80-7b20-4000-8000-000000000001").success,
    ).toBe(false);
    expect(eventNameSchema.safeParse("checkout_started").success).toBe(true);
    expect(eventNameSchema.safeParse("CheckoutStarted").success).toBe(false);
    expect(occurredAtSchema.safeParse("2026-01-07T12:00:00.000Z").success).toBe(
      true,
    );
    expect(occurredAtSchema.safeParse("2026-01-07T12:00:00Z").success).toBe(
      false,
    );
    expect(
      occurredAtSchema.safeParse("2026-01-07T13:00:00.000+01:00").success,
    ).toBe(false);
  });

  it("measures context and error limits as UTF-8 bytes", () => {
    expect(contextSchema.safeParse({ value: "x".repeat(8_180) }).success).toBe(
      true,
    );
    expect(contextSchema.safeParse({ value: "x".repeat(8_181) }).success).toBe(
      false,
    );
    expect(errorMessageSchema.safeParse("é".repeat(512)).success).toBe(true);
    expect(errorMessageSchema.safeParse("é".repeat(513)).success).toBe(false);
  });

  it("rejects more than 50 events and unexpected wire fields", () => {
    const event = {
      kind: "step" as const,
      eventId: "018f0e80-7b20-7000-8000-000000000001",
      sessionId: "018f0e80-7b20-7000-8000-000000000002",
      name: "checkout_started",
      occurredAt: "2026-01-07T12:00:00.000Z",
    };

    expect(
      eventBatchSchema.safeParse({
        v: 1,
        events: Array.from({ length: 51 }, () => event),
      }).success,
    ).toBe(false);
    expect(
      eventBatchSchema.safeParse({ v: 1, events: [], extra: true }).success,
    ).toBe(false);
  });

  it("keeps server-derived country and conversion record ids off the wire", () => {
    const common = {
      eventId: "018f0e80-7b20-7000-8000-000000000001",
      sessionId: "018f0e80-7b20-7000-8000-000000000002",
      occurredAt: "2026-01-07T12:00:00.000Z",
    };

    expect(
      sessionStartEventSchema.safeParse({
        ...common,
        kind: "session_start",
        name: "session_started",
        utm: {},
        landingPage: "https://shop.example/",
        device: "mobile",
        country: "ES",
      }).success,
    ).toBe(false);
    expect(
      conversionEventSchema.safeParse({
        ...common,
        kind: "conversion",
        name: "purchase_completed",
        identifier: "order_123",
        conversionId: "018f0e80-7b20-7000-8000-000000000003",
      }).success,
    ).toBe(false);
    expect(
      conversionEventSchema.safeParse({
        ...common,
        kind: "conversion",
        name: "purchase_completed",
        identifier: "order_123",
        mode: "live",
      }).success,
    ).toBe(false);
  });

  it("uses the injected clock at the exact time boundaries", () => {
    const event = {
      kind: "step" as const,
      eventId: "018f0e80-7b20-7000-8000-000000000001",
      sessionId: "018f0e80-7b20-7000-8000-000000000002",
      name: "checkout_started",
      occurredAt: "2026-01-08T00:05:00.000Z",
    };

    expect(validateEventBatch({ v: 1, events: [event] }, clock)).toEqual({
      accepted: true,
      batch: { v: 1, events: [event] },
      flags: [],
    });
    expect(
      validateEventBatch(
        {
          v: 1,
          events: [
            {
              ...event,
              occurredAt: "2026-01-08T00:05:00.001Z",
            },
          ],
        },
        clock,
      ),
    ).toEqual({ accepted: false, classification: "future_time" });
  });
});
