import {
  TAG_SIGHTING_AFTER_MS,
  TAG_SIGHTING_BEFORE_MS,
} from "@tracelog/capture-core";
import { tagSightingSchema, type TagSighting } from "@tracelog/event-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTagSightingPort,
  matchTagRequest,
  TAG_SIGHTING_MEMORY,
} from "./tag-sightings.js";

/**
 * The URLs the measurement recorded (plans/2026-09-21-the-tag-sighting.md
 * § What was measured), shortened to the parameters that carry meaning: the
 * rest — the page address, the vendor's client id, a timestamp — is exactly
 * what the matcher never keeps.
 */
const measured = {
  ga4Purchase:
    "https://region1.google-analytics.com/g/collect?v=2&tid=G-TL0MEASURE1&gtm=45je69g1h1za200xf1&_p=1789989378298&cid=1495803112.1789989379&ul=en-us&_s=2&en=purchase&dl=http%3A%2F%2Flocalhost%3A54615%2Fga4.html",
  ga4Batched:
    "https://region1.google-analytics.com/g/collect?v=2&tid=G-TL0MEASURE1&gtm=45je69g1h1za200xf1&_p=1789989378298&cid=1495803112.1789989379&ul=en-us&_s=3&dl=http%3A%2F%2Flocalhost%3A54615%2Fga4.html",
  metaPageView:
    "https://www.facebook.com/tr/?id=1234567890123456&ev=PageView&dl=http%3A%2F%2Flocalhost%3A54615%2Fmeta.html&rl=&if=false&ts=1789989361298&v=2.9.403&r=stable",
  metaPurchase:
    "https://www.facebook.com/tr/?id=1234567890123456&ev=Purchase&dl=http%3A%2F%2Flocalhost%3A54615%2Fmeta.html&rl=&if=false&ts=1789989361810&v=2.9.403&r=stable&cd[value]=129.5&cd[currency]=EUR",
  adsConversion:
    "https://www.googleadservices.com/pagead/conversion/1234567890/?random=1789989370416&cv=11&fst=1789989370416&fmt=7&en=conversion&url=http%3A%2F%2Flocalhost%3A54615%2Fads.html&rcb=3&label=AbC-D_efG",
  adsViewThrough:
    "https://googleads.g.doubleclick.net/pagead/viewthroughconversion/1234567890/?random=1376330714&cv=11&fmt=8&en=conversion&url=http%3A%2F%2Flocalhost%3A54615%2Fads.html&rcb=3&label=AbC-D_efG",
  adsFirstParty:
    "https://www.google.com/pagead/1p-conversion/1234567890/?random=1376330714&cv=11&fmt=8&en=conversion&url=http%3A%2F%2Flocalhost%3A54615%2Fads.html&rcb=3&label=AbC-D_efG&capi=1",
  adsFirstPartyEs:
    "https://www.google.es/pagead/1p-conversion/1234567890/?random=1376330714&cv=11&fmt=8&en=conversion&url=http%3A%2F%2Flocalhost%3A54615%2Fads.html&rcb=3&label=AbC-D_efG&capi=1",
  adsPageView:
    "https://www.google.com/ccm/collect?rcb=3&frm=0&apvc=1&auid=791904948.1789989370&tid=AW-1234567890&en=page_view&dl=http%3A%2F%2Flocalhost%3A54615%2Fads.html",
} as const;

const ga4: TagSighting = { kind: "ga4", id: "G-TL0MEASURE1", event: null };
const metaPageView: TagSighting = {
  kind: "meta",
  id: "1234567890123456",
  event: "PageView",
};
const metaPurchase: TagSighting = { ...metaPageView, event: "Purchase" };
const adsLabelled: TagSighting = {
  kind: "google_ads",
  id: "AW-1234567890/AbC-D_efG",
  event: null,
};

