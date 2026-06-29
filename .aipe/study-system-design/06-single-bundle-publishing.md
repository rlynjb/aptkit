# 06 — Single-bundle publishing (16 packages → one tarball)

> **Subtitle:** Bundled monorepo publishing / Vendoring workspaces into one
> package — *Industry standard (npm `bundledDependencies`).* The published
> artifact is the facade package (`@rlynjb/aptkit-core`); the 16 internal
> `@aptkit/*` workspaces are bundled dependencies inlined into its tarball.

## Zoom out — where this sits

aptkit is 16 internal packages in a monorepo, none of them published. The
consumer (buffr) installs *one* dependency. The trick that makes that work:
the published facade package declares all 16 internal packages as
`bundledDependencies`, so `npm pack` inlines their built code into one tarball.

```
  Zoom out — the publishing boundary

  ┌─ aptkit monorepo (private, npm workspaces) ────────────────────────┐
  │  16 internal packages, each version 0.0.0, NONE published          │
  │  runtime · tools · context · retrieval · memory · evals · …        │
  │  + agents/* + providers/{gemma,local}                              │
  │            ▲                                                       │
  │            │ re-exported by                                        │
  │  ┌─ packages/core ─────────────────────────────────────────────┐  │
  │  │ @rlynjb/aptkit-core@0.4.1  — the facade                       │  │
  │  │ index.ts: export * from every internal package                │  │
  │  │ package.json: bundledDependencies = [16 @aptkit/* packages]   │  │
  │  └──────────────────────────────┬────────────────────────────────┘  │
  └─────────────────────────────────┼────────────────────────────────────┘
            scripts/pack-core-standalone.mjs │ npm pack
                                             ▼
                              ★ one .tgz tarball ★  ← consumers install THIS
```

The reason this exists: the alternative is publishing 16 versioned packages to
npm and asking the consumer to install and version-match all of them. The
bundle collapses that to one dependency at one version.

## Structure pass — layers, axis, seam

Layers: the **internal packages** (the real code), the **facade**
(`@rlynjb/aptkit-core`, re-export only), the **tarball** (the shipped
artifact). Trace one axis — **what is visible / installable** — up the layers:

```
  axis traced: "is this installable by an outside consumer?"

  ┌─ internal packages ─────────┐   NO — version 0.0.0, never published to npm
  └──────────────┬───────────────┘
       seam ═════╪═════  ← visibility flips: private workspace → public surface
  ┌─ facade (core) ▼────────────┐   YES — @rlynjb/aptkit-core@0.4.1, published
  │                             │   re-exports the 16; declares them bundled
  └──────────────┬───────────────┘
       seam ═════╪═════  ← packaging flips: package refs → inlined code
  ┌─ tarball ─────▼─────────────┐   the 16 packages' dist/ inlined into node_modules/
  └─────────────────────────────┘
```

Two seams. The facade boundary is where private workspaces become a public API
surface (and a semver compatibility contract). The tarball boundary is where
package *references* become inlined *code* — `bundledDependencies` is the
mechanism that crosses it.

## How it works

### Move 1 — the mental model

You know how a bundler (Vite, esbuild) takes your `import`s and inlines the
dependencies into one output file so the browser fetches one thing. This is the
npm-package version of that: `bundledDependencies` tells `npm pack` to copy the
listed packages' built code *into* the tarball, so installing the one package
installs all of them.

```
  the pattern — bundle dependencies inlined at pack time

  npm pack @rlynjb/aptkit-core
        │
        ├─ reads package.json "bundledDependencies": [16 @aptkit/*]
        │
        └─ copies each one's dist/ INTO the tarball's node_modules/
             ▼
       aptkit-core-0.4.1.tgz
         └─ node_modules/@aptkit/runtime/...   (inlined, not a registry ref)
            node_modules/@aptkit/retrieval/... (inlined)
            ... ×16
```

Install the one tarball, get all 16 — already wired, no registry lookups for
the internals.

### Move 2 — the parts

**The facade is re-export only** (`packages/core/src/index.ts:1-75`):

```ts
export * from '@aptkit/runtime';
export * from '@aptkit/retrieval';
export * from '@aptkit/memory';
// ... and named re-exports for the agents (with aliasing where names collide,
//     e.g. Anomaly as MonitoringAnomaly / DiagnosticAnomaly — lines 24-39)
```

`packages/core` contains *no logic* — it's a pure composition that re-exports
the public surface of the 16 packages. The named-with-alias re-exports
(`index.ts:12-75`) exist because two agents both export a type called `Anomaly`;
the facade disambiguates them at the boundary.

**The declaration** (`packages/core/package.json`): `version: 0.4.1`,
`bundledDependencies: [16 @aptkit/* packages]`. The internal packages are all
`version: 0.0.0` — they're never published independently, so their version is a
placeholder. Only the facade carries a real, semver'd version.

**The pack script** (`scripts/pack-core-standalone.mjs`): `npm pack`s all 16
workspaces into tarballs, stages them, and assembles the standalone bundle. The
ordered `build:core:deps` chain (per `.aipe/project/context.md`) ensures the
internal packages are built (runtime first, since everything depends on it)
before packing.

