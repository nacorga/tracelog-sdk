import {
  TAG_SIGHTING_AFTER_MS,
  TAG_SIGHTING_BEFORE_MS,
  type TagSighting,
  type TagSightingKind,
  type TagSightingPort,
} from "@tracelog/capture-core";
import {
  TAG_EVENT_PATTERN,
  TAG_ID_PATTERNS,
  tagSightingKinds,
} from "@tracelog/event-contract";

import { instantOfEntry, systemClock } from "./clock.js";

/**
 * How many matches the port keeps. A page making more tag requests than this
 * inside one window is one whose report the port declines to give, never one
 * it gives short.
 */
export const TAG_SIGHTING_MEMORY = 100;

/**
 * What either reader answers: a tag it sighted, or a request of a kind it saw
 * and could not read — which keeps its kind alone ([spec/capture.md] § Tag
 * sightings, _What is kept_).
 */
export type TagMatch =
  { readonly sighting: TagSighting } | { readonly unread: TagSightingKind };

/** A form, as far as the reader reaches into it: its action and two fields. */
export interface TagForm {
  readonly action: string;
  querySelector(selectors: string): { readonly value: string } | null;
}

const ga4IdPattern = new RegExp(TAG_ID_PATTERNS.ga4);
const metaIdPattern = new RegExp(TAG_ID_PATTERNS.meta);
const adsIdPattern = new RegExp(TAG_ID_PATTERNS.google_ads);
const tagEventPattern = new RegExp(TAG_EVENT_PATTERN);
const adsPathPattern =
  /^\/pagead\/(?:conversion|viewthroughconversion|1p-conversion)\/([0-9]{6,15})\/$/;

function onMetaEndpoint(url: URL): boolean {
  const host = url.hostname;
  return (
    (host === "facebook.com" || host.endsWith(".facebook.com")) &&
    (url.pathname === "/tr" || url.pathname === "/tr/")
  );
}

/** A request on Meta's endpoint whose pixel id does not fit is Meta, unread. */
function metaMatch(id: string | null, event: string | null): TagMatch {
  return id !== null && metaIdPattern.test(id)
    ? {
        sighting: {
          kind: "meta",
          id,
          event: event !== null && tagEventPattern.test(event) ? event : null,
        },
      }
    : { unread: "meta" };
}

/**
 * The matching table ([spec/capture.md] § Tag sightings): GA4 and Google Ads
 * key on the path and the id, so a regional host and a first-party tagging
 * domain that keeps the path both match; Meta keys on its host as well. What
 * is answered is the tag's kind, its id and Meta's event — nothing else of
 * the URL, which carries the page address and the vendor's client id. Meta's
 * beacon leaves an entry named by its bare endpoint, which names no pixel:
 * that is Meta, unread.
 */
export function matchTagRequest(url: string): TagMatch | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname;
  const parameters = parsed.searchParams;

  if (path.endsWith("/g/collect")) {
    const id = parameters.get("tid");
    return id !== null && ga4IdPattern.test(id)
      ? { sighting: { kind: "ga4", id, event: null } }
      : null;
  }

  if (onMetaEndpoint(parsed)) {
    return metaMatch(parameters.get("id"), parameters.get("ev"));
  }

  const ads = adsPathPattern.exec(path);
  if (ads !== null) {
    const id = `AW-${ads[1]}`;
    const labelled = `${id}/${parameters.get("label") ?? ""}`;
    return {
      sighting: {
        kind: "google_ads",
        id: adsIdPattern.test(labelled) ? labelled : id,
        event: null,
      },
    };
  }
  return null;
}

/**
 * Meta's long request in Chrome: a form posted into a hidden frame, which
 * leaves no Resource Timing entry ([spec/capture.md] § Tag sightings, _Meta's
 * long request_). Two fields are asked for, the ones that name the pixel and
 * the event, and nothing else of the form is read: its other fields carry the
 * visitor's identifiers, hashed.
 */
export function matchTagForm(form: TagForm): TagMatch | null {
  let action: URL;
  try {
    action = new URL(form.action);
  } catch {
    return null;
  }
  if (!onMetaEndpoint(action)) return null;
  const id = form.querySelector('input[name="id"]');
  const event = form.querySelector('input[name="ev"]');
  return metaMatch(id?.value ?? null, event?.value ?? null);
}

interface Stamped {
  readonly match: TagMatch;
  /** When the request started, on the system clock, in milliseconds. */
  readonly at: number;
}