describe("the matching table", () => {
  it("matches GA4 on a regional host, with and without a named event, and keeps no event", () => {
    expect(matchTagRequest(measured.ga4Purchase)).toEqual(ga4);
    expect(matchTagRequest(measured.ga4Batched)).toEqual(ga4);
  });

  it("matches Meta's PageView and Purchase, keeping the event", () => {
    expect(matchTagRequest(measured.metaPageView)).toEqual(metaPageView);
    expect(matchTagRequest(measured.metaPurchase)).toEqual(metaPurchase);
    expect(
      matchTagRequest("https://facebook.com/tr?id=1234567890123456"),
    ).toEqual({ kind: "meta", id: "1234567890123456", event: null });
    expect(
      matchTagRequest(
        "https://www.facebook.com/tr/?id=1234567890123456&ev=Add%20To%20Cart",
      ),
    ).toEqual({ kind: "meta", id: "1234567890123456", event: null });
  });

  it("matches Google Ads on every host the measurement saw, with its conversion label", () => {
    for (const url of [
      measured.adsConversion,
      measured.adsViewThrough,
      measured.adsFirstParty,
      measured.adsFirstPartyEs,
    ]) {
      expect(matchTagRequest(url)).toEqual(adsLabelled);
    }
    expect(
      matchTagRequest(
        "https://www.googleadservices.com/pagead/conversion/1234567890/?en=conversion",
      ),
    ).toEqual({ kind: "google_ads", id: "AW-1234567890", event: null });
    expect(
      matchTagRequest(
        "https://www.googleadservices.com/pagead/conversion/1234567890/?label=not%20a%20label",
      ),
    ).toEqual({ kind: "google_ads", id: "AW-1234567890", event: null });
  });

  it("matches nothing else", () => {
    for (const url of [
      "https://region1.google-analytics.com/g/collect?v=2&en=purchase",
      "https://region1.google-analytics.com/g/collect?v=2&tid=UA-12345-1",
      "https://www.example.com/tr/?id=1234567890123456&ev=Purchase",
      "https://www.facebook.com/tr/?ev=Purchase",
      measured.adsPageView,
      "https://www.googleadservices.com/pagead/conversion/12345/",
      "not a url",
      "",
    ]) {
      expect(matchTagRequest(url), url).toBeNull();
    }
  });

  it("answers only what the contract accepts", () => {
    for (const url of Object.values(measured)) {
      const sighting = matchTagRequest(url);
      if (sighting !== null) {
        expect(tagSightingSchema.safeParse(sighting).success, url).toBe(true);
      }
    }
  });
});

interface FakeEntry {
  readonly name: string;
  readonly startTime: number;
}

/** `PerformanceObserver`, as far as the port reaches into it. */
class FakeObserver {
  static supportedEntryTypes: readonly string[] = ["resource"];
  static instances: FakeObserver[] = [];
  static failObserve = false;
  readonly observed: unknown[] = [];
  disconnected = false;

  constructor(
    private readonly callback: (list: { getEntries(): FakeEntry[] }) => void,
  ) {
    FakeObserver.instances.push(this);
  }

  observe(options: unknown): void {
    if (FakeObserver.failObserve) throw new TypeError("not supported");
    this.observed.push(options);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  takeRecords(): FakeEntry[] {
    return [];
  }

  deliver(...entries: FakeEntry[]): void {
    this.callback({ getEntries: () => entries });
  }
}

/**
 * One time domain: the system clock reads `NOW` and the page's monotonic clock
 * reads `PAGE_NOW`, so an entry that started at `PAGE_NOW - age` is placed at
 * `NOW - age`.
 */
const NOW = Date.parse("2026-09-21T12:00:00.000Z");
const PAGE_NOW = 120_000;

function entry(url: string, instant: number): FakeEntry {
  return { name: url, startTime: PAGE_NOW - (NOW - instant) };
}

describe("the port", () => {
  beforeEach(() => {
    FakeObserver.instances = [];
    FakeObserver.supportedEntryTypes = ["resource"];
    FakeObserver.failObserve = false;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.stubGlobal("performance", { now: () => PAGE_NOW });
    vi.stubGlobal("window", { PerformanceObserver: FakeObserver });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads no global before start", () => {
    const reads: PropertyKey[] = [];
    const watched = (target: object) =>
      new Proxy(target, {
        get(value, property, receiver) {
          reads.push(property);
          return Reflect.get(value, property, receiver) as unknown;
        },
      });
    vi.stubGlobal("window", watched({ PerformanceObserver: FakeObserver }));
    vi.stubGlobal("performance", watched({ now: () => PAGE_NOW }));

    const port = createTagSightingPort();
    expect(port.observing()).toBe(false);
    expect(port.around(new Date(NOW))).toBeNull();
    port.stop();
    expect(reads).toEqual([]);
    expect(FakeObserver.instances).toEqual([]);

    port.start();
    expect(reads).toContain("PerformanceObserver");
    expect(port.observing()).toBe(true);
  });

  it("observes resource entries, buffered, with one observer however often it is started", () => {
    const port = createTagSightingPort();
    port.start();
    port.start();

    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0]?.observed).toEqual([
      { type: "resource", buffered: true },
    ]);
  });

