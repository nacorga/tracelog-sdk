import {
  EVENT_ENVELOPE_VERSION,
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  MAX_CONTEXT_BYTES,
  MAX_ERROR_MESSAGE_BYTES,
  MAX_TAG_SIGHTINGS,
  TAG_SIGHTINGS_CONTEXT_KEY,
  type Event,
  type EventBatch,
  type EventContext,
  type TagSighting,
  type TagSightingKind,
  type TagSightingReport,
} from "@tracelog/event-contract";

export type {
  Event,
  EventBatch,
  TagSighting,
  TagSightingKind,
} from "@tracelog/event-contract";

/**
 * Time is injected, and this package never reads it: it runs inside sandboxes
 * with no ambient clock, so it declares the port and the caller supplies one.
 * `capture-web` supplies the browser's; a platform artifact supplies its
 * host's.
 */
export interface Clock {
  now(): Date;
}

const CONSENT_KEY = "__tl.c";
const SESSION_KEY = "__tl.s";
const ACTIVITY_KEY = "__tl.a";
const QUEUE_KEY = "__tl.q";
/** The namespace the runtime owns, in storage and in an event's context. */
const RUNTIME_KEY_PREFIX = "__tl.";
/**
 * How many events wait in memory before consent. A platform artifact that
 * buffers its own platform's events ahead of this engine holds the same line,
 * so the number is exported rather than mirrored.
 */
export const PRE_CONSENT_CAP = 100;
const QUEUE_CAP = 200;
const SESSION_INACTIVITY_MS = 30 * 60 * 1000;
const FLUSH_INTERVAL_MS = 5 * 1000;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 60 * 1000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_PROBE_MS = 60 * 1000;
const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const PUBLIC_KEY_PATTERN = /^tl_pk_[a-z2-7]{26}$/;
/**
 * The contract states these inside its schemas (`conversionEventSchema`,
 * `currencySchema`) and exports no constant for them; the schemas themselves
 * are not imported because zod is not part of the runtime a visitor loads.
 */
const MAX_IDENTIFIER_LENGTH = 256;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const textEncoder = new TextEncoder();

/**
 * The tag sighting window around a conversion ([spec/capture.md] § Tag
 * sightings). Ten seconds after is almost twice the longest hold measured:
 * GA4 was measured holding a purchase 5.0 to 5.6 seconds.
 */
export const TAG_SIGHTING_BEFORE_MS = 30_000;
export const TAG_SIGHTING_AFTER_MS = 10_000;

export interface TagSightingPort {
  /** Begin observing. Called once consent is granted; idempotent while started. */
  start(): void;
  /** Stop observing and forget what was seen; idempotent. */
  stop(): void;
  /** Whether the page's requests are being observed right now. */
  observing(): boolean;
  /**
   * Every tag the page requested from `TAG_SIGHTING_BEFORE_MS` before `at` to
   * `TAG_SIGHTING_AFTER_MS` after it, deduplicated by kind, id and event, in
   * the order of each one's first request in that window — the engine cuts it
   * to fit; null when it cannot answer, or its memory no longer reaches back
   * to the window's start.
   */
  around(at: Date): TagSighting[] | null;
  /**
   * Each kind the page requested from `TAG_SIGHTING_BEFORE_MS` before `at` to
   * `TAG_SIGHTING_AFTER_MS` after it whose tag the port could not read, once,
   * in `tagSightingKinds` order; null when `around` is, and when the port did
   * not watch that whole window. A port without it reports no `unread`, as
   * 1.1.0 did.
   */
  unreadAround?(at: Date): TagSightingKind[] | null;
}

export type ConsentState = "unknown" | "granted" | "denied";

export interface InitOptions {
  key: string;
  endpoint?: string;
}

export interface ConversionOptions {
  identifier: string;
  value?: number;
  currency?: string;
  context?: object;
}

export interface CaptureEngine {
  init(options: InitOptions): void;
  consent: {
    grant(): void;
    deny(): void;
    state(): ConsentState;
  };
  step(name: string, context?: object): void;
  conversion(name: string, options: ConversionOptions): void;
}

export interface CaptureStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TransportRequest {
  endpoint: string;
  key: string;
  batch: EventBatch;
  keepalive: boolean;
}

export interface TransportResponse {
  status: number;
  rejected?: number;
}

export interface CaptureTransport {
  send(request: TransportRequest): Promise<TransportResponse>;
}

export interface AcquisitionContext {
  referrer?: string;
  utm: {
    source?: string;
    medium?: string;
    campaign?: string;
    term?: string;
    content?: string;
  };
  landingPage: string;
  device: "desktop" | "mobile" | "tablet";
  mode?: "verification";
}

