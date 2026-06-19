# Monorepo bundle boundary — 11 internal packages, one published tarball

**Industry names:** Monorepo workspace + bundled publish / facade package / API boundary. **Type:** Industry standard (the `bundledDependencies` inlining is a specific npm mechanism).

## Zoom out, then zoom in

This is the boundary that wraps the *entire* repo for the outside world. Find the `packages/core` box — it's the only package an external consumer ever names, and it inlines all the others.

```
  Zoom out — where the publish boundary lives

  ┌─ External — npm consumers / host apps ──────────────────┐
  │  import { ... } from '@rlynjb/aptkit-core'               │ ← they see ONLY this
  └───────────────────────────┬──────────────────────────────┘
                              │  one tarball, version 0.3.0
  ┌─ Publish boundary — packages/core ────────▼──────────────┐
  │  ★ @rlynjb/aptkit-core ★  re-exports all 11 packages     │ ← we are here
  │  bundledDependencies inlines them into the tarball       │
  └───────────────────────────┬──────────────────────────────┘
                              │  internal workspace deps (0.0.0)
  ┌─ Internal — 11 @aptkit/* workspace packages ──────────────┐
  │  runtime, tools, context, prompts, evals, workflows,      │
  │  + 5 agents  (none published individually)                │
  └──────────────────────────────────────────────────────────┘
```

Now zoom in. You know the two failure modes this avoids: publishing eleven separately-versioned packages that consumers must keep in lockstep (dependency hell), *or* dumping everything into one giant unstructured package (no internal boundaries). The pattern is a **facade package over a workspace monorepo**: develop as many small internal packages with clean dependency edges, but publish *one* tarball that inlines them all via `bundledDependencies`. Consumers get a single dependency at a single version; the team gets modular internals. The constraint that makes it work: app-specific product logic must never leak *into* core.

## Structure pass

**Layers:** external consumer → the facade (core) → the internal packages. One axis cuts cleanly.

**Axis — trust/visibility: what does each side see?**

```
  "what's visible from here?" — traced across the publish boundary

  ┌─ external consumer ─┐  seam   ┌─ packages/core ─────┐  seam  ┌─ internal pkgs ─┐
  │ sees ONE package    │ ══╪════► │ sees ALL 11 (deps)  │ ══╪═══►│ see each other  │
  │ @rlynjb/aptkit-core │ (flips) │ re-exports a SUBSET │(flips) │ via @aptkit/*   │
  │ @ version 0.3.0     │         │ (the API surface)   │        │ versioned 0.0.0 │
  └─────────────────────┘         └─────────────────────┘        └─────────────────┘
```

Visibility flips twice. The external world sees exactly one name at one version; core sees all eleven internals but deliberately re-exports only a *curated subset* (the API surface); the internals see each other through the workspace. *That curated re-export is the seam* — it's the published API contract (a must-not-change surface), and it's where you decide what's public vs internal. Hand off to How it works.

## How it works

#### Move 1 — the mental model

The shape is a facade that re-exports a controlled surface, plus a build/pack step that inlines the dependencies. You've built a frontend `index.ts` barrel that re-exports a folder's public functions while keeping helpers private — this is that, at the package level, with the inlining added so the consumer needs nothing else installed.

```
  The facade + inline kernel

  develop:                          publish:
  ┌─ 11 internal pkgs ─┐            ┌─ core/index.ts ──────────┐
  │ @aptkit/runtime    │  build     │ export * from runtime    │
  │ @aptkit/tools      │  order:    │ export * from tools      │  curated surface
  │ ... 5 agents       │  deps      │ export { A, B } from agentX  ← subset, aliased
  └─────────┬──────────┘  first     └───────────┬──────────────┘
            │                                   │  pack-core-standalone.mjs
            ▼                                   ▼
     each builds to dist/              npm pack each → extract into
                                       core's node_modules → pack core
                                       = ONE tarball, deps inlined
```

The two halves: the *re-export* decides the public API (compile-time), and the *bundling* makes the tarball self-contained (publish-time). Both matter — re-export without bundling means consumers must install eleven `@aptkit/*` packages that don't exist on npm; bundling without a curated re-export means leaking internals.

#### Move 2 — the step-by-step walkthrough

**The dependency edges are real and ordered.** Internally, the packages form a DAG: `runtime` depends on nothing; `tools`/`context`/`prompts`/`evals`/`workflows` depend on `runtime`; the five agents depend on those; `core` depends on all eleven. The build script compiles them in topological order — runtime first, core last. The bridge: it's a build graph, like a bundler resolving module order. The boundary condition: if you compiled core before its deps, the type declarations it re-exports wouldn't exist yet — hence the explicit ordered `build:core:deps` chain.

