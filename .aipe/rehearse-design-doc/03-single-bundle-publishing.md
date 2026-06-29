# RFC 03 — Publish one bundle, not sixteen packages

**Summary:** Keep the monorepo root `"private": true` and publish exactly one
public package — `@rlynjb/aptkit-core@0.4.1` (`packages/core`) — whose
`bundledDependencies` inlines all **16** internal `@aptkit/*` packages into a
single self-contained npm tarball, built by `scripts/pack-core-standalone.mjs`,
with the public API defined by `packages/core/src/index.ts`.

## Context / problem

AptKit is a workspaces monorepo of 16 internal packages — runtime, tools,
context, prompts, evals, workflows, retrieval, memory, two providers, six
agents, and the core composition. The internal packages are versioned `0.0.0`
and reference each other by workspace name (`@aptkit/runtime`, etc.).

A consumer (buffr) needs the agent capabilities on its laptop runtime. The
question is what to *ship*. The natural npm answer is "publish each package" —
that's what a monorepo's per-package `tsc -b` setup is built for. But that
answer drags in a versioning matrix (16 packages each with their own version,
each depending on specific versions of the others), and AptKit has exactly one
consumer with no need for partial adoption. The constraint is real but the
demand for granularity is not — yet.

There's also a sharp, non-obvious failure mode lurking in the packaging itself
(see Tradeoffs) that makes "just publish the packages" more dangerous than it
looks.

## Goals & non-goals

**Goals:**

- One install for the consumer: `npm i @rlynjb/aptkit-core`, import everything
  from it.
- The published tarball is self-contained — no internal `@aptkit/*` package
  needs to resolve from npm (they don't exist there).
- The repo root can never be published by accident.
- A documented, repeatable release: build → pack → publish → verify.

**Non-goals:**

- Independent versioning of the internal packages. They move together at `0.0.0`
  and ship under one external version.
- Publishing any `@aptkit/*` package to npm. They are internal-only.
- Supporting multiple consumers on different versions of different sub-packages.
  That's the explicit flip condition, not today's requirement.

## The decision

Publish a single standalone bundle. The 16 internal packages are listed in
`@rlynjb/aptkit-core`'s `bundledDependencies`, so `npm pack` inlines their built
`dist/` into the tarball's `node_modules/`. The consumer gets one package that
carries its own dependencies inside it.

```
  Single-bundle publishing — 16 packages → one tarball

  ┌─ Monorepo (root: "private": true — never publishes) ───────────┐
  │                                                                 │
  │  @aptkit/runtime  tools  context  prompts  evals  workflows     │
  │  retrieval  memory  provider-gemma  provider-local              │
  │  agent-{anomaly,diagnostic,query,recommendation,rubric,rag}     │
  │       └──────────────── 16 internal pkgs ──────────────┘        │
  │                              │ re-exported by                   │
  │                   packages/core/src/index.ts (public API)       │
  │                              │                                   │
  │            packages/core/package.json:                          │
  │              dependencies + bundledDependencies = all 16        │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ pack-core-standalone.mjs:
                                 │  1. npm pack each of the 16 → .tgz
                                 │  2. extract each into stage/node_modules/
                                 │  3. npm pack the staged core dir
                                 ▼
  ┌─ npm registry ─────────────────────────────────────────────────┐
  │  @rlynjb/aptkit-core@0.4.1.tgz                                   │
  │   └─ dist/src/ + node_modules/@aptkit/* (16, inlined)           │
  └──────────────────────────────┬─────────────────────────────────┘
                                 │ npm i @rlynjb/aptkit-core
  ┌─ Consumer (buffr, separate repo) ──────────────────────────────┐
  │  import { VectorStore, runAgentLoop, ... } from                 │
  │         '@rlynjb/aptkit-core'   (one package, self-contained)   │
  └─────────────────────────────────────────────────────────────────┘
```

The load-bearing parts, by what breaks if you remove each:

- **Root `"private": true`.** The guard against publishing the monorepo. A bare
  `npm publish` at root fails with `EPRIVATE` on purpose (`RELEASE.md`). Remove
  it and one stray command leaks the whole repo.
- **`bundledDependencies`** (`packages/core/package.json:49–66`, all 16 listed
  alongside `dependencies`). This is what tells `npm pack` to inline the
  packages rather than list them as registry deps. Drop a package from this list
  and the bundle ships incomplete — the consumer gets `has no exported member`.
- **`packages/core/src/index.ts`** — the public API. It re-exports the internal
  packages; what it exports *is* the compatibility surface (semver `0.4.x`).
- **`scripts/pack-core-standalone.mjs`** — the producer. It `npm pack`s each of
  the 16 workspaces to a `.tgz`, extracts each into a staging
  `node_modules/@aptkit/<name>/`, copies core's own `dist/src` + README +
  cleaned `package.json` into the stage, then `npm pack`s the stage into the
  final tarball. The `packageSpecs` array (lines 10–27) is the authoritative
  list of what gets bundled — it must stay in sync with `bundledDependencies`.

## Alternatives considered

**1. Publish N packages independently** — each `@aptkit/*` to npm with its own
version, consumer installs the ones it wants. *Why it lost:* it buys
granularity AptKit doesn't need today and pays for it with a 16-way version
matrix and 16 release pipelines. One consumer, no partial-adoption demand.
**The flip condition is explicit:** the moment a *second* consumer needs a
*different version* of a sub-package than the first, the single bundle stops
fitting and this becomes the right answer. Until then it's overhead for a
problem nobody has.

**2. Git dependencies** — consumer points its `package.json` at the GitHub repo
or a subdirectory. *Why it lost:* it ships *source*, not built `dist/`, so the
consumer has to build the monorepo's TypeScript itself (and resolve the
workspace graph) — or it ships the whole repo including everything `private`
should keep in. No clean public surface, no semver, no `npm view version`. It
trades the pack-script complexity for consumer-side build complexity, which is
worse.

