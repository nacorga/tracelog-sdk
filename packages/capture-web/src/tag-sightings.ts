import {
  TAG_SIGHTING_AFTER_MS,
  TAG_SIGHTING_BEFORE_MS,
  type TagSighting,
  type TagSightingPort,
} from "@tracelog/capture-core";
import { TAG_EVENT_PATTERN, TAG_ID_PATTERNS } from "@tracelog/event-contract";

import { instantOfEntry } from "./clock.js";

/**
 * How many matches the port keeps. A page making more tag requests than this
 * inside one window is one whose report the port declines to give, never one
 * it gives short.
 */
export const TAG_SIGHTING_MEMORY = 100;

const ga4IdPattern = new RegExp(TAG_ID_PATTERNS.ga4);
const metaIdPattern = new RegExp(TAG_ID_PATTERNS.meta);
const adsIdPattern = new RegExp(TAG_ID_PATTERNS.google_ads);
const tagEventPattern = new RegExp(TAG_EVENT_PATTERN);
const adsPathPattern =
  /^\/pagead\/(?:conversion|viewthroughconversion|1p-conversion)\/([0-9]{6,15})\/$/;

/**
 * The matching table ([spec/capture.md] § Tag sightings): GA4 and Google Ads
 * key on the path and the id, so a regional host and a first-party tagging
 * domain that keeps the path both match; Meta keys on its host as well. What
 * is answered is the tag's kind, its id and Meta's event — nothing else of
 * the URL, which carries the page address and the vendor's client id.
 */
export function matchTagRequest(url: string): TagSighting | null {
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
      ? { kind: "ga4", id, event: null }
      : null;
  }

  const host = parsed.hostname;
  if (
    (host === "facebook.com" || host.endsWith(".facebook.com")) &&
    (path === "/tr" || path === "/tr/")
  ) {
    const id = parameters.get("id");
    if (id === null || !metaIdPattern.test(id)) return null;
    const event = parameters.get("ev");
    return {
      kind: "meta",
      id,
      event: event !== null && tagEventPattern.test(event) ? event : null,
    };
  }

  const ads = adsPathPattern.exec(path);
  if (ads !== null) {
    const id = `AW-${ads[1]}`;
    const labelled = `${id}/${parameters.get("label") ?? ""}`;
    return {
      kind: "google_ads",
      id: adsIdPattern.test(labelled) ? labelled : id,
      event: null,
    };
  }
  return null;
}

interface Match {
  readonly sighting: TagSighting;
  /** When the request started, on the system clock, in milliseconds. */
  readonly at: number;
}

/**
 * The browser's own record of the page's requests, read through a buffered
 * `PerformanceObserver` once consent is granted and never before. Nothing is
 * wrapped, patched or replaced — no `fetch`, no beacon, no vendor's global —
 * because the runtime runs on somebody else's page and nothing it does may
 * change what another script sees.
 */
export function createTagSightingPort(): TagSightingPort {
  let observer: PerformanceObserver | undefined;
  /** Ordered by `at`, oldest first; at most `TAG_SIGHTING_MEMORY`. */
  let matches: Match[] = [];

  function record(entries: readonly PerformanceEntry[]): void {
    for (const entry of entries) {
      const sighting = matchTagRequest(entry.name);
      if (sighting === null) continue;
      const match = { sighting, at: instantOfEntry(entry.startTime).getTime() };
      let index = matches.length;
      while (index > 0 && matches[index - 1]!.at > match.at) index -= 1;
      matches.splice(index, 0, match);
      if (matches.length > TAG_SIGHTING_MEMORY) matches.shift();
    }
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
      }
    },
    stop() {
      observer?.disconnect();
      observer = undefined;
      matches = [];
    },
    observing() {
      return observer !== undefined;
    },
    around(at) {
      if (observer === undefined) return null;
      // What the browser recorded and has not delivered yet: a page being
      // hidden may not run the callback before the conversion leaves.
      record(observer.takeRecords());
      const from = at.getTime() - TAG_SIGHTING_BEFORE_MS;
      const to = at.getTime() + TAG_SIGHTING_AFTER_MS;
      if (matches.length >= TAG_SIGHTING_MEMORY && matches[0]!.at > from) {
        return null;
      }
      const seen = new Set<string>();
      const sightings: TagSighting[] = [];
      for (const { sighting, at: started } of matches) {
        if (started < from || started > to) continue;
        const key = `${sighting.kind} ${sighting.id} ${sighting.event ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        sightings.push(sighting);
      }
      return sightings;
    },
  };
}
