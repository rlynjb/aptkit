# RFC 03 — Publish one bundled package, not sixteen

**Summary:** A 16-package internal monorepo publishes exactly one package, `@rlynjb/aptkit-core`, whose `bundledDependencies` inline all 16 `@aptkit/*` packages into a single standalone tarball — so a consumer installs one name, tracks one semver, and never inherits the internal build graph; the monorepo root stays `private: true` and never publishes.

---

## Context / problem

aptkit is a workspaces monorepo of 16 internal `@aptkit/*` packages (runtime, retrieval, tools, the agents, providers, memory, …). There is one real consumer today — buffr — and the requirement is plain: buffr must `npm install` and build from a clean clone, with no access to the internal workspace.

The packaging question is how those 16 internal packages reach the consumer. Publish them all separately and the consumer pins 16 version numbers that have to stay mutually compatible. Use git/submodule dependencies and the consumer inherits the entire internal build graph. Neither serves "clean clone, one install." The decision is what shape crosses the npm boundary.

> ┃ This reads as a boring packaging chore until you ask
> ┃ the real question: who debugs a version mismatch
> ┃ between the runtime package and the retrieval
> ┃ package? With 16 published packages, the answer is
> ┃ "the consumer." That's the cost you're moving.

---

## Goals & non-goals

**Goals**
- A consumer installs one name and tracks one version.
- A clean clone builds with no access to the internal monorepo.
- The internal package boundaries stay intact *inside* the repo (16 packages, real seams) without leaking out.
- The public API surface is explicit and controlled.

**Non-goals**
- Not supporting a consumer taking a *subset* of packages. It's all 16 or none. Acceptable while there's one consumer.
- Not publishing the monorepo root. It's `private: true` on purpose; a bare `npm publish` there fails with `EPRIVATE`, which is expected.
- Not splitting into separately-versioned packages — *yet*. That's the right shape later; see the flip condition in Alternatives.

The first non-goal is load-bearing: **"a consumer can't take just the retrieval contracts" is a deliberate boundary, not an oversight.** Naming it stops the subset argument before it starts.

---

## The decision

The shape: every internal package is packed and inlined into one `node_modules`-shaped tarball published under a single name, with one public entry point gating the API surface.

```
  SINGLE BUNDLE — 16 internal packages → one tarball

  ┌─ Monorepo (private: true, never publishes) ─────────────┐
  │  @aptkit/runtime   @aptkit/retrieval   @aptkit/tools     │
  │  @aptkit/memory    @aptkit/provider-gemma   … (16 total) │
  └───────────────────────────┬─────────────────────────────┘
                              │ scripts/pack-core-standalone.mjs
                              │   1. npm pack every workspace
                              │   2. extract each tarball into
                              │      stage/node_modules/@aptkit/*
                              │   3. npm pack the staged @rlynjb/core
                              ▼
  ┌─ Published artifact (npm) ──────────────────────────────┐
  │  @rlynjb/aptkit-core@0.4.1                               │
  │   package.json:                                          │
  │     bundledDependencies: [ all 16 @aptkit/* ]            │
  │     files: ["README.md", "dist/src"]                     │
  │   dist/src/index.js  ← the ONLY public surface           │
  │   node_modules/@aptkit/*  ← inlined, JS included         │
  └───────────────────────────┬─────────────────────────────┘
                              │ npm install @rlynjb/aptkit-core
                              ▼
  ┌─ Consumer (buffr, clean clone) ─────────────────────────┐
  │  import { … } from '@rlynjb/aptkit-core'                 │
  │  one name · one semver · no internal build graph         │
  └──────────────────────────────────────────────────────────┘
```

The diagram is the decision: 16 boxes go in, one box comes out, and the consumer sees only the bottom band.

**One package.** `packages/core/package.json` is `@rlynjb/aptkit-core@0.4.1`. Its `bundledDependencies` array lists all 16 internal packages, so `npm pack` ships them *inside* the tarball's `node_modules` rather than as registry references. The consumer resolves nothing — the dependencies travel with the package.

**The packer.** `scripts/pack-core-standalone.mjs` does the assembly: `npm pack` every workspace into per-package tarballs, extract each into a staging `node_modules/@aptkit/*`, copy `core`'s `dist/src` + README, strip devDependencies, then `npm pack` the staged directory into the final standalone tarball. The producer carries the complexity.

**The API surface.** Whatever `packages/core/src/index.ts` re-exports *is* the public API — the compatibility contract. `@rlynjb/aptkit-core` is `main`/`types` pointing at `dist/src/index.js`; nothing else is reachable. That single entry point is what semver `0.4.x` is promising against.

**Private root.** The monorepo root never publishes. Only `core` does. That keeps the 16 internal packages as real boundaries inside the repo while exactly one thing crosses the npm line.

> ┃ The framing that gets the yes: "I moved the
> ┃ packaging complexity to the producer — one script —
> ┃ so the consumer gets a clean clone and one semver to
> ┃ track. The 16-package structure stays real inside
> ┃ the repo; it just doesn't leak out."

