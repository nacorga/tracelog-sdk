# Changelog

Every published version of `@tracelog/capture-core`, and what changed for the
artifact that binds it.

Nothing here is an alias: there is no `latest`, so every integration names a
version and needs somewhere to read what moving costs. Entries are written for
whoever decides whether to change that version, not for whoever wrote the
commit.

**What the numbers mean.** The major changes when working code stops working: a
removed or renamed export, a changed meaning for an argument, a new required
option on what the host supplies, or a wire format the ingestion endpoint of
the same release no longer accepts. Everything else is a minor or a patch.

This package, `@tracelog/capture-web` and `@tracelog/event-contract` carry one
number between them: the browser runtime's published bytes are this engine's
bytes, so no version of one is not also a version of the others.

## [1.2.0](https://github.com/nacorga/tracelog-sdk/compare/capture-core@1.1.0...capture-core@1.2.0) (2026-09-22)


### Added

* **capture-core:** report the kinds the port saw and could not read ([0103132](https://github.com/nacorga/tracelog-sdk/commit/01031320fd465d3df0d50cad78095b69c0a8cfa9))

## [1.1.0](https://github.com/nacorga/tracelog-sdk/compare/capture-core@1.0.0...capture-core@1.1.0) (2026-09-21)


### Added

* **capture-core:** hold a conversion for its tag sighting window ([8f4bd89](https://github.com/nacorga/tracelog-sdk/commit/8f4bd89e6745cb4e170e4efa108fc14815801244))

## 1.0.0

The first published engine, extracted from the monorepo TraceLog was built in
and unchanged in behaviour by the extraction.

**The surface.** `createCaptureEngine(ports, acquisition)`, which returns a
`CaptureRuntime` whose `engine` takes `init`, the consent calls, `step` and
`conversion`; `PRE_CONSENT_CAP`, how many events wait in memory before
consent; the `Clock` port; and the types that describe the rest —
`CapturePorts`, `CaptureStorage`, `CaptureTransport`, `TransportRequest`,
`TransportResponse`, `AcquisitionContext`, `InitOptions`, `ConversionOptions`,
`ConsentState`, `CaptureEngine`, `DropCount`, `CircuitState`, and the
envelope's `Event` and `EventBatch`. That is all of it, and it is what the
major number protects.

**No DOM and no browser global.** The package compiles without the DOM library
and lint refuses `window` and `document` inside it, because it is what runs in
sandboxes that have neither. That is the property the major number protects.

**It reads no clock.** The host supplies one. A sandbox may not have a
`Date` worth reading, and a test must be able to hand over a fixed instant.
