import { describe, expect, it } from "vitest";

import {
  conversionEventSchema,
  contextSchema,
  errorMessageSchema,
  eventBatchSchema,
  eventIdSchema,
  eventNameSchema,
  occurredAtSchema,
  MAX_TAG_SIGHTINGS,
  sessionStartEventSchema,
  TAG_SIGHTINGS_CONTEXT_KEY,
  tagSightingReportSchema,
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

/**
 * The report a conversion's context carries under `__tl.tags`
 * ([spec/capture.md] § Tag sightings): the runtime's output is tested against
 * it, and the platform parses with it, so both sides of the wire read one
 * shape.
 */
describe("the tag sighting report", () => {
  const ga4 = { kind: "ga4", id: "G-ABC123XYZ9", event: null } as const;
  const meta = { kind: "meta", id: "123456789012345", event: "Purchase" };
  const ads = { kind: "google_ads", id: "AW-1234567890", event: null };

  it("accepts a report complete or not, with each kind and a valid id", () => {
    for (const complete of [true, false]) {
      expect(
        tagSightingReportSchema.safeParse({
          complete,
          sightings: [ga4, meta, ads],
        }).success,
      ).toBe(true);
    }
    expect(
      tagSightingReportSchema.safeParse({ complete: true, sightings: [] })
        .success,
    ).toBe(true);
  });

  it("accepts Meta with a null or a valid event", () => {
    for (const event of [null, "PageView", "Purchase", "custom_event_1"]) {
      expect(
        tagSightingReportSchema.safeParse({
          complete: true,
          sightings: [{ ...meta, event }],
        }).success,
      ).toBe(true);
    }
  });

  it("accepts Google Ads with and without a conversion label", () => {
    for (const id of ["AW-1234567890", "AW-1234567890/AbC-12_xyz"]) {
      expect(
        tagSightingReportSchema.safeParse({
          complete: true,
          sightings: [{ ...ads, id }],
        }).success,
      ).toBe(true);
    }
  });

  it("refuses what the report does not name", () => {
    const refused: unknown[] = [
      // an unknown kind
      {
        complete: true,
        sightings: [{ kind: "tiktok", id: "123456", event: null }],
      },
      // an id of another kind's shape
      { complete: true, sightings: [{ ...ga4, id: "123456789012345" }] },
      { complete: true, sightings: [{ ...meta, id: "G-ABC123XYZ9" }] },
      { complete: true, sightings: [{ ...ads, id: "G-ABC123XYZ9" }] },
      // a GA4 or Google Ads sighting with an event
      { complete: true, sightings: [{ ...ga4, event: "purchase" }] },
      { complete: true, sightings: [{ ...ads, event: "conversion" }] },
      // an event with a space
      { complete: true, sightings: [{ ...meta, event: "Add To Cart" }] },
      // a seventeenth sighting
      {
        complete: false,
        sightings: Array.from({ length: MAX_TAG_SIGHTINGS + 1 }, () => meta),
      },
      // a report without `complete`
      { sightings: [meta] },
      // a key it does not name
      {
        complete: true,
        sightings: [meta],
        url: "https://www.facebook.com/tr/",
      },
      { complete: true, sightings: [{ ...meta, url: "https://x" }] },
    ];

    for (const report of refused) {
      expect(
        tagSightingReportSchema.safeParse(report).success,
        JSON.stringify(report),
      ).toBe(false);
    }
  });

  it("accepts a report without the kinds it could not read, or with them, each once", () => {
    for (const unread of [
      undefined,
      [],
      ["meta"],
      ["ga4", "meta", "google_ads"],
    ]) {
      expect(
        tagSightingReportSchema.safeParse({
          complete: true,
          sightings: [ga4],
          ...(unread === undefined ? {} : { unread }),
        }).success,
        JSON.stringify(unread),
      ).toBe(true);
    }
  });

  it("refuses a list of unread kinds that is not one of each at most", () => {
    for (const unread of [
      // an unknown kind
      ["tiktok"],
      // a kind twice
      ["meta", "meta"],
      // four entries
      ["ga4", "meta", "google_ads", "meta"],
      // a value that is not an array
      "meta",
    ]) {
      expect(
        tagSightingReportSchema.safeParse({
          complete: true,
          sightings: [meta],
          unread,
        }).success,
        JSON.stringify(unread),
      ).toBe(false);
    }
  });

  it("travels inside the free-form context the envelope already accepts", () => {
    const context = {
      [TAG_SIGHTINGS_CONTEXT_KEY]: { complete: true, sightings: [meta, ga4] },
    };
    expect(TAG_SIGHTINGS_CONTEXT_KEY).toBe("__tl.tags");
    expect(contextSchema.safeParse(context).success).toBe(true);
    expect(
      conversionEventSchema.safeParse({
        kind: "conversion",
        eventId: "018f0e80-7b20-7000-8000-000000000001",
        sessionId: "018f0e80-7b20-7000-8000-000000000002",
        name: "purchase_completed",
        occurredAt: "2026-01-07T12:00:00.000Z",
        identifier: "order_123",
        context,
      }).success,
    ).toBe(true);
  });
});