  it("is not observing, and answers null, where the page's requests cannot be read", () => {
    vi.stubGlobal("window", {});
    const absent = createTagSightingPort();
    absent.start();
    expect(absent.observing()).toBe(false);
    expect(absent.around(new Date(NOW))).toBeNull();

    vi.stubGlobal("window", { PerformanceObserver: FakeObserver });
    FakeObserver.supportedEntryTypes = ["mark", "measure"];
    const unsupported = createTagSightingPort();
    unsupported.start();
    expect(unsupported.observing()).toBe(false);
    expect(unsupported.around(new Date(NOW))).toBeNull();

    FakeObserver.supportedEntryTypes = ["resource"];
    FakeObserver.failObserve = true;
    const refused = createTagSightingPort();
    refused.start();
    expect(refused.observing()).toBe(false);
    expect(refused.around(new Date(NOW))).toBeNull();
  });

  it("answers the window's two edges and nothing past them", () => {
    const port = createTagSightingPort();
    port.start();
    const at = NOW - 20_000;
    const from = at - TAG_SIGHTING_BEFORE_MS;
    const to = at + TAG_SIGHTING_AFTER_MS;
    FakeObserver.instances[0]?.deliver(
      entry(measured.metaPageView, from - 1),
      entry(measured.ga4Purchase, from),
      entry(measured.metaPurchase, to),
      entry(measured.adsConversion, to + 1),
    );

    expect(port.around(new Date(at))).toEqual([ga4, metaPurchase]);
  });

  it("deduplicates by kind, id and event, in the order of each one's first request", () => {
    const port = createTagSightingPort();
    port.start();
    const at = NOW - 20_000;
    FakeObserver.instances[0]?.deliver(
      entry(measured.ga4Batched, at + 5_200),
      entry(measured.metaPageView, at - 10_000),
      entry(measured.metaPurchase, at + 50),
      entry(measured.ga4Purchase, at - 9_700),
      entry(measured.adsFirstParty, at + 300),
      entry(measured.adsViewThrough, at + 310),
      entry("https://www.example.com/app.js", at),
    );

    expect(port.around(new Date(at))).toEqual([
      metaPageView,
      ga4,
      metaPurchase,
      adsLabelled,
    ]);
  });

  it("answers null when its memory is full and no longer reaches back to the window's start", () => {
    const port = createTagSightingPort();
    port.start();
    const at = NOW - 20_000;
    const observer = FakeObserver.instances[0];
    for (let index = 0; index < TAG_SIGHTING_MEMORY; index += 1) {
      observer?.deliver(entry(measured.metaPurchase, at - 29_000 + index));
    }
    expect(port.around(new Date(at))).toBeNull();

    const reaching = createTagSightingPort();
    reaching.start();
    const second = FakeObserver.instances[1];
    second?.deliver(entry(measured.metaPageView, at - 31_000));
    for (let index = 1; index < TAG_SIGHTING_MEMORY; index += 1) {
      second?.deliver(entry(measured.metaPurchase, at - 29_000 + index));
    }
    expect(reaching.around(new Date(at))).toEqual([metaPurchase]);
  });

  it("forgets what it saw when stopped", () => {
    const port = createTagSightingPort();
    port.start();
    const at = NOW - 20_000;
    FakeObserver.instances[0]?.deliver(entry(measured.metaPurchase, at));
    port.stop();

    expect(FakeObserver.instances[0]?.disconnected).toBe(true);
    expect(port.observing()).toBe(false);
    expect(port.around(new Date(at))).toBeNull();

    port.start();
    expect(FakeObserver.instances).toHaveLength(2);
    expect(port.around(new Date(at))).toEqual([]);
  });
});