---

## Alternatives considered

**(a) Publish 16 packages separately.**
The textbook monorepo answer. It lost on the consumer's versioning burden: 16 version numbers that must stay mutually compatible, and a mismatch between, say, `@aptkit/runtime` and `@aptkit/retrieval` becomes the consumer's debugging problem. But name the flip condition precisely: **once there's a second consumer that needs different subsets at different versions, separate packages become the right shape** — the bundle's "all or none" stops being free. With one consumer that wants the whole core, one version wins; with many consumers wanting slices, sixteen versions win.

**(b) Git dependencies / submodules.**
Point the consumer at the repo directly. It lost because the consumer then inherits the entire internal build graph — they clone submodules and build the workspace themselves. That's exactly the internal complexity the boundary is supposed to hide. A clean clone with one tarball is the opposite of "build my monorepo yourself."

```
  WHERE A REVIEWER PUSHES — "16 separate packages is the standard
  monorepo publish. Why bundle?"

  Don't argue bundling is universally better. Anchor to consumer count:
  "Separate packages are right once consumers want different subsets at
  different versions. I have one consumer that wants the whole core, so
  one version with no compatibility matrix wins today — and I've named
  the second-consumer flip as the open question." Naming the flip is
  what turns 'unusual choice' into 'scoped choice.'
```

---

## Tradeoffs accepted

We chose one bundle, accepting two costs without apology:

- **Producer-side pack complexity.** `pack-core-standalone.mjs` has to pack every workspace and assemble the tarball, and adding a new internal package means updating five places (index re-export, core's package.json dependencies + bundledDependencies, core's tsconfig references, the root build:core:deps, and the packer's `packageSpecs`) — all documented in `RELEASE.md`.
- **No subset install.** A consumer takes all 16 packages or none. Someone who wanted only the retrieval contracts over-installs the agents, the providers, and memory.

The buy: the consumer's experience is one install, one semver, a clean clone, and zero exposure to the internal build graph. We moved the complexity to the producer so the consumer never sees it.

---

## Risks & mitigations

```
  RISK                              MITIGATION / STATUS
  ────                              ───────────────────
  Tarball ships with NO JS →        THE REAL SCAR. .gitignore ignores dist/,
  consumers get "has no exported    npm pack honors .gitignore, so without
  member" errors                    "files": ["dist/src"] in EACH bundled
                                    package, its built dist/ is excluded.
                                    Mitigation: every bundled package carries an
                                    explicit files allowlist, documented in
                                    RELEASE.md. (This bit provider-gemma and
                                    provider-local when first bundled at 0.4.0.)

  New package silently missing      RELEASE.md's "update all five" checklist;
  from the bundle                   the packer fails loudly if a tarball is absent

  @aptkit/core alias stops          must keep resolving for host apps; tracked
  resolving                         as a rollout constraint
```

The first row is the decision's defining detail — and the one that proves it was actually shipped, not described from a tutorial. The `.gitignore` / `npm pack` interaction is invisible until the tarball reaches a consumer with no JavaScript in it. It drew blood at 0.4.0 on `provider-gemma` and `provider-local`; the fix is the per-package `files` allowlist, now a documented gotcha.

> ┃ Naming the scar IS the senior signal here. "It
> ┃ shipped a JS-free tarball at 0.4.0 because npm pack
> ┃ honors .gitignore and dist/ is ignored — the fix is
> ┃ a files allowlist in every bundled package" is worth
> ┃ more than any amount of clean theory about bundling.

---

## Rollout / migration

Releases follow the five-step flow in `RELEASE.md`: bump `packages/core/package.json` version per semver, `build:core`, `pack:core` (the standalone tarball), `publish:core:npm`, then `npm view` to verify. Versioning is driven off the re-exported surface — patch for fixes, minor for new exports, major for breaking API changes — and bumped at release time, not speculatively.

For the consumer (buffr), the migration on each release is: bump `@rlynjb/aptkit-core` in `package.json`, `rm -rf node_modules package-lock.json && npm install`, run tests, commit. The `@aptkit/core` alias must keep resolving for host apps across versions — that's the compatibility constraint that rides every release.

---

## Open questions

- **When to split into separately-versioned packages.** The flip condition is a second consumer that needs a different subset at a different version. Until then, one bundle. The open question is the *trigger* — what concretely makes the all-or-none cost exceed the sixteen-versions cost.
- **A slimmer retrieval-only entry point.** Should `core` publish a second, smaller entry (e.g. retrieval contracts + in-memory store) for consumers who want only RAG, without exploding into 16 packages? A middle path between one bundle and full split. Undecided.
- **Pin strategy for the alias.** Should host apps pin `@rlynjb/aptkit-core` with `^` (the current buffr pattern) or exact? `^` rides minor bumps but trusts the semver discipline on the re-exported surface. Open.
