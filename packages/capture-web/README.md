# @tracelog/capture-web

The TraceLog browser capture runtime. It captures the conversion path a project
declares — each conversion and the steps preceding it — and, beside each
conversion, which GA4, Meta and Google Ads tags the page requested; nothing
else.

TraceLog is Trustworthy Conversion Intelligence — conversion intelligence you
can verify: it verifies the conversion path a project declares against the
events TraceLog receives, watches every declared step every day, alerts when
events for one stop arriving and names the TraceLog figures that are
incomplete, and never makes up a number.
<https://tracelog.io>

## Install

**Every integration names a version, exactly.** Install with `--save-exact`,
so your manifest names this version rather than a range, and there is no
`v/latest/` on the CDN: the version you pin is the bytes you get, for as long
as they are served.

<!-- x-release-please-start-version -->

```bash
npm install --save-exact @tracelog/capture-web@2.0.1
```

Without a build step, the same runtime as a script tag:

```html
<script src="https://cdn.tracelog.io/v/2.0.1/tracelog.js"></script>
```

<!-- x-release-please-end -->

One runtime, two forms: ESM with types for npm, and an IIFE on
`globalThis.TraceLog` for the script tag. Both are exercised on every browser of
the floor before a release.

## Consent first

Before consent is granted the runtime creates no identifiers, writes no storage,
and sends no network traffic — none, not a reduced set. Consent is a state
machine you drive; until it reaches `granted`, capture is inert. Denying keeps it
inert without breaking the page, and is remembered; a grant is not.

```js
import TraceLog from "@tracelog/capture-web";

TraceLog.init({
  key: "tl_pk_…",
  endpoint: "https://api.tracelog.io/v1/events",
});

// When your consent surface says yes, and on every later load while
// that consent stands:
TraceLog.consent.grant();
```

A grant lasts the page it was given on. Your consent surface keeps the
visitor's answer and its expiry, so call `grant()` on each load where that
answer is still yes; a grant that outlived it would capture a visitor whose
consent has lapsed.

A site that never calls `consent.grant()` captures nothing and costs its
visitors nothing.

## The surface

That is all of it, and it is what the major version protects.

| Call                                   | Does                                                                                                                                           |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `TraceLog.init(options)`               | Configures the runtime. `key` is the project's public key.                                                                                     |
| `TraceLog.consent.grant()`             | Allows capture. Queued delivery begins.                                                                                                        |
| `TraceLog.consent.deny()`              | Keeps the runtime inert.                                                                                                                       |
| `TraceLog.consent.state()`             | `"unknown" \| "granted" \| "denied"`.                                                                                                          |
| `TraceLog.step(name, context?, opts?)` | A declared step of the conversion path. `opts.items` are the items it shows.                                                                   |
| `TraceLog.conversion(name, opts)`      | A declared conversion. `opts.identifier` is its stable identifier. `opts.items`, `opts.scheduledFor` and `opts.recurring` say what it was for. |

`init` also accepts `mode: "verification"`, which a distributed platform artifact
declares for its platform's own test order. A site's own snippet never sets it —
the runtime derives verification mode from the window that opened the page, and
once consent is granted there the tab keeps it (`sessionStorage`, `__tl.v`) for
the site's next pages and the return from a payment taken elsewhere, to the same
origin. A denial forgets it.

Call `init` once per page load. The runtime is built on the first call and
kept; a later call re-reads the key and the endpoint and rebuilds nothing else,
so a mode or an acquisition the first call decided stands for the page. A
call made before it — a grant, a step, a conversion — is held, up to 100, and
made once it has run. The runtime can hold only what reaches it: a page that
imports it lazily holds what it calls before the import resolves.

The application generates the exact calls your declared plan needs, so you never
type a name TraceLog already knows.

## What it captures

The events your tracking plan declares, with their context. Not page views, not
clicks, not scroll, not keystrokes. Errors are captured only when they occur
inside the conversion path, attached to the step where they happened.

A conversion may carry its items, the day a booking is for and whether it
recurs, and a step the items it shows; a malformed one is left out and the
event sent without it.

Beside each conversion, which GA4, Meta and Google Ads tags the page requested
just before and after it — the tag's kind, its id and, for Meta, the event —
read from the browser's own record of the page's requests and, for the one
Meta request that record leaves out, from the two fields of the form Meta's
script adds to the page that name the pixel and the event. Nothing else of
those requests is kept. A Meta request whose pixel the page does not show is
reported as Meta, unread. A conversion is held ten seconds so those requests can
be seen, sent at once when the page is hidden — its report then says whether it
was cut short — and never held in verification mode. Context keys beginning
with `__tl.` are TraceLog's and are removed.

Identity is first-party and per site: no cross-site tracking, no fingerprinting.
An IP address is read once when the event arrives to derive a two-letter country
code, then discarded.

Events queue locally once consent allows, batch, and deliver with retry, backoff
and circuit breaking. A step is sent when it is taken, and every send uses
`keepalive`, so a click that leaves the page — even for another site — does not
cancel it. Delivery failure surfaces as a diagnosable condition, never as
silent loss.

## Where it runs

Chrome ≥ 100, Edge ≥ 100, Firefox ≥ 100, Safari ≥ 15.4. A browser leaving that
floor is a major version, because a site that worked stops working for its
visitors.

## Versions

The **major** changes when working code stops working: a method removed or
renamed on the `TraceLog` object, an argument that means something else, a new
required option, or an envelope the same release's ingestion no longer accepts.
A **minor** adds surface without moving what is there. A **patch** changes
behavior nobody wrote code against.

Pinning is only reasonable if moving is legible, so every version is in
[`CHANGELOG.md`](./CHANGELOG.md), which ships inside this package.

## Licence

MIT. The bundle is self-contained — it resolves no `@tracelog/*` package at
runtime — so a GPL-licensed plugin may carry it.