**The facade re-exports a curated surface.** `core/src/index.ts` does `export * from '@aptkit/runtime'` (and tools, context, prompts, evals, workflows) to expose those wholesale, but for the *agents* it re-exports a hand-picked named subset — and aliases collide (e.g. `Anomaly as MonitoringAnomaly` vs `Anomaly as DiagnosticAnomaly`, since both agent packages export a type named `Anomaly`). The bridge: it's a barrel file with deliberate `export { x, y }` instead of `export *`, so internal helpers stay internal. The boundary condition: this re-export list *is* the public API — a must-not-change compatibility contract at semver `0.3.0`. Removing or renaming an export is a breaking change for every consumer.

```
  Layers-and-hops — a name crossing from internal to public

  ┌─ @aptkit/agent-anomaly... ┐ hop 1: exports Anomaly, AnomalyMonitoringAgent, ...
  │ (internal, v0.0.0)        │ ──────────────────────────────────────────────►┐
  └───────────────────────────┘                                                │
  ┌─ packages/core/index.ts ──┐ hop 2: export { AnomalyMonitoringAgent,        ▼
  │ curate + alias            │   Anomaly as MonitoringAnomaly } from '...'  ← collision fix
  └───────────┬───────────────┘                                                │
  ┌─ consumer ▼──────────────┐ hop 3: import { MonitoringAnomaly } from        │
  │ @rlynjb/aptkit-core 0.3.0 │   '@rlynjb/aptkit-core'  ◄─────────────────────┘
  └───────────────────────────┘   (never names @aptkit/* at all)
```

