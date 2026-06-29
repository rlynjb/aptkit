# 07 — Single-bundle publishing

**Industry name(s):** monorepo-to-single-package bundling · `bundledDependencies`
vendoring · published-API-as-compatibility-contract. **Type:** Project-specific
(a standard npm mechanism used to a specific architectural end).

## Zoom out, then zoom in

aptkit is 16 internal packages in a monorepo, but it ships as *one* tarball. This is
the mechanism that makes the library/deployment split (file `03`) real: it collapses
the whole monorepo into a single `npm install` so buffr never has to know aptkit's
internal package graph.

```
  Zoom out — where publishing sits

  ┌─ aptkit monorepo (private:true) ──────────────────────────────────┐
  │ 16 internal @aptkit/* packages (runtime, tools, retrieval, agents…)│
  │ packages/core re-exports them all ──┐                              │
  └─────────────────────────────────────┼──────────────────────────────┘
                                        │ pack-core-standalone.mjs:
                                        │ bundledDependencies inlines all 16
                                        ▼
                          ┌─ ONE tarball ──────────────┐
                          │ @rlynjb/aptkit-core@0.4.1   │ ← here
                          └──────────────┬───────────────┘
                                        │ npm install
                          ┌─ buffr ──────▼───────────────┐
                          │ import { ... } from '@rlynjb/aptkit-core'
                          └──────────────────────────────┘
```

The question: *how do you develop as a multi-package monorepo but ship as a single
self-contained package, so a consumer installs one thing and the published name set
is a stable contract?* Here's the mechanism.

## Structure pass

**Layers:** 16 internal packages → `packages/core` (the re-export composition) →
`bundledDependencies` (the vendoring) → the published tarball → consumer.

**Axis traced — *what does the consumer install?***

```
  One axis — "how many packages does buffr install?" — traced out

  ┌─ aptkit dev ───────────┐   16 workspaces, versioned 0.0.0, interlinked.
  └──────────┬──────────────┘
  ┌─ packages/core ────────▼┐  1 published package, version 0.4.1.
  └──────────┬──────────────┘
  ┌─ buffr ─────────────────▼┐  installs 1 thing; sees 1 import path.
  └──────────────────────────┘  16 → 1 across the publish seam.
```

**Seam:** the publish boundary. The package *count* collapses from 16 to 1, and the
*version surface* collapses from 16 internal `0.0.0`s to one semver `0.4.x`. That
collapse is the load-bearing effect — it's what makes the consumer's dependency story
trivial.

## How it works

### Move 1 — the mental model

You know how a frontend bundler takes hundreds of source modules and emits one
`index.js` the browser loads — the module graph is a dev-time concern, the bundle is
the ship artifact. This is that, for an npm package: the 16-package graph is dev-time;
`bundledDependencies` produces one tarball that carries its own internal deps inside.

```
  The bundling shape — 16 internal, 1 published

  dev time:   @aptkit/runtime ─┐
              @aptkit/tools ───┤
              @aptkit/retrieval┤──► packages/core re-exports all ──► npm pack
              … (16 total) ────┘         + bundledDependencies            │
  ship time:                                                             ▼
              ┌──────────────────────────────────────────────┐
              │ @rlynjb/aptkit-core-0.4.1.tgz                 │
              │  node_modules/@aptkit/* inlined inside it     │
              └──────────────────────────────────────────────┘
```

### Move 2 — the walkthrough

**`packages/core` is a pure re-export composition.** It has no logic of its own — it
re-exports the public surface of all 16 packages (`packages/core/src/index.ts:1`):

```ts
// packages/core/src/index.ts (head)
export * from '@aptkit/runtime';
export * from '@aptkit/tools';
export * from '@aptkit/context';
export * from '@aptkit/retrieval';
export * from '@aptkit/memory';
export * from '@aptkit/provider-gemma';
export * from '@aptkit/provider-local';
// … then explicit per-name lists for the agents (to alias collisions):
export { ANOMALY_MONITORING_CAPABILITY_ID, ... } from '@aptkit/agent-anomaly-monitoring';
export type { Anomaly as MonitoringAnomaly, ... } from '@aptkit/agent-anomaly-monitoring';
export type { Anomaly as DiagnosticAnomaly, ... } from '@aptkit/agent-diagnostic-investigation';
```

Note the explicit aliasing — `Anomaly` exists in two agent packages, so core renames
them `MonitoringAnomaly` / `DiagnosticAnomaly` to avoid a collision. **What breaks if
missing:** a bare `export *` from both would produce a duplicate-export error; the
per-name lists are the manual reconciliation of the public surface.

**`bundledDependencies` inlines the 16 into the tarball.** `packages/core`'s manifest
lists all 16 `@aptkit/*` packages in `bundledDependencies`, so `npm pack` copies their
built `dist` *into* the core tarball rather than leaving them as registry references.
The consumer installs `@rlynjb/aptkit-core` and gets everything inside it — none of
the 16 are published to npm independently. **What breaks if missing:** the consumer
would have to install 16 separate packages and keep their versions in lockstep, and
since the internals are `0.0.0` and unpublished, the install would simply fail.

**The packing script orchestrates it.** `scripts/pack-core-standalone.mjs` packs each
workspace to a tarball (`packageSpecs`, `pack-core-standalone.mjs:10`), stages them,
and produces the standalone bundle. The release flow (per `RELEASE.md`) is
`build:core → pack:core → publish:core:npm`, with an explicit ordered
`build:core:deps` chain because the packages must build in dependency order. The
sharp edge the project context flags: **each new bundled package needs
`"files": ["dist/src"]` in its manifest**, or `npm pack` excludes its gitignored
`dist` and the bundle ships an empty package — a silent, shipped-broken failure mode.

