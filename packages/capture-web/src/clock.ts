import type { Clock } from "@tracelog/capture-core";

/**
 * The browser's clock, and the one file in this package allowed to read it
 * ([CLAUDE.md] § Invariants: time is injected). `capture-core` declares the
 * port and reads no clock at all — it runs inside sandboxes that have none —
 * so the implementation lives here, with the runtime that has a `Date`.
 */
export const systemClock: Clock = {
  now: () => new Date(Date.now()),
};

/**
 * A Resource Timing reading — an entry's start, or its end — on the system
 * clock: the clock's reading minus the reading's monotonic age. `performance.timeOrigin` would be a second clock, and
 * it can disagree with this one by as much as the machine's clock drifted
 * since the page loaded; the age is read on one clock and the instant on the
 * other, so a sighting and the conversion it is compared with are dated alike
 * ([spec/capture.md] § Tag sightings).
 */
export function instantOfEntry(startTime: number): Date {
  return new Date(
    systemClock.now().getTime() - (performance.now() - startTime),
  );
}