/**
 * The browser's own record of the page's requests, read through a buffered
 * `PerformanceObserver` once consent is granted and never before — and, for
 * the one request that record leaves out, the forms the page's body gains,
 * read through a `MutationObserver` on the body's own children. Nothing is
 * wrapped, patched or replaced — no `fetch`, no beacon, no vendor's global —
 * because the runtime runs on somebody else's page and nothing it does may
 * change what another script sees.
 */
export function createTagSightingPort(): TagSightingPort {
  let observer: PerformanceObserver | undefined;
  let bodyObserver: MutationObserver | undefined;
  /**
   * From when the body's children were watched, on the system clock: minus
   * infinity when observation began before the body existed, and so saw every
   * form a script added to it; undefined while no body observer runs — never
   * created, still waiting for the body, or failed.
   */
  let watchedFrom: number | undefined;
  /** Ordered by `at`, oldest first; at most `TAG_SIGHTING_MEMORY`. */
  let matches: Stamped[] = [];

  function remember(match: TagMatch | null, at: number): void {
    if (match === null) return;
    let index = matches.length;
    while (index > 0 && matches[index - 1]!.at > at) index -= 1;
    matches.splice(index, 0, { match, at });
    if (matches.length > TAG_SIGHTING_MEMORY) matches.shift();
  }

  function record(entries: readonly PerformanceEntry[]): void {
    for (const entry of entries) {
      remember(
        matchTagRequest(entry.name),
        instantOfEntry(entry.startTime).getTime(),
      );
    }
  }

  /**
   * One observer, on the body's children and nothing below them. Before the
   * body exists it watches the root's children for the body, and moves to it.
   */
  function watchBody(): void {
    try {
      const document = window.document;
      let body: Node | null = document.body;
      const created = new window.MutationObserver((records) => {
        try {
          for (const change of records) {
            const added = change.addedNodes;
            for (let index = 0; index < added.length; index += 1) {
              const node = added[index]!;
              if (change.target === body) {
                if (node.nodeName === "FORM") {
                  remember(
                    matchTagForm(node as HTMLFormElement),
                    systemClock.now().getTime(),
                  );
                }
              } else if (body === null && node.nodeName === "BODY") {
                body = node;
                created.disconnect();
                created.observe(node, { childList: true });
                watchedFrom = Number.NEGATIVE_INFINITY;
              }
            }
          }
        } catch {
          // Capture must never break the host page.
        }
      });
      if (body === null) {
        created.observe(document.documentElement, { childList: true });
      } else {
        created.observe(body, { childList: true });
        watchedFrom = systemClock.now().getTime();
      }
      bodyObserver = created;
    } catch {
      watchedFrom = undefined;
    }
  }

  /** What was matched inside the window around `at`, or null. */
  function within(at: Date): TagMatch[] | null {
    if (observer === undefined) return null;
    // What the browser recorded and has not delivered yet: a page being
    // hidden may not run the callback before the conversion leaves.
    record(observer.takeRecords());
    const from = at.getTime() - TAG_SIGHTING_BEFORE_MS;
    const to = at.getTime() + TAG_SIGHTING_AFTER_MS;
    if (matches.length >= TAG_SIGHTING_MEMORY && matches[0]!.at > from) {
      return null;
    }
    return matches
      .filter(({ at: started }) => started >= from && started <= to)
      .map(({ match }) => match);
  }

  return {
    start() {
      if (observer !== undefined) return;
      try {
        const Observer = window.PerformanceObserver;
        if (
          Observer === undefined ||
          !Observer.supportedEntryTypes.includes("resource")
        ) {
          return;
        }
        const created = new Observer((list) => record(list.getEntries()));
        created.observe({ type: "resource", buffered: true });
        observer = created;
      } catch {
        observer = undefined;
        return;
      }
      watchBody();
    },
    stop() {
      observer?.disconnect();
      observer = undefined;
      bodyObserver?.disconnect();
      bodyObserver = undefined;
      watchedFrom = undefined;
      matches = [];
    },
    observing() {
      return observer !== undefined;
    },
    around(at) {
      const found = within(at);
      if (found === null) return null;
      const seen = new Set<string>();
      const sightings: TagSighting[] = [];
      for (const match of found) {
        if (!("sighting" in match)) continue;
        const { sighting } = match;
        const key = `${sighting.kind} ${sighting.id} ${sighting.event ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sightings.push(sighting);
      }
      return sightings;
    },
    unreadAround(at) {
      const found = within(at);
      if (
        found === null ||
        watchedFrom === undefined ||
        watchedFrom > at.getTime() - TAG_SIGHTING_BEFORE_MS
      ) {
        return null;
      }
      return tagSightingKinds.filter((kind) =>
        found.some((match) => "unread" in match && match.unread === kind),
      );
    },
  };
}