export interface CapturePorts {
  transport: CaptureTransport;
  storage: CaptureStorage;
  clock: Clock;
  /** Absent where the host cannot see the page's requests: nothing is held. */
  sightings?: TagSightingPort;
}

export interface DropCount {
  reason: "queue_overflow" | "server_rejected" | "invalid_event";
  count: number;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface CaptureRuntime {
  engine: CaptureEngine;
  flush(keepalive?: boolean): Promise<void>;
  captureError(message: string): void;
  drops(): DropCount[];
  circuitState(): CircuitState;
}

type PendingEvent =
  | { kind: "step"; name: string; context?: object }
  | { kind: "conversion"; name: string; options: ConversionOptions };

interface StoredQueue {
  events: Event[];
  drops: Partial<Record<DropCount["reason"], number>>;
}

function safeGet(storage: CaptureStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(storage: CaptureStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    // Capture must never break the host page when storage is unavailable.
  }
}

function safeRemove(storage: CaptureStorage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Capture must never break the host page when storage is unavailable.
  }
}

function emptyQueue(): StoredQueue {
  return { events: [], drops: {} };
}

function readQueue(storage: CaptureStorage): StoredQueue {
  const serialized = safeGet(storage, QUEUE_KEY);
  if (serialized === null) return emptyQueue();

  try {
    const value = JSON.parse(serialized) as unknown;
    if (typeof value !== "object" || value === null) return emptyQueue();
    const candidate = value as Partial<StoredQueue>;
    if (!Array.isArray(candidate.events)) return emptyQueue();
    return {
      events: candidate.events as Event[],
      drops:
        typeof candidate.drops === "object" && candidate.drops !== null
          ? candidate.drops
          : {},
    };
  } catch {
    return emptyQueue();
  }
}

function writeQueue(storage: CaptureStorage, queue: StoredQueue): void {
  safeSet(storage, QUEUE_KEY, JSON.stringify(queue));
}

