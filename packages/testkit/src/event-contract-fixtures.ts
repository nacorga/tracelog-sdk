import type {
  Event,
  EventBatch,
  RejectionClass,
  ValidationClass,
} from "@tracelog/event-contract";

export const EVENT_CONTRACT_FIXTURE_INSTANT =
  "2026-01-08T00:00:00.000Z" as const;

const eventIds = {
  sessionStart: "018f0e80-7b20-7000-8000-000000000001",
  step: "018f0e80-7b20-7000-8000-000000000002",
  conversion: "018f0e80-7b20-7000-8000-000000000003",
  error: "018f0e80-7b20-7000-8000-000000000004",
  fixture: "018f0e80-7b20-7000-8000-000000000005",
} as const;

const sessionId = "018f0e80-7b20-7000-8000-000000000100" as const;

export const validEventBatchFixtures = {
  session_start: {
    v: 1,
    events: [
      {
        kind: "session_start",
        eventId: eventIds.sessionStart,
        sessionId,
        name: "session_started",
        occurredAt: "2026-01-07T12:00:00.000Z",
        referrer: "https://search.example/",
        utm: {
          source: "search",
          medium: "organic",
          campaign: "winter_launch",
        },
        landingPage: "https://shop.example/checkout",
        device: "desktop",
        context: { locale: "en-GB" },
      },
    ],
  },
  step: {
    v: 1,
    events: [
      {
        kind: "step",
        eventId: eventIds.step,
        sessionId,
        name: "checkout_started",
        occurredAt: "2026-01-07T12:01:00.000Z",
        context: { cartItems: 2 },
      },
    ],
  },
  conversion: {
    v: 1,
    events: [
      {
        kind: "conversion",
        eventId: eventIds.conversion,
        sessionId,
        name: "purchase_completed",
        occurredAt: "2026-01-07T12:02:00.000Z",
        identifier: "order_123",
        value: 99.95,
        currency: "EUR",
        mode: "verification",
        context: { checkoutVersion: "v2" },
      },
    ],
  },
  error: {
    v: 1,
    events: [
      {
        kind: "error",
        eventId: eventIds.error,
        sessionId,
        name: "checkout_error",
        occurredAt: "2026-01-07T12:01:30.000Z",
        message: "Payment provider unavailable",
        stepName: "checkout_started",
        context: { errorCode: "provider_unavailable" },
      },
    ],
  },
} as const satisfies Record<Event["kind"], EventBatch>;

const validationStepEvent = {
  kind: "step",
  eventId: eventIds.fixture,
  sessionId,
  name: "checkout_started",
  occurredAt: "2026-01-07T12:00:00.000Z",
} as const;

export type GoldenValidationExpectation =
  | { accepted: false; classification: RejectionClass }
  | { accepted: true; classification: "late" };

export interface GoldenValidationFixture {
  input: unknown;
  expected: GoldenValidationExpectation;
}

export const validationClassFixtures = {
  unknown_version: {
    input: { v: 2, events: [] },
    expected: { accepted: false, classification: "unknown_version" },
  },
  invalid_schema: {
    input: {
      v: 1,
      events: [{ ...validationStepEvent, name: "CheckoutStarted" }],
    },
    expected: { accepted: false, classification: "invalid_schema" },
  },
  too_large: {
    input: {
      v: 1,
      events: Array.from({ length: 50 }, () => ({
        ...validationStepEvent,
        context: { padding: "x".repeat(6_000) },
      })),
    },
    expected: { accepted: false, classification: "too_large" },
  },
  future_time: {
    input: {
      v: 1,
      events: [
        {
          ...validationStepEvent,
          occurredAt: "2026-01-08T00:05:00.001Z",
        },
      ],
    },
    expected: { accepted: false, classification: "future_time" },
  },
  late: {
    input: {
      v: 1,
      events: [
        {
          ...validationStepEvent,
          occurredAt: "2025-12-31T23:59:59.999Z",
        },
      ],
    },
    expected: { accepted: true, classification: "late" },
  },
} satisfies Record<ValidationClass, GoldenValidationFixture>;
