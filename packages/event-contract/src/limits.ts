/**
 * The envelope's limits and the tag sighting's constants, apart from the
 * schemas: a runtime imports only these, and a module that builds no zod
 * schema is one a bundler can keep while it drops `schema.ts` — and zod with
 * it — from a bundle that never validates.
 */
export const EVENT_ENVELOPE_VERSION = 1 as const;
export const MAX_BATCH_EVENTS = 50;
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_CONTEXT_BYTES = 8 * 1024;
export const MAX_ERROR_MESSAGE_BYTES = 1024;
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const LATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The tag sighting: which GA4, Meta and Google Ads tags the page requested
 * around a conversion, carried in that conversion's `context` under
 * `TAG_SIGHTINGS_CONTEXT_KEY` ([spec/capture.md] § Tag sightings). The
 * envelope does not validate it — `context` stays the free-form bag it is —
 * so a platform pinned at any 1.x accepts a conversion carrying it; the
 * platform parses it with `tagSightingReportSchema`, and a value that fails
 * is no report.
 */
export const TAG_SIGHTINGS_CONTEXT_KEY = "__tl.tags";
export const MAX_TAG_SIGHTINGS = 16;
export const tagSightingKinds = ["ga4", "meta", "google_ads"] as const;
export type TagSightingKind = (typeof tagSightingKinds)[number];
/** Source strings, so the bundle can inline them and both sides build one pattern. */
export const TAG_ID_PATTERNS: Readonly<Record<TagSightingKind, string>> = {
  ga4: "^G-[A-Z0-9]{4,15}$",
  meta: "^[0-9]{6,20}$",
  google_ads: "^AW-[0-9]{6,15}(?:/[A-Za-z0-9_-]{1,64})?$",
};
export const TAG_EVENT_PATTERN = "^[A-Za-z0-9_]{1,64}$";