**The pack step inlines everything into one tarball.** `pack-core-standalone.mjs` runs `npm pack` on each internal package (producing `.tgz` files), stages core to a temp dir, then for *each* internal package extracts its tarball into core's `node_modules/@aptkit/<pkg>/` tree, and finally runs `npm pack` on the staged core. The result is one tarball with all dependencies physically inlined under `node_modules`. The bridge: it's `bundledDependencies` — npm's mechanism for shipping deps *inside* your package rather than as registry references. The boundary condition: the `bundledDependencies` array in `package.json` lists all eleven `@aptkit/*` names; if a package is missing from that list, it won't be inlined and the published tarball breaks at install for any consumer (the missing `@aptkit/*` isn't on the public registry).

**The must-not-change rule guards the boundary's direction.** Dependencies point *into* core (internals → core → consumer). The architectural constraint is that app-specific product logic must never point the *other* way — core must not import anything app-specific, because the whole reason the monorepo exists is to ship the *reusable* parts cleanly. The bridge: it's the dependency-rule from clean architecture — dependencies point inward toward the stable core, never outward toward volatile app code. The boundary condition: if a product-specific helper sneaks into core, every consumer inherits product logic they didn't ask for, and the "reusable capabilities" promise breaks.

#### Move 2 variant — the load-bearing skeleton

1. **Isolate the kernel.** A set of internal workspace packages with a clean dependency DAG + a facade package that re-exports a curated surface + a `bundledDependencies` inline so the published tarball is self-contained + the rule that dependencies only point *into* core.

2. **Name each part by what breaks if removed.**
   - Remove the **facade re-export** → consumers must import from eleven `@aptkit/*` packages that aren't published; there's no single entry point.
   - Remove the **`bundledDependencies` inline** → the tarball references `@aptkit/*` packages that don't exist on npm; `npm install` fails for every consumer.
   - Remove the **curated subset** (just `export *` everything) → internal helpers and unstable types leak into the public API, and every internal refactor risks a breaking change.
   - Remove the **dependency-direction rule** → app-specific logic leaks into core, defeating the entire purpose of extracting reusable capabilities.

3. **Skeleton vs hardening.** Skeleton: the DAG, the facade, the inline, the direction rule. Hardening: the ordered `build:core:deps` chain (correctness of build order), the alias collisions (handling duplicate type names), the `@aptkit/core` ↔ `@rlynjb/aptkit-core` legacy alias (compatibility), the CI publish workflow. The bundle *works* with just the skeleton; the hardening keeps it building and keeps old consumers working.

The interview payoff: name **`bundledDependencies` vs regular `dependencies`**. The naive approach lists `@aptkit/*` as normal dependencies — which works in the workspace but produces a broken tarball, because npm tries to fetch those from the public registry where they don't exist. The detail that shows you've actually shipped a monorepo bundle is knowing that internal-only packages must be *bundled* (inlined into the tarball), not *depended on* (referenced from the registry). That's the difference between a tarball that installs and one that 404s.

#### Move 3 — the principle

Develop modular, publish monolithic. A workspace monorepo lets you keep clean internal boundaries (eleven packages, a real dependency DAG, independent tests), while a facade-plus-bundle lets the outside world see one stable package at one version. The consumer gets simplicity; the team keeps structure. The one rule that protects it: dependencies point *into* the published core, never out toward app-specific code.

## Primary diagram

The full recap — the DAG, the facade, the inline, the direction rule.

```
  Monorepo bundle boundary — full picture

  ┌─ internal workspace (develop) — deps point UP into core ───────────────┐
  │  runtime (no deps)                                                      │
  │    ▲                                                                    │
  │  tools  context  prompts  evals  workflows   (depend on runtime)        │
  │    ▲                                                                    │
  │  5 agents  (recommendation, anomaly, diagnostic, query, rubric)         │
  │    ▲                                                                    │
  └────┼────────────────────────────────────────────────────────────────────┘
       │  build:core:deps (topological: runtime → ... → agents → core)
  ┌────┼─ packages/core (facade) ─────────────────────────────────────────┐
  │  index.ts: export * from runtime/tools/context/prompts/evals/workflows │
  │            export { curated, Anomaly as MonitoringAnomaly } from agents│ ← API surface
  │  package.json: bundledDependencies = [all 11 @aptkit/*]                │
  │  pack-core-standalone.mjs: npm pack each → inline into node_modules     │
  └──────────────────────────────┬─────────────────────────────────────────┘
                                 ▼  ONE tarball @ 0.3.0
  ┌─ external consumer ────────────────────────────────────────────────────┐
  │  import { ... } from '@rlynjb/aptkit-core'   (or legacy @aptkit/core)    │
  │  → never names @aptkit/* ; product logic NEVER flows back up (the rule)  │
  └──────────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** A host app (the "Blooming Insights" app these capabilities were extracted from) installs one package, `@rlynjb/aptkit-core`, and imports the recommendation agent, the provider adapters, and the eval functions from it — without ever knowing there are eleven packages underneath. The CI workflow (`.github/workflows/publish-core.yml`) builds the dep chain, packs the standalone tarball, and publishes. The legacy `@aptkit/core` alias keeps older host apps working without a rename.

**The facade surface** — `packages/core/src/index.ts` (lines 1–62):

```
  export * from '@aptkit/runtime';      ← lines 1-6, expose foundation packages wholesale
  export * from '@aptkit/tools';
  export * from '@aptkit/context';
  export * from '@aptkit/prompts';
  export * from '@aptkit/evals';
  export * from '@aptkit/workflows';
  export * from '@aptkit/agent-recommendation';

  export {                              ← lines for agents: CURATED named exports
    ANOMALY_MONITORING_CAPABILITY_ID, AnomalyMonitoringAgent,
    anomalyMonitoringToolPolicy, tryParseAnomalies, ...
  } from '@aptkit/agent-anomaly-monitoring';
  export type { Anomaly as MonitoringAnomaly, ... }            ← alias: collision fix
    from '@aptkit/agent-anomaly-monitoring';
  export type { Anomaly as DiagnosticAnomaly, ... }            ← same name, different pkg
    from '@aptkit/agent-diagnostic-investigation';
       │
       └─ export * for foundation packages; CURATED export { } for agents. Both agent
          packages export a type named `Anomaly` — aliasing (MonitoringAnomaly vs
          DiagnosticAnomaly) resolves the collision. THIS list is the must-not-change
          public API at 0.3.0; renaming an export breaks every consumer.
```

**The inline declaration** — `packages/core/package.json` (lines 2–3, 44–56):

```
  "name": "@rlynjb/aptkit-core",                  ← line 2, the ONE public name
  "version": "0.3.0",                             ← line 3, the compatibility contract
  ...
  "bundledDependencies": [                        ← lines 44-56
    "@aptkit/agent-anomaly-monitoring",
    "@aptkit/agent-diagnostic-investigation",
    "@aptkit/agent-query",
    "@aptkit/agent-recommendation",
    "@aptkit/agent-rubric-improvement",
    "@aptkit/context", "@aptkit/evals", "@aptkit/prompts",
    "@aptkit/runtime", "@aptkit/tools", "@aptkit/workflows"
  ],
       │
       └─ All 11 internal packages listed. These are INLINED into the tarball, not
          fetched from the registry (they're not published individually). Drop one
          from this list and the published tarball 404s on install — the missing
          @aptkit/* isn't on the public registry.
```

**The build order** — `package.json` (lines 14–15):

```
  "build:core:deps": "npm run build -w @aptkit/runtime
     && npm run build -w @aptkit/tools && ... && npm run build -w @aptkit/agent-rubric-improvement",
  "build:core": "npm run build:core:deps && npm run build -w @rlynjb/aptkit-core",
       │
       └─ Topological order: runtime first (zero deps), core last (depends on all).
          Compile core before its deps and the .d.ts files it re-exports don't exist yet.
          This ordering encodes the dependency DAG as a build sequence.
```

**The pack-and-inline step** — `scripts/pack-core-standalone.mjs` (lines 24–60):

```
  for each workspace pkg: npm pack → .tgz in packDir          ← lines 24-33
  stage core (README, dist/src) to temp dir                   ← lines 35-39
  copy core package.json (drop devDependencies)               ← lines 41-43
  for each workspace pkg:                                       ← lines 45-55
    mkdir node_modules/@aptkit/<pkg>                            ← line 46-47
    extract its .tgz into that dir (strip outer tar dir)        ← lines 48-54
  npm pack the staged core  → ONE standalone tarball           ← line 57
       │
       └─ This is bundledDependencies made physical: each internal package's packed
          tarball is extracted INTO core's node_modules before core itself is packed.
          The output tarball carries all 11 deps inside it — self-contained, installs
          with no @aptkit/* registry lookups.
```

## Elaborate

This is the facade-package pattern over an npm workspace monorepo, with `bundledDependencies` doing the inlining. The tension it resolves is classic: micro-packages (clean boundaries, versioning hell for consumers) vs a monolith (simple to consume, no internal structure). The facade-plus-bundle takes the internal structure of micro-packages and the consumer simplicity of a monolith. npm's `bundledDependencies` is the specific lever — it ships listed deps *inside* the tarball, which is exactly what you need when those deps are internal-only and never published.

The package-cohesion view — whether each internal package is a *deep module* with a narrow interface, whether the curated re-export hides enough — belongs to study-software-design when generated; that guide owns module/interface design via APOSD primitives. This guide owns it as a *system boundary*: where the API contract lives, which direction dependencies point, and the publish mechanism. The must-not-change constraints (`context.md`) — the public API surface, the `@aptkit/core` ↔ `@rlynjb/aptkit-core` alias, "core must not import app-specific logic" — are all boundary rules this pattern enforces.

This is the outermost boundary in the repo. It wraps everything the other seven pattern files describe and ships it as one thing.

## Interview defense

**Q: You have eleven internal packages. How do you publish them without making consumers manage eleven dependencies?**

A facade package that re-exports a curated surface, with `bundledDependencies` inlining the internals into one tarball. Consumers install one package (`@rlynjb/aptkit-core`) at one version; the eleven `@aptkit/*` packages ship *inside* the tarball and are never published individually.

```
  11 internal pkgs ─► core/index.ts (curated re-export)
                   ─► bundledDependencies inlines all 11 ─► ONE tarball @ 0.3.0
```

Anchor: `core/src/index.ts:1-62` (facade), `core/package.json:44-56` (inline).

**Q: Why `bundledDependencies` instead of regular `dependencies`?**

Because the internal packages aren't on the public registry. Listed as regular `dependencies`, npm would try to fetch `@aptkit/runtime` from npmjs on install and 404. `bundledDependencies` ships them *inside* the tarball, so install needs no registry lookup for them.

```
  dependencies:        install → fetch @aptkit/* from registry → 404 ✗
  bundledDependencies: tarball already CONTAINS @aptkit/* → installs ✓
```

Anchor: `core/package.json:44-56` + `pack-core-standalone.mjs:45-57` (the physical inlining).

## Validate

1. **Reconstruct.** From memory, name the two halves of the pattern (curated re-export + bundled inline) and what each one does. Check against `core/src/index.ts:1-62` and `core/package.json:44-56`.
2. **Explain.** Why does the build compile `runtime` first and `core` last (`package.json:14`)? What breaks if you reverse it?
3. **Apply.** You add a new internal package `@aptkit/telemetry` and re-export it from core. Which *two* files must you also update for the published tarball to install correctly? (Hint: the `bundledDependencies` list and the `build:core:deps` chain.)
4. **Defend.** A teammate wants to `export *` from the agent packages instead of the curated `export { }`. Argue against it in terms of the public API contract and internal refactors.

## See also

- `00-overview.md` — the publish boundary in the full system map.
- `01-provider-abstraction.md` — the provider-neutral contract that core re-exports.
- `audit.md` lens 1 (the publish boundary), lens 7 (what stays stable: the contracts).
- study-software-design (when generated) — package cohesion and deep-module design.
