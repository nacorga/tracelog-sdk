import type { Clock } from "@tracelog/capture-core";
import {
  eventBatchSchema,
  MAX_BATCH_BYTES,
  validateEventBatch,
  type EventBatch,
} from "@tracelog/event-contract";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  EVENT_CONTRACT_FIXTURE_INSTANT,
  validationClassFixtures,
  validEventBatchFixtures,
} from "./index.js";

const clock: Clock = {
  now: () => new Date(EVENT_CONTRACT_FIXTURE_INSTANT),
};

function roundTrip(input: unknown): unknown {
  return JSON.parse(JSON.stringify(input)) as unknown;
}

describe("event contract golden fixtures", () => {
  it("round-trips one typed valid fixture per event kind", () => {
    for (const [kind, fixture] of Object.entries(validEventBatchFixtures)) {
      const parsed = eventBatchSchema.parse(roundTrip(fixture));
      expect(parsed).toEqual(fixture);
      expect(parsed.events[0]?.kind).toBe(kind);

      const result = validateEventBatch(parsed, clock);
      expect(result).toEqual({ accepted: true, batch: fixture, flags: [] });
      if (result.accepted) {
        expectTypeOf(result.batch).toEqualTypeOf<EventBatch>();
      }
    }
  });

  it("fails rejected fixtures with exactly their pinned class", () => {
    for (const [classification, fixture] of Object.entries(
      validationClassFixtures,
    )) {
      if (classification === "late") continue;

      expect(validateEventBatch(roundTrip(fixture.input), clock)).toEqual(
        fixture.expected,
      );
    }
  });

  it("accepts and flags the late fixture", () => {
    const fixture = validationClassFixtures.late;
    const result = validateEventBatch(roundTrip(fixture.input), clock);

    expect(result).toMatchObject({ accepted: true });
    if (result.accepted) {
      expect(result.flags).toEqual([
        {
          classification: fixture.expected.classification,
          eventId: "018f0e80-7b20-7000-8000-000000000005",
        },
      ]);
    }
  });

  it("keeps the too-large fixture over the 256 KB wire limit", () => {
    const serialized = JSON.stringify(validationClassFixtures.too_large.input);
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(
      MAX_BATCH_BYTES,
    );
  });
});
