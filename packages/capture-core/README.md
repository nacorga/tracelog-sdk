# @tracelog/capture-core

The TraceLog capture engine, with no DOM and no browser global. It is what a
platform artifact binds inside a sandbox that has neither — TraceLog's Shopify
web pixel is one — and what
[`@tracelog/capture-web`](https://www.npmjs.com/package/@tracelog/capture-web)
is built from.

**Most sites do not want this package.** A site you add a script to, or one
with its own build, installs `@tracelog/capture-web`, which carries this engine
inside it and adds the browser: its storage, its network, the page's errors and
lifecycle, the verification handshake and the clock. Reach for `capture-core`
only where there is no browser to assume.

TraceLog is conversion intelligence you can verify: it checks the conversion
path a project declares against the events TraceLog receives, watches every
declared step every day, alerts when events for one stop arriving and names the
TraceLog figures that are incomplete. <https://tracelog.io>

## Install

**Every integration names a version, exactly.** Install with `--save-exact`,
so your manifest names this version rather than a range: the version you pin
is the code you get.

<!-- x-release-please-start-version -->

```bash
npm install --save-exact @tracelog/capture-core@1.2.0
```

<!-- x-release-please-end -->

## What it expects you to supply

The engine assumes nothing about its host, so the host supplies four things, and
may supply a fifth:

- **storage** — `getItem`, `setItem`, `removeItem`. A sandbox with no storage
  supplies an in-memory one; a denial is one remembered key.
- **a transport** — one `send`, returning the status the endpoint answered.
- **a clock** — `now(): Date`. This package never reads the machine's, because
  in a sandbox there may not be one to read.
- **the acquisition context** — referrer, campaign, landing page, device.
- **tag sightings**, optionally — a `TagSightingPort` that reports which tags
  the page requested around an instant. Without one, conversions are sent
  unheld and report none. From 1.2.0 it may also say which kinds it saw
  requested and could not read.

Consent comes first: before a consent decision the engine creates no
identifier, no storage and no traffic.

## The wire format

Events leave in the envelope
[`@tracelog/event-contract`](https://www.npmjs.com/package/@tracelog/event-contract)
defines, at the version this package was built against — one definition, shared
by the runtime that sends and the endpoint that receives.

## Licence

MIT. See [LICENSE](./LICENSE).