**3. A bundler (esbuild/rollup) that flattens everything into one `.js`.** *Why
it lost:* it would erase the package boundaries that make the internal structure
legible and the types per-package, and it fights the per-package `tsc -b` setup
the repo already runs. `bundledDependencies` keeps each package intact inside
the tarball — same structure, just shipped together.

## Tradeoffs accepted

We chose one bundle, accepting producer-side pack complexity: a 76-line script,
a `packageSpecs` array that must mirror `bundledDependencies`, and a five-step
checklist (`RELEASE.md`) every time a new internal package joins the surface
(re-export, `dependencies`, `bundledDependencies`, `tsconfig` reference,
`build:core:deps`, `packageSpecs`). We own that complexity on purpose — it lives
in one script and one doc, and it buys the consumer a single trivial install.

**The real scar — and it's worth stating plainly because it shipped broken
twice:** every bundled package's `package.json` **must** declare
`"files": ["dist/src"]` (or `["README.md", "dist/src"]`). AptKit's `.gitignore`
ignores `dist/`, and `npm pack` honors `.gitignore` by default — so a bundled
package *without* an explicit `files` allowlist ships with its built `dist/`
silently excluded. The tarball then contains the package's `package.json` but
none of its `.js`/`.d.ts`, and the consumer gets `has no exported member …` type
errors at compile time, not at pack time. This bit `@aptkit/provider-gemma` and
`@aptkit/provider-local` when they were first bundled (`RELEASE.md`). The cost is
accepted; the mitigation is that it's now the loudest line in the release doc.

## Risks & mitigations

- **A new package is added but not bundled** → it ships missing, consumer breaks.
  Mitigation: the five-step checklist in `RELEASE.md`; `packageSpecs` and
  `bundledDependencies` are the two lists that must agree.
- **Bundled package missing `"files"`** → empty `dist/` in the tarball.
  Mitigation: the gotcha is documented as the headline release risk; the fix is
  one line per package.
- **Accidental root publish** → root `"private": true` makes it fail loud
  (`EPRIVATE`).
- **Stale `dist/` packed** → `npm run build:core` (ordered `build:core:deps`
  chain) runs before pack; the script packs from `dist/`, so an unbuilt package
  packs empty rather than stale — caught by the consumer's compile.
- **2FA blocks automated publish** → granular access token (`@rlynjb` scope,
  read+write, bypass-2FA) in `~/.npmrc`, per `RELEASE.md`.

## Rollout / migration

Already in production: `0.4.0` is the last version published to npm, `0.4.1` is
the current repo dev version. The consumer migration is documented — bump
buffr's `"@rlynjb/aptkit-core"` range, `rm -rf node_modules package-lock.json &&
npm install`, `npm test`. Versioning follows semver against the *re-exported
surface*: patch for fixes, minor for new packages/exports, major for breaking
API changes. The `@aptkit/core` ↔ `@rlynjb/aptkit-core` alias must stay
interchangeable for host apps that alias `npm:@rlynjb/aptkit-core`.

## Open questions

- **When does the second consumer arrive?** The whole single-bundle case rests
  on one consumer. The day a second consumer needs a different sub-package
  version, revisit alternative 1. Worth a periodic check, not a present action.
- **The two-list invariant is manual.** `packageSpecs` (the script) and
  `bundledDependencies` (the manifest) must list the same 16 packages, kept in
  sync by hand and a checklist. A single source of truth (generate one from the
  other) would remove a class of "ships incomplete" bugs. Not built.
- **No automated tarball verification.** Nothing asserts post-pack that every
  bundled package has a non-empty `dist/src` — the `"files"` scar is caught by
  the *consumer's* compile, not by the release pipeline. A pack-time check that
  each inlined package exports what `index.ts` imports would catch it before
  publish.