```
  layers-and-hops — build → pack → install

  ┌─ build ─────────┐ hop1: tsc -b each pkg  ┌─ pack-core-standalone.mjs ─┐
  │ ordered deps    │ ─────────────────────► │ npm pack ×16 → stage        │
  │ (runtime first) │                        │ assemble one .tgz           │
  └─────────────────┘                        └─────────────┬──────────────┘
                                  hop2: publish .tgz to npm │
                                                            ▼
  ┌─ consumer (buffr) ─────────────────────────────────────────────────────┐
  │ npm i @rlynjb/aptkit-core@^0.4.1 ─► gets all 16 inlined, one dependency │
  └─────────────────────────────────────────────────────────────────────────┘
```

**The footgun** (`RELEASE.md`): each bundled package needs `"files":
["dist/src"]` in its `package.json`, or `npm pack` excludes its gitignored
`dist` and the package ships *empty*. This is caught only at install time
downstream — the publish itself succeeds. It's named as red-flag #4 in the
audit because it's a silent process failure.

**The alias** (`.aipe/project/context.md`): `@aptkit/core` ↔
`@rlynjb/aptkit-core` must stay interchangeable so host apps that alias
`npm:@rlynjb/aptkit-core` keep working. The published name and the internal
alias are a compatibility pair.

#### Move 2 variant — the load-bearing skeleton

The bundle kernel: **a re-export facade + `bundledDependencies` + one semver'd
version on the facade**. What breaks if each goes:

- **the re-export facade** — gone, and the consumer imports 16 separate package
  paths; there's no single public surface or compatibility contract.
- **`bundledDependencies`** — gone, and npm tries to resolve the 16 `@aptkit/*`
  packages from the registry, where they don't exist (version `0.0.0`, never
  published). Install fails. This is the line that makes the one-dependency
  install possible.
- **the single semver'd version on the facade** — gone, and there's no
  compatibility contract for the consumer to pin (`^0.4.1`). The internal
  `0.0.0`s can't serve that role.

Hardening on top: the `"files": ["dist/src"]` discipline, the `@aptkit/core`
alias, the ordered build chain.

### Move 3 — the principle

When a monorepo ships as a library, pick *one* public artifact and inline the
rest. The facade is the only thing with a real version and the only thing the
consumer names; `bundledDependencies` makes "install one package" actually
deliver sixteen. The cost is a publishing process with a sharp edge (the
`files` footgun) — accepted because the alternative is asking consumers to
version-match sixteen packages by hand.

## Primary diagram

```
  single-bundle publishing — full recap

  ┌─ 16 internal @aptkit/* packages (private, v0.0.0, unpublished) ────┐
  │  runtime · tools · context · prompts · evals · workflows ·         │
  │  retrieval · memory · provider-gemma · provider-local · 6 agents   │
  └───────────────────────────┬─────────────────────────────────────────┘
                  re-exported  │  (named + aliased where types collide)
  ┌─ @rlynjb/aptkit-core@0.4.1 (facade, the public surface) ───────────┐
  │  index.ts: export * from each   ·   bundledDependencies: [16]       │
  └───────────────────────────┬─────────────────────────────────────────┘
        pack-core-standalone.mjs │ npm pack ×16 → inline → one .tgz
                                 ▼
  ┌─ consumer installs ONE dependency ─────────────────────────────────┐
  │  npm i @rlynjb/aptkit-core   (anthropic/openai NOT bundled — opt-in)│
  └─────────────────────────────────────────────────────────────────────┘
```

Note: the anthropic and openai providers are *not* in the bundle — they pull in
heavy cloud SDKs, so they stay unbundled and a consumer opts into them
separately. The bundle ships the local-first default (gemma + in-memory).

## Elaborate

`bundledDependencies` (a.k.a. `bundleDependencies`) is the standard npm
mechanism for vendoring dependencies into a published tarball — used when you
want to ship code that isn't separately published. The facade pattern on top is
the "barrel" / public-API package common in monorepos. The deliberate exclusion
of the cloud-SDK providers keeps the default install small and local-first,
consistent with the provider-abstraction default (`01`). The release mechanics
live in `RELEASE.md`; the dependency-graph build order touches
`study-runtime-systems` (module resolution) only at the edge.

## Interview defense

**Q: Why bundle instead of publishing 16 packages?**
Because then the consumer installs and version-matches 16 packages by hand. The
internals are version `0.0.0` and never hit the registry; the facade is the one
semver'd, published artifact, and `bundledDependencies` inlines the 16 into its
tarball so installing one delivers all of them, pre-wired.

```
  consumer: npm i @rlynjb/aptkit-core   →   gets 16 inlined, one version to pin
```
*Anchor:* "One bundle: `bundledDependencies` inlines 16 internal packages."

**Q: What's the sharp edge?**
Each bundled package needs `"files": ["dist/src"]` or `npm pack` drops its
gitignored `dist` and ships it empty — and the publish *succeeds*, so you only
find out at install time downstream. It's a silent process failure, not a build
error.

```
  add a bundled pkg → forget "files":["dist/src"] → pack excludes dist → empty pkg shipped
```
*Anchor:* "Every bundled package needs `files: [dist/src]` or it ships empty."

## See also

- `00-overview.md` — the bundle boundary on the full map
- `05-library-vs-deployment-split.md` — what the bundle ships across repos
- `01-provider-abstraction.md` — why anthropic/openai stay unbundled
- `study-runtime-systems` — module resolution / the ordered build chain
