# TraceLog SDK

The source of the three packages TraceLog publishes: the browser runtime a site
installs, the engine it is built from, and the event envelope both sides of the
wire agree on. <https://tracelog.io>

| Package                                                 | What it is                                                                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [`@tracelog/capture-web`](./packages/capture-web)       | The browser capture runtime: consent-first, pinned per version. What a site installs, from npm or the CDN. |
| [`@tracelog/capture-core`](./packages/capture-core)     | The capture engine, with no DOM and no browser global, for platform sandboxes that have neither.           |
| [`@tracelog/event-contract`](./packages/event-contract) | The event envelope: one definition of the wire format, its limits and its schemas.                         |

The three publish as **one number**: the bytes `capture-web` ships are the
other two's bytes, so there is no version of one that is not a version of all
three. Every integration names a version, exactly — each package's README
installs with `--save-exact`, and there is no `v/latest/` on the CDN.

## Development

Node 24.18.0 (`.nvmrc`) and pnpm 10.12.4 (`packageManager`). Every change
passes the four gates, from the root, in this order — CI runs the same ones:

```bash
pnpm lint       # eslint . && prettier --check . .github
pnpm typecheck  # turbo run typecheck
pnpm test       # root vitest (tools/) then turbo run test
pnpm build      # turbo run build
```

The browser floor — chromium, webkit and firefox, declared in
[`tools/sdk-browser-targets.mjs`](./tools/sdk-browser-targets.mjs) — runs
against the reference integration:

```bash
pnpm --filter @tracelog/reference-nextjs test:e2e
```

The live reading loads the vendors' own GA4, Google Ads and Meta scripts from
their network, with made-up ids, and is run weekly by `vendor-reading.yml`:

```bash
pnpm --filter @tracelog/reference-nextjs test:live
```

```text
packages/   event-contract · capture-core · capture-web · testkit (fixtures, unpublished)
examples/   reference-nextjs (the browser floor's page)
tools/      the tests that keep the repository honest: the tarballs, the lint
            boundaries, the CI image pin
```

`tools/sdk-package.test.ts` packs the three tarballs and uses them the way a
stranger does — resolved through `exports` and imported by a real `node`, with
`capture-web`'s published types checked by a consumer's own `tsc` — because a
workspace link resolves `src/` and ignores everything that actually ships.

## Releases

Releasing is merging a pull request. release-please keeps one open with the
next version and each package's changelog entry, computed from the
[conventional commits](https://www.conventionalcommits.org) that touched the
packages; `commitlint` checks every message, locally and in CI, because a
subject it cannot parse is a release that silently does not happen. Merging it
tags each package `<name>@<version>` — `capture-web@1.0.1` — uploads the
runtime to `cdn.tracelog.io/v/<version>/tracelog.js`, and publishes the three
to npm in dependency order, with provenance. A published version is never overwritten.

## Licence

MIT — see [`LICENSE`](./LICENSE).
