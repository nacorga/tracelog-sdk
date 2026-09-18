# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository. The commands,
the layout and the release path are in [`README.md`](./README.md); this file
is what is easy to break from inside a single file.

## Where the rules come from

This repository holds TraceLog's published SDK and none of its specification.
What the runtime does is governed by the product's own documents, in the
platform's repository: the product definition, the capture specification
(comments here cite it as `[spec/capture.md] § Section`) and the foundations'
§ Versioning. **Code never wins**: when the code here and those documents
disagree, the code is the defect — or the document is, and it is amended there
first. Never pick a side silently.

## Invariants

- **Consent first.** Before a consent decision the runtime creates no
  identifier, no storage and no traffic — none; a denial is one remembered key.
- **The envelope is defined once**, in `event-contract`. The runtime is built
  from it and ingestion validates against it; a second definition drifts, and
  drift at the wire is silent data loss.
- **`capture-core` touches no DOM and no browser global.** It extends
  `tsconfig.sdk.json` (ES2020, no `dom` lib) and lint bans `window` and
  `document` there: it runs inside platform sandboxes that have neither.
- **Time is injected.** `capture-core` declares the `Clock` port and reads no
  clock; `packages/capture-web/src/clock.ts` is the only file that may call
  `Date.now()`. Tests control time.
- **The bundle is a concatenation**, not a bundler's output:
  `packages/capture-web/build.mjs` joins the emitted modules of `capture-core`
  and `capture-web`, strips imports and `export` keywords, and inlines the
  `event-contract` constants **by name**. A constant the core newly imports
  and the list omits is a `ReferenceError` on a customer's page, with every
  gate green; a re-export (`export { x } from "./y.js"`) reaches the bundle
  verbatim and is a syntax error. The IIFE has a 12 KiB gzip budget.
- **One number for all three.** `linked-versions` holds them together, pnpm
  pins `capture-core` to the exact `event-contract` it packed, and they
  publish in dependency order: `event-contract`, `capture-core`,
  `capture-web`.
- **`EVENT_ENVELOPE_VERSION` is a major of all three, and a release that
  widens the door comes before it.** The versions the door accepts are
  `event-contract`'s schemas, which the platform installs pinned, so it widens
  only through a release here: first one whose schemas accept the old version
  and the new while the runtime still writes the old, which the platform pins
  and deploys; then the major. A runtime pinned at an old version keeps sending
  the old value for as long as a page holds it, so the accepted set only ever
  grows.
- **A version is a fact, never an alias.** No `latest` on npm, no `v/latest/`
  on the CDN; a published version is never overwritten.

## Conventions

- Conventional commits, checked by `commitlint` in a `commit-msg` hook and in
  CI: release-please computes the version and each changelog from them, and
  reads the _path_ a commit touched, never its scope. A `feat` is a minor, a
  `fix` a patch, `!` or `BREAKING CHANGE:` a major.
- Tests live beside the code as `*.test.ts`; the root `vitest.config.ts` runs
  `tools/` at the root and `src/` inside a package. Playwright's specs live in
  `examples/reference-nextjs/e2e/`.
- No focused, skipped or stubbed test stands in for a passing one — lint
  refuses `.only`, `.skip` and `.todo`.
