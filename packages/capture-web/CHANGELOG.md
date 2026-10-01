# Changelog

Every published version of `@tracelog/capture-web`, and what changed for the
site that embeds it.

This file exists because nothing here is an alias. There is no `latest` on npm
and no `v/latest/` on the CDN — every integration names a version, so every
integration needs somewhere to read what moving costs. Entries are written for
whoever has to decide whether to change the version in their script tag, not
for whoever wrote the commit.

**What the numbers mean** — the major changes when working code stops
working: a removed or renamed method on the `TraceLog` object, a changed
meaning for an argument, a new required option, or a wire format the ingestion
endpoint of the same release no longer accepts. Everything else is a minor or a
patch, and neither requires reading your code.

Entries after 1.0.0 are drafted from the commits that touched this package and
edited before release.

## [2.0.0](https://github.com/nacorga/tracelog-sdk/compare/capture-web@1.3.1...capture-web@2.0.0) (2026-10-01)


### ⚠ BREAKING CHANGES

* **capture-core:** call TraceLog.consent.grant() on every load while the visitor's consent stands, not only when they accept.

### Added

* **capture-web:** calls before init are held ([b8d4fe5](https://github.com/nacorga/tracelog-sdk/commit/b8d4fe5e4bb104c2343aeceeb1b17f70d8cc697a))


### Fixed

* **capture-core:** a grant is not remembered across loads ([75d4cac](https://github.com/nacorga/tracelog-sdk/commit/75d4cac28055007553e36b97d4eef0dbabf27103))
* **capture-web:** the verification mark follows its tab ([9653074](https://github.com/nacorga/tracelog-sdk/commit/9653074fb57ef5523a43a7fa6bc681f8b8a8814f))

## [1.3.1](https://github.com/nacorga/tracelog-sdk/compare/capture-web@1.3.0...capture-web@1.3.1) (2026-09-30)


### Fixed

* **capture-core:** a send outlives the page that started it ([86faf5f](https://github.com/nacorga/tracelog-sdk/commit/86faf5f479a76d69f6413f9db82daae1482492df))

## [1.3.0](https://github.com/nacorga/tracelog-sdk/compare/capture-web@1.2.0...capture-web@1.3.0) (2026-09-27)


* **capture-web:** Synchronize tracelog-sdk versions

## [1.2.0](https://github.com/nacorga/tracelog-sdk/compare/capture-web@1.1.0...capture-web@1.2.0) (2026-09-22)


### Added

* **capture-web:** read Meta's form and report its beacon as unread ([bd78f98](https://github.com/nacorga/tracelog-sdk/commit/bd78f98a9c478b863399d9e86090b31a906743c5))

## [1.1.0](https://github.com/nacorga/tracelog-sdk/compare/capture-web@1.0.0...capture-web@1.1.0) (2026-09-21)


### Added

* **capture-web:** read the page's tag requests through Resource Timing ([3de9b5c](https://github.com/nacorga/tracelog-sdk/commit/3de9b5ccea21ed82f198b9885c1d6143f7ca71c1))

## 1.0.0

The first published runtime.

**The surface.** `TraceLog.init(options)`, `TraceLog.consent.grant()`,
`.deny()`, `.state()`, `TraceLog.step(name, context?)` and
`TraceLog.conversion(name, options)`. That is all of it, and it is what the
major number protects.

**Consent comes first, and it is not a setting.** Before consent is granted the
runtime creates no identifier, writes no storage, and sends no request — none,
not a reduced set. A site that never calls `consent.grant()` captures nothing
and costs its visitors nothing.

**What it captures** is the declared conversion path: the conversions you
declare and the steps preceding them, with their context. Not page views, not
clicks, not scroll, not keystrokes.

**Where it runs.** The browsers named in
[`tools/sdk-browser-targets.mjs`](../../tools/sdk-browser-targets.mjs), which
the reference application's end-to-end suite runs against on Chromium, WebKit
and Firefox before any release.

**How to pin it.**

```html
<script src="https://cdn.tracelog.io/v/1.0.0/tracelog.js"></script>
```

or `npm install @tracelog/capture-web@1.0.0`. Both are immutable: the version
you pin is the bytes you get, for as long as they are served.