```
  Layers-and-hops — the release pipeline

  ┌─ aptkit ─────────┐ hop1: tsc -b (ordered build:core:deps)   ┌─ dist/src per pkg ┐
  │ 16 workspaces    │ ───────────────────────────────────────►│ each needs "files"│
  └───────┬───────────┘                                          └────────┬──────────┘
          │ hop2: pack-core-standalone.mjs (npm pack each, stage)          │
          ▼                                                                │
  ┌─ tarball ────────┐ hop3: publish:core:npm    ┌─ npm registry ─┐        │
  │ aptkit-core-0.4.1│ ─────────────────────────►│ @rlynjb/aptkit-core (0.4.0 last published)
  └──────────────────┘                            └───────┬────────┘
                            hop4: npm install              ▼
                                                  ┌─ buffr node_modules ─┐
                                                  │ one package, 16 inside│
                                                  └───────────────────────┘
```

**The published name set is a compatibility contract.** Because `0.4.x` is published
under semver, every name re-exported from core is a promise. The must-not-change
constraints in the project context make this explicit: the re-exported names are the
surface, the legacy alias `@aptkit/core` ↔ `@rlynjb/aptkit-core` must stay
interchangeable, and the load-bearing contract types (`ModelProvider`,
`CapabilityEvent`, `VectorStore`, `EmbeddingProvider`, …) can't change shape without
rippling across every consumer — buffr's `PgVectorStore implements VectorStore` breaks
the instant `VectorStore` changes.

### Move 3 — the principle

Develop in the structure that's pleasant to work in (a many-package monorepo with
clean internal boundaries), but *ship* the structure that's pleasant to consume (one
self-contained package with a stable name set). `bundledDependencies` is the seam that
lets those two structures differ — and once you publish under semver, the published
surface becomes a contract you maintain by hand, which is why core's `index.ts` has
explicit per-name re-exports rather than blind `export *`.

## Primary diagram

The full path from 16 dev packages to one consumed package.

```
  Single-bundle publishing — full picture

  ┌─ aptkit monorepo (root private:true, version 0.0.0) ──────────────┐
  │ 16 internal @aptkit/* packages, each versioned 0.0.0              │
  │        │ all re-exported (with alias reconciliation) by:          │
  │        ▼                                                          │
  │ packages/core/src/index.ts  →  @rlynjb/aptkit-core                │
  │   bundledDependencies: [ all 16 ]                                 │
  │   each bundled pkg MUST set "files": ["dist/src"]                 │
  └───────────────────────────────┬────────────────────────────────────┘
            build:core → pack:core │ → publish:core:npm
                                  ▼
  ┌─ npm: @rlynjb/aptkit-core@0.4.x (semver compatibility contract) ──┐
  │  one tarball, 16 packages inlined; legacy alias @aptkit/core      │
  └───────────────────────────────┬────────────────────────────────────┘
                       npm install │
                                  ▼
  ┌─ buffr ────────────────────────────────────────────────────────────┐
  │ import { VectorStore, RagQueryAgent, CapabilityTraceSink, ... }      │
  │ one dependency, one import path                                     │
  └──────────────────────────────────────────────────────────────────────┘
```

## Elaborate

`bundledDependencies` is an old, rarely-used npm feature (most monorepos publish each
package separately and let the registry resolve the graph). aptkit reaches for it
specifically to make the consumer's install trivial and to keep the internal package
graph a private implementation detail — the consumer never learns there are 16
packages. The cost is the hand-maintained re-export surface and the `"files"`
foot-gun, both of which are real and both of which the repo documents rather than
hides. This is the mechanism *underneath* the library/deployment split (file `03`):
that file draws the seam, this file is how the seam is physically shipped.

The build-ordering and `tsc -b` project-reference mechanics belong more to a build/
tooling discussion than system design; the relevant *architectural* fact here is that
the publish boundary is what makes the 16→1 collapse and the compatibility contract
real.

## Interview defense

**Q: Why bundle 16 packages into one instead of publishing each?**
So a consumer installs one thing with one version, and the internal package graph
stays a private implementation detail. `bundledDependencies` inlines the built `dist`
of all 16 into the core tarball — buffr never learns there are 16. Anchor: *develop as
16, ship as 1; the consumer's dependency story is a single semver line.*

```
  16 internal (0.0.0, unpublished) ──bundle──► 1 published (@rlynjb/aptkit-core 0.4.x)
```

**Q: What's the foot-gun in this setup?**
Each bundled package must declare `"files": ["dist/src"]`, or `npm pack` excludes its
gitignored `dist` and ships an *empty* package — a bundle that installs fine and fails
at import. It's a silent, shipped-broken failure. Anchor: *a missing `"files"` ships an
empty package that only breaks at the consumer's import.*

**Q: Why does `core/index.ts` use explicit re-exports for the agents?**
Because two agent packages both export a type named `Anomaly`; a blind `export *` from
both is a duplicate-export collision. Core reconciles the public surface by hand
(`MonitoringAnomaly` / `DiagnosticAnomaly`), which is also why that surface is a
maintained compatibility contract, not an automatic one. Anchor: *the published name
set is hand-curated because it's a semver promise.*

## See also

- `03-library-vs-deployment-split.md` — the seam this publishing physically realizes.
- `01-provider-neutral-model-seam.md` / `02-retrieval-contracts-as-the-swap-point.md`
  — the contract types that are compatibility commitments once published.
- **`study-software-design`** — `packages/core` as a façade module over the 16.
