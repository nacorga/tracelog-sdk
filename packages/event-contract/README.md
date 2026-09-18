# @tracelog/event-contract

The TraceLog event envelope: one definition of the wire format, its limits and
its schemas. The capture runtime is built from it and TraceLog's ingestion
validates every batch against it, so a field means the same thing on both sides
of the wire. Two definitions of one wire format drift, and drift at the wire is
silent data loss.

**This package is published so that the SDK's source can be read**, which
wordpress.org requires of the plugin bundle, and so that anything sending
TraceLog events from a runtime of its own can be checked against the same
schemas rather than a copy of them. Sites installing TraceLog do not need it:
`@tracelog/capture-web` carries the limits it uses inside its bundle.

<https://tracelog.io>

## Install

<!-- x-release-please-start-version -->

```bash
npm install @tracelog/event-contract@1.0.0
```

<!-- x-release-please-end -->

## What it holds

- **`EVENT_ENVELOPE_VERSION`** — the `v` a batch carries. What a runtime writes
  is this constant; what ingestion accepts is a set, which only ever grows, so
  a page pinned to an old runtime keeps being accepted.
- **The limits** — batch events, batch bytes, context bytes, error-message
  bytes, the tolerance for a clock ahead of the server, and when an event is
  late rather than wrong.
- **The schemas** — zod, for the envelope and every event in it, plus
  `validateEventBatch`, which accepts a batch whole — flagging each event that
  arrived late — or refuses it whole, with one classification the sender can
  read.

## Licence

MIT. See [LICENSE](./LICENSE).
