# Changelog

Every published version of `@tracelog/event-contract`, and what changed for
whoever sends or receives the envelope.

**What the numbers mean.** The major changes when a batch that was accepted
stops being accepted: a field removed or renamed, a limit lowered, a schema
narrowed, or `EVENT_ENVELOPE_VERSION` moving. Everything else is a minor or a
patch.

**An envelope version is a deploy before it is a release.** What a runtime
writes is the constant; what ingestion accepts is a set. The set widens and
deploys first, then this package and the runtimes built from it publish, then
the artifacts re-pin — because a page pinned to an old runtime keeps sending
the old value for as long as somebody serves it, and there is no `latest` to
carry it forward.

This package, `@tracelog/capture-core` and `@tracelog/capture-web` carry one
number between them.

## 1.0.0

The first published envelope, extracted from the monorepo TraceLog was built in
and unchanged in behaviour by the extraction.

**`EVENT_ENVELOPE_VERSION` is `1`.**

**The limits**, as the endpoint enforces them: 50 events to a batch, 256 KiB to
a batch, 8 KiB of context to an event, 1 KiB to an error message, five minutes
of tolerance for a clock ahead of the server's, and seven days after which an
event is late rather than wrong.

**The schemas**, in zod, for the envelope and each event in it, with
`validateEventBatch` answering what was accepted and the class of every
refusal — so a refusal has a reason the sender can read rather than a rejected
count.
