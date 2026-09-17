# @tracelog/capture-core

The TraceLog capture engine, with no DOM and no browser global. It is what a
platform artifact binds inside a sandbox that has neither — a Shopify web
pixel, a WordPress plugin's bridge — and what
[`@tracelog/capture-web`](https://www.npmjs.com/package/@tracelog/capture-web)
is built from.

**Most sites do not want this package.** A site you add a script to, or one
with its own build, installs `@tracelog/capture-web`, which carries this engine
inside it and adds the browser: storage, the network, the consent bridge and
the clock. Reach for `capture-core` only where there is no browser to assume.

TraceLog is conversion intelligence you can verify: it checks the conversion
path a project declares against the events TraceLog receives, watches every
declared step every day, alerts when events for one stop arriving and names the
figures that are incomplete. <https://tracelog.io>

## Install

**Every integration names a version.** There is no `latest` on npm, so the
version you pin is the code you get.

<!-- x-release-please-start-version -->

```bash
npm install @tracelog/capture-core@1.0.0
```

<!-- x-release-please-end -->

## What it expects you to supply

The engine assumes nothing about its host, so the host supplies four things:

- **storage** — `getItem`, `setItem`, `removeItem`. A sandbox with no storage
  supplies an in-memory one; a denial is one remembered key.
- **a transport** — one `send`, returning the status the endpoint answered.
- **a clock** — `now(): Date`. This package never reads the machine's, because
  in a sandbox there may not be one to read.
- **the acquisition context** — referrer, campaign, landing page, device.

Consent comes first: before a consent decision the engine creates no
identifier, no storage and no traffic.

## The wire format

Events leave in the envelope
[`@tracelog/event-contract`](https://www.npmjs.com/package/@tracelog/event-contract)
defines, at the version this package was built against — one definition, shared
by the runtime that sends and the endpoint that receives.

## Licence

MIT. See [LICENSE](./LICENSE).