function addDrop(
  queue: StoredQueue,
  reason: DropCount["reason"],
  count = 1,
): void {
  queue.drops[reason] = (queue.drops[reason] ?? 0) + count;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const cryptoSource = (
    globalThis as typeof globalThis & {
      crypto?: { getRandomValues<T extends ArrayBufferView>(array: T): T };
    }
  ).crypto;

  if (cryptoSource !== undefined) return cryptoSource.getRandomValues(bytes);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

function uuidv7(at: Date): string {
  const bytes = randomBytes(16);
  let timestamp = at.getTime();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function jsonContext(value: object | undefined): EventContext | undefined {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (textEncoder.encode(serialized).byteLength > MAX_CONTEXT_BYTES)
      return undefined;
    const parsed = JSON.parse(serialized) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const context = parsed as EventContext;
    for (const key of Object.keys(context)) {
      if (key.startsWith(RUNTIME_KEY_PREFIX)) delete context[key];
    }
    return context;
  } catch {
    return undefined;
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (textEncoder.encode(value).byteLength <= maxBytes) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (textEncoder.encode(value.slice(0, middle)).byteLength <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function isConversionValid(options: ConversionOptions): boolean {
  return (
    options.identifier.length >= 1 &&
    options.identifier.length <= MAX_IDENTIFIER_LENGTH &&
    (options.value === undefined ||
      (Number.isFinite(options.value) && options.value >= 0)) &&
    (options.currency === undefined || CURRENCY_PATTERN.test(options.currency))
  );
}

function serializedBytes(value: unknown): number {
  return textEncoder.encode(JSON.stringify(value)).byteLength;
}

interface BatchSelection {
  batch: EventBatch;
  /**
   * Events that exceed the batch budget on their own. No batch can ever carry
   * one, so leaving it at the head of the queue would hold every event behind
   * it until overflow shifted it out — silently, and for as long as it took.
   * The caller drops them as `invalid_event`, which is what they are.
   */
  unsendable: Event[];
}

function batchFrom(events: Event[]): BatchSelection {
  const selected: Event[] = [];
  const unsendable: Event[] = [];
  for (const event of events) {
    if (selected.length >= MAX_BATCH_EVENTS) break;
    const candidate: EventBatch = {
      v: EVENT_ENVELOPE_VERSION,
      events: [...selected, event],
    };
    if (serializedBytes(candidate) > MAX_BATCH_BYTES) {
      if (selected.length === 0) {
        unsendable.push(event);
        continue;
      }
      break;
    }
    selected.push(event);
  }
  return { batch: { v: EVENT_ENVELOPE_VERSION, events: selected }, unsendable };
}

export function createCaptureEngine(
  ports: CapturePorts,
  acquisition: AcquisitionContext,
): CaptureRuntime {
  let consentState: ConsentState = "unknown";
  let initialized = false;
  let config: Required<InitOptions> = { key: "", endpoint: "/v1/events" };
  let pending: PendingEvent[] = [];
  let lastDeclaredName: string | undefined;
  /**
   * Every send in flight, by count and by the union of their event ids: a
   * page hide sends alongside one rather than wait for it, so there can be
   * two, and each must leave the other's events alone.
   */
  let sendsInFlight = 0;
  const inFlight = new Set<string>();
  /**
   * The conversions this page emitted and holds for their tag sighting
   * window: the instant each was emitted, and whether its report can be
   * complete. In memory only — a held conversion is in the stored queue like
   * any other, and a reload sends it as it is.
   */
  const held = new Map<string, { at: number; whole: boolean }>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let circuit: CircuitState = "closed";
  let nextProbeAt = 0;

  function scheduleFlush(delay: number): void {
    if (flushTimer !== undefined) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      void flush(false);
    }, delay);
  }

  function persistEvent(event: Event): void {
    const queue = readQueue(ports.storage);
    queue.events.push(event);
    while (queue.events.length > QUEUE_CAP) {
      queue.events.shift();
      addDrop(queue, "queue_overflow");
    }
    writeQueue(ports.storage, queue);
  }

  function sessionFor(now: Date): { id: string; started: boolean } {
    const storedId = safeGet(ports.storage, SESSION_KEY);
    const activityValue = safeGet(ports.storage, ACTIVITY_KEY);
    const lastActivity =
      activityValue === null ? Number.NaN : Number(activityValue);
    const rotated =
      storedId === null ||
      !Number.isFinite(lastActivity) ||
      now.getTime() - lastActivity >= SESSION_INACTIVITY_MS;
    const id = rotated ? uuidv7(now) : storedId;

    if (rotated) safeSet(ports.storage, SESSION_KEY, id);
    safeSet(ports.storage, ACTIVITY_KEY, String(now.getTime()));
    return { id, started: rotated };
  }

  function baseEvent(now: Date, sessionId: string) {
    return {
      eventId: uuidv7(now),
      sessionId,
      occurredAt: now.toISOString(),
      ...(acquisition.mode === undefined ? {} : { mode: acquisition.mode }),
    };
  }

  function recordInvalidEvent(): void {
    const queue = readQueue(ports.storage);
    addDrop(queue, "invalid_event");
    writeQueue(ports.storage, queue);
  }

  /**
   * `buffered` is a conversion made before consent was granted and emitted
   * at the grant: its window is placed there, after the conversion itself,
   * so its report is never complete.
   */
  function emit(pendingEvent: PendingEvent, buffered = false): void {
    if (!EVENT_NAME_PATTERN.test(pendingEvent.name)) {
      recordInvalidEvent();
      return;
    }
    if (
      pendingEvent.kind === "conversion" &&
      !isConversionValid(pendingEvent.options)
    ) {
      recordInvalidEvent();
      return;
    }

    const now = ports.clock.now();
    const session = sessionFor(now);
    if (session.started) {
      persistEvent({
        ...baseEvent(now, session.id),
        kind: "session_start",
        name: "session_started",
        ...(acquisition.referrer === undefined
          ? {}
          : { referrer: acquisition.referrer }),
        utm: acquisition.utm,
        landingPage: acquisition.landingPage,
        device: acquisition.device,
      });
    }

    if (pendingEvent.kind === "step") {
      const context = jsonContext(pendingEvent.context);
      persistEvent({
        ...baseEvent(now, session.id),
        kind: "step",
        name: pendingEvent.name,
        ...(context === undefined ? {} : { context }),
      });
    } else {
      const options = pendingEvent.options;
      const context = jsonContext(options.context);
      const base = baseEvent(now, session.id);
      if (
        acquisition.mode !== "verification" &&
        ports.sightings?.observing() === true
      ) {
        held.set(base.eventId, { at: now.getTime(), whole: !buffered });
      }
      persistEvent({
        ...base,
        kind: "conversion",
        name: pendingEvent.name,
        identifier: options.identifier,
        ...(options.value === undefined ? {} : { value: options.value }),
        ...(options.currency === undefined
          ? {}
          : { currency: options.currency }),
        ...(context === undefined ? {} : { context }),
      });
    }

    lastDeclaredName = pendingEvent.name;
  }

  function capture(pendingEvent: PendingEvent): void {
    if (!initialized || consentState === "denied") return;
    if (consentState === "unknown") {
      if (pending.length < PRE_CONSENT_CAP) pending.push(pendingEvent);
      return;
    }
    emit(pendingEvent);
  }

  /**
   * Gives each held conversion whose window has closed — or every one, at
   * page hide — the report of what the port saw around it, and lets it go.
   */
  function release(all: boolean): void {
    if (held.size === 0) return;
    const now = ports.clock.now().getTime();
    const due = [...held].filter(
      ([, hold]) => all || now - hold.at >= TAG_SIGHTING_AFTER_MS,
    );
    if (due.length === 0) return;

    const queue = readQueue(ports.storage);
    let reported = false;
    for (const [eventId, hold] of due) {
      held.delete(eventId);
      // Gone from the queue — sent by another tab, or dropped by overflow.
      const event = queue.events.find(
        (candidate) => candidate.eventId === eventId,
      );
      const answer =
        event === undefined
          ? null
          : (ports.sightings?.around(new Date(hold.at)) ?? null);
      if (event === undefined || answer === null) continue;
      const unread = ports.sightings?.unreadAround?.(new Date(hold.at)) ?? null;
      const report = {
        complete:
          hold.whole &&
          now - hold.at >= TAG_SIGHTING_AFTER_MS &&
          answer.length <= MAX_TAG_SIGHTINGS,
        sightings: answer.slice(0, MAX_TAG_SIGHTINGS),
        ...(unread === null ? {} : { unread }),
      } satisfies TagSightingReport;
      const context = {
        ...event.context,
        [TAG_SIGHTINGS_CONTEXT_KEY]: report,
      };
      if (serializedBytes(context) <= MAX_CONTEXT_BYTES) {
        event.context = context;
        reported = true;
      }
    }
    if (reported) writeQueue(ports.storage, queue);
  }

  /** Until the earliest held conversion's window closes. */
  function untilRelease(): number {
    const now = ports.clock.now().getTime();
    let earliest = Number.POSITIVE_INFINITY;
    for (const hold of held.values()) {
      earliest = Math.min(earliest, hold.at + TAG_SIGHTING_AFTER_MS);
    }
    return Math.max(0, earliest - now);
  }

  async function flush(keepalive = false): Promise<void> {
    release(keepalive);
    if (!initialized || consentState !== "granted") return;
    if (sendsInFlight > 0 && !keepalive) return;

    const queue = readQueue(ports.storage);
    const ready = queue.events.filter(
      (event) => !held.has(event.eventId) && !inFlight.has(event.eventId),
    );
    if (ready.length === 0 || !PUBLIC_KEY_PATTERN.test(config.key)) {
      if (sendsInFlight === 0) {
        scheduleFlush(
          ready.length === 0 && held.size > 0
            ? untilRelease()
            : FLUSH_INTERVAL_MS,
        );
      }
      return;
    }

    /**
     * A page being hidden gets no later chance, so it sends what no send in
     * flight carries at once, whatever the circuit's state, and the answer is
     * read as any other's.
     */
    if (sendsInFlight > 0) {
      const { batch } = batchFrom(ready);
      if (batch.events.length > 0) await deliver(batch, true);
      return;
    }

    const now = ports.clock.now().getTime();
    if (circuit === "open") {
      if (now < nextProbeAt) {
        scheduleFlush(nextProbeAt - now);
        return;
      }
      circuit = "half_open";
    }

    const { batch, unsendable } = batchFrom(ready);
    if (unsendable.length > 0) {
      const dropped = new Set(unsendable.map((event) => event.eventId));
      queue.events = queue.events.filter(
        (event) => !dropped.has(event.eventId),
      );
      addDrop(queue, "invalid_event", unsendable.length);
      writeQueue(ports.storage, queue);
    }
    if (batch.events.length === 0) {
      scheduleFlush(FLUSH_INTERVAL_MS);
      return;
    }

    await deliver(batch, keepalive);
  }

  /**
   * One send, and its answer. It removes from the stored queue exactly what
   * it carried, by its own read, filter and write at the moment it settles,
   * so a send beside it keeps what it delivered.
   */
  async function deliver(batch: EventBatch, keepalive: boolean): Promise<void> {
    const carried = new Set(batch.events.map((event) => event.eventId));
    for (const eventId of carried) inFlight.add(eventId);
    sendsInFlight += 1;
    try {
      const response = await ports.transport.send({
        endpoint: config.endpoint,
        key: config.key,
        batch,
        keepalive,
      });

      if (response.status >= 200 && response.status < 300) {
        const currentQueue = readQueue(ports.storage);
        currentQueue.events = currentQueue.events.filter(
          (event) => !carried.has(event.eventId),
        );
        if ((response.rejected ?? 0) > 0) {
          addDrop(currentQueue, "server_rejected", response.rejected);
        }
        writeQueue(ports.storage, currentQueue);
        consecutiveFailures = 0;
        circuit = "closed";
        scheduleFlush(currentQueue.events.length === 0 ? FLUSH_INTERVAL_MS : 0);
        return;
      }

      /**
       * A 4xx is the server's word that this batch will never be accepted —
       * except a 429, which is the server's word that it will be accepted
       * later: the ingestion limit is per public key, shared by every visitor
       * of one site, so a busy minute answers 429 to visitors whose events
       * are sound. Dropping those is silent loss ([spec/capture.md]
       * § Delivery); they take the retry path with everything else transient.
       */
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        const currentQueue = readQueue(ports.storage);
        currentQueue.events = currentQueue.events.filter(
          (event) => !carried.has(event.eventId),
        );
        addDrop(currentQueue, "server_rejected", batch.events.length);
        writeQueue(ports.storage, currentQueue);
        consecutiveFailures = 0;
        circuit = "closed";
        scheduleFlush(currentQueue.events.length === 0 ? FLUSH_INTERVAL_MS : 0);
        return;
      }

      throw new Error("retryable response");
    } catch {
      consecutiveFailures += 1;
      if (
        circuit === "half_open" ||
        consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD
      ) {
        circuit = "open";
        nextProbeAt = ports.clock.now().getTime() + CIRCUIT_PROBE_MS;
        scheduleFlush(CIRCUIT_PROBE_MS);
      } else {
        scheduleFlush(
          Math.min(
            RETRY_BASE_MS * 2 ** (consecutiveFailures - 1),
            RETRY_CAP_MS,
          ),
        );
      }
    } finally {
      for (const eventId of carried) inFlight.delete(eventId);
      sendsInFlight -= 1;
    }
  }

  const engine: CaptureEngine = {
    init(options) {
      config = {
        key: options.key,
        endpoint: options.endpoint ?? "/v1/events",
      };
      initialized = true;
      const storedConsent = safeGet(ports.storage, CONSENT_KEY);
      consentState =
        storedConsent === "granted" || storedConsent === "denied"
          ? storedConsent
          : "unknown";
      if (consentState === "granted") {
        ports.sightings?.start();
        scheduleFlush(FLUSH_INTERVAL_MS);
      }
    },
    consent: {
      grant() {
        if (!initialized) return;
        consentState = "granted";
        safeSet(ports.storage, CONSENT_KEY, "granted");
        ports.sightings?.start();
        const buffered = pending;
        pending = [];
        for (const pendingEvent of buffered) emit(pendingEvent, true);
        scheduleFlush(FLUSH_INTERVAL_MS);
      },
      deny() {
        if (!initialized) return;
        consentState = "denied";
        pending = [];
        lastDeclaredName = undefined;
        ports.sightings?.stop();
        held.clear();
        safeSet(ports.storage, CONSENT_KEY, "denied");
        safeRemove(ports.storage, SESSION_KEY);
        safeRemove(ports.storage, ACTIVITY_KEY);
        safeRemove(ports.storage, QUEUE_KEY);
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
      },
      state() {
        return consentState;
      },
    },
    step(name, context) {
      capture({
        kind: "step",
        name,
        ...(context === undefined ? {} : { context }),
      });
    },
    conversion(name, options) {
      capture({ kind: "conversion", name, options });
    },
  };

  return {
    engine,
    flush,
    captureError(message) {
      if (
        !initialized ||
        consentState !== "granted" ||
        lastDeclaredName === undefined
      ) {
        return;
      }
      const now = ports.clock.now();
      const session = sessionFor(now);
      if (session.started) {
        persistEvent({
          ...baseEvent(now, session.id),
          kind: "session_start",
          name: "session_started",
          ...(acquisition.referrer === undefined
            ? {}
            : { referrer: acquisition.referrer }),
          utm: acquisition.utm,
          landingPage: acquisition.landingPage,
          device: acquisition.device,
        });
      }
      persistEvent({
        ...baseEvent(now, session.id),
        kind: "error",
        name: "capture_error",
        message: truncateUtf8(message, MAX_ERROR_MESSAGE_BYTES),
        stepName: lastDeclaredName,
      });
    },
    drops() {
      const queue = readQueue(ports.storage);
      return (["queue_overflow", "server_rejected", "invalid_event"] as const)
        .map((reason) => ({ reason, count: queue.drops[reason] ?? 0 }))
        .filter((drop) => drop.count > 0);
    },
    circuitState() {
      return circuit;
    },
  };
}
