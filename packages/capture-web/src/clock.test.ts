import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instantOfEntry } from "./clock.js";

/**
 * A Resource Timing entry is dated on the page's monotonic clock and a
 * conversion on the system clock; the sighting compares the two, so an entry
 * is placed on the system clock by its age ([spec/capture.md] § Tag
 * sightings).
 */
describe("instantOfEntry", () => {
  const now = Date.parse("2026-09-21T12:00:00.000Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("places an entry at the system clock's reading minus the entry's age", () => {
    vi.stubGlobal("performance", { now: () => 8_000, timeOrigin: now - 8_000 });

    expect(instantOfEntry(5_000).toISOString()).toBe(
      "2026-09-21T11:59:57.000Z",
    );
  });

  it("does so unchanged when the page's time origin disagrees with that clock by an hour", () => {
    vi.stubGlobal("performance", {
      now: () => 8_000,
      timeOrigin: now - 8_000 - 60 * 60 * 1000,
    });

    expect(instantOfEntry(5_000).toISOString()).toBe(
      "2026-09-21T11:59:57.000Z",
    );
  });
});
