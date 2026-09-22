import { z } from "zod";

export const EVENT_ENVELOPE_VERSION = 1 as const;
export const MAX_BATCH_EVENTS = 50;
export const MAX_BATCH_BYTES = 256 * 1024;
export const MAX_CONTEXT_BYTES = 8 * 1024;
export const MAX_ERROR_MESSAGE_BYTES = 1024;
export const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;
export const LATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function serializedByteLength(value: unknown): number | undefined {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? undefined : utf8ByteLength(serialized);
  } catch {
    return undefined;
  }
}

export const eventIdSchema = z.uuidv7();
export const sessionIdSchema = z.uuidv7();
export const eventNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const occurredAtSchema = z.iso.datetime({ precision: 3 });
export const eventModeSchema = z.literal("verification");
export const contextSchema = z
  .record(z.string(), z.json())
  .refine(
    (context) =>
      (serializedByteLength(context) ?? Number.POSITIVE_INFINITY) <=
      MAX_CONTEXT_BYTES,
    { message: `context must serialize to at most ${MAX_CONTEXT_BYTES} bytes` },
  );

const commonEventFields = {
  eventId: eventIdSchema,
  sessionId: sessionIdSchema,
  name: eventNameSchema,
  occurredAt: occurredAtSchema,
  mode: eventModeSchema.optional(),
  context: contextSchema.optional(),
};

export const utmSchema = z.strictObject({
  source: z.string().optional(),
  medium: z.string().optional(),
  campaign: z.string().optional(),
  term: z.string().optional(),
  content: z.string().optional(),
});

export const deviceSchema = z.enum(["desktop", "mobile", "tablet"]);

export const sessionStartEventSchema = z.strictObject({
  ...commonEventFields,
  kind: z.literal("session_start"),
  referrer: z.string().optional(),
  utm: utmSchema,
  landingPage: z.string(),
  device: deviceSchema,
});

export const stepEventSchema = z.strictObject({
  ...commonEventFields,
  kind: z.literal("step"),
});

export const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const conversionEventSchema = z.strictObject({
  ...commonEventFields,
  kind: z.literal("conversion"),
  identifier: z.string().min(1).max(256),
  value: z.number().nonnegative().optional(),
  currency: currencySchema.optional(),
});

export const errorMessageSchema = z
  .string()
  .refine((message) => utf8ByteLength(message) <= MAX_ERROR_MESSAGE_BYTES, {
    message: `message must be at most ${MAX_ERROR_MESSAGE_BYTES} bytes`,
  });

export const errorEventSchema = z.strictObject({
  ...commonEventFields,
  kind: z.literal("error"),
  message: errorMessageSchema,
  stepName: eventNameSchema,
});

export const eventSchema = z.discriminatedUnion("kind", [
  sessionStartEventSchema,
  stepEventSchema,
  conversionEventSchema,
  errorEventSchema,
]);

export const eventBatchSchema = z.strictObject({
  v: z.literal(EVENT_ENVELOPE_VERSION),
  events: z.array(eventSchema).max(MAX_BATCH_EVENTS),
});

export const validationClassSchema = z.enum([
  "unknown_version",
  "invalid_schema",
  "too_large",
  "future_time",
  "late",
]);

export const rejectionClassSchema = z.enum([
  "unknown_version",
  "invalid_schema",
  "too_large",
  "future_time",
]);

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

const tagId = (kind: TagSightingKind) =>
  z.string().regex(new RegExp(TAG_ID_PATTERNS[kind]));
export const tagSightingSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ga4"), id: tagId("ga4"), event: z.null() }),
  z.strictObject({
    kind: z.literal("meta"),
    id: tagId("meta"),
    event: z.string().regex(new RegExp(TAG_EVENT_PATTERN)).nullable(),
  }),
  z.strictObject({
    kind: z.literal("google_ads"),
    id: tagId("google_ads"),
    event: z.null(),
  }),
]);
export const tagSightingReportSchema = z.strictObject({
  /** False when the conversion left before its window closed, or more was sighted than fits. */
  complete: z.boolean(),
  sightings: z.array(tagSightingSchema).max(MAX_TAG_SIGHTINGS),
  /**
   * From 1.2.0, in every report whose window the runtime watched whole: each
   * kind the page requested inside the window whose tag the runtime could
   * not read, once. A report without it could not tell.
   */
  unread: z
    .array(z.enum(tagSightingKinds))
    .max(tagSightingKinds.length)
    .refine((kinds) => new Set(kinds).size === kinds.length, {
      message: "each kind at most once",
    })
    .optional(),
});
export type TagSighting = z.infer<typeof tagSightingSchema>;
export type TagSightingReport = z.infer<typeof tagSightingReportSchema>;

export type EventId = z.infer<typeof eventIdSchema>;
export type SessionId = z.infer<typeof sessionIdSchema>;
export type EventName = z.infer<typeof eventNameSchema>;
export type EventMode = z.infer<typeof eventModeSchema>;
export type EventContext = z.infer<typeof contextSchema>;
export type Utm = z.infer<typeof utmSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type SessionStartEvent = z.infer<typeof sessionStartEventSchema>;
export type StepEvent = z.infer<typeof stepEventSchema>;
export type ConversionEvent = z.infer<typeof conversionEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type Event = z.infer<typeof eventSchema>;
export type EventBatch = z.infer<typeof eventBatchSchema>;
export type ValidationClass = z.infer<typeof validationClassSchema>;
export type RejectionClass = z.infer<typeof rejectionClassSchema>;

export interface LateEventFlag {
  classification: "late";
  eventId: EventId;
}

export type EventBatchValidationResult =
  | {
      accepted: true;
      batch: EventBatch;
      flags: readonly LateEventFlag[];
    }
  | {
      accepted: false;
      classification: RejectionClass;
    };

function hasUnknownNumericVersion(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    "v" in input &&
    typeof input.v === "number" &&
    input.v !== EVENT_ENVELOPE_VERSION
  );
}

export function validateEventBatch(
  input: unknown,
  clock: { now(): Date },
): EventBatchValidationResult {
  const bodyBytes = serializedByteLength(input);
  if (bodyBytes !== undefined && bodyBytes > MAX_BATCH_BYTES) {
    return { accepted: false, classification: "too_large" };
  }

  if (hasUnknownNumericVersion(input)) {
    return { accepted: false, classification: "unknown_version" };
  }

  const parsed = eventBatchSchema.safeParse(input);
  if (!parsed.success) {
    return { accepted: false, classification: "invalid_schema" };
  }

  const now = clock.now().getTime();
  const flags: LateEventFlag[] = [];

  for (const event of parsed.data.events) {
    const occurredAt = new Date(event.occurredAt).getTime();
    if (occurredAt > now + FUTURE_TOLERANCE_MS) {
      return { accepted: false, classification: "future_time" };
    }

    if (occurredAt < now - LATE_AFTER_MS) {
      flags.push({ classification: "late", eventId: event.eventId });
    }
  }

  return { accepted: true, batch: parsed.data, flags };
}
