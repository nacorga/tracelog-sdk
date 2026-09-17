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
