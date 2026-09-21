# @tracelog/capture-web

The TraceLog browser capture runtime. It captures the conversion path a project
declares — each conversion and the steps preceding it — and nothing else.

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
npm install --save-exact @tracelog/capture-web@1.0.0
```

Without a build step, the same runtime as a script tag:

```html
<script src="https://cdn.tracelog.io/v/1.0.0/tracelog.js"></script>
```

<!-- x-release-please-end -->

One runtime, two forms: ESM with types for npm, and an IIFE on
`globalThis.TraceLog` for the script tag. Both are exercised on every browser of
the floor before a release.

## Consent first

Before consent is granted the runtime creates no identifiers, writes no storage,
and sends no network traffic — none, not a reduced set. Consent is a state
machine you drive; until it reaches `granted`, capture is inert. Denying keeps it
inert without breaking the page.

```js
import TraceLog from "@tracelog/capture-web";

TraceLog.init({
  key: "tl_pk_…",
  endpoint: "https://api.tracelog.io/v1/events",
});

// Only once your consent surface says yes:
TraceLog.consent.grant();
```

A site that never calls `consent.grant()` captures nothing and costs its
visitors nothing.

## The surface

That is all of it, and it is what the major version protects.

| Call                              | Does                                                               |
| --------------------------------- | ------------------------------------------------------------------ |
| `TraceLog.init(options)`          | Configures the runtime. `key` is the project's public key.         |
| `TraceLog.consent.grant()`        | Allows capture. Queued delivery begins.                            |
| `TraceLog.consent.deny()`         | Keeps the runtime inert.                                           |
| `TraceLog.consent.state()`        | `"unknown" \| "granted" \| "denied"`.                              |
| `TraceLog.step(name, context?)`   | A declared step of the conversion path.                            |
| `TraceLog.conversion(name, opts)` | A declared conversion. `opts.identifier` is its stable identifier. |

`init` also accepts `mode: "verification"`, which a distributed platform artifact
declares for its platform's own test order. A site's own snippet never sets it —
the runtime derives verification mode from the window that opened the page.

Call `init` once per page load. The runtime is built on the first call and
kept; a later call re-reads the key and the endpoint and rebuilds nothing else,
so a mode or an acquisition the first call decided stands for the page.

The application generates the exact calls your declared plan needs, so you never
type a name TraceLog already knows.

## What it captures

The events your tracking plan declares, with their context. Not page views, not
clicks, not scroll, not keystrokes. Errors are captured only when they occur
inside the conversion path, attached to the step where they happened.

Identity is first-party and per site: no cross-site tracking, no fingerprinting.
An IP address is read once when the event arrives to derive a two-letter country
code, then discarded.

Events queue locally once consent allows, batch, and deliver with retry, backoff
and circuit breaking. Delivery failure surfaces as a diagnosable condition,
never as silent loss.

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
