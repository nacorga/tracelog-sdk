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
