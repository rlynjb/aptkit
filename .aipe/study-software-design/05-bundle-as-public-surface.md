# 05 — The bundle as public surface

**Industry names:** facade · barrel export · public API boundary ·
information hiding at the package level.
**Type:** Industry standard.

> **Updated: 2026-06-24** — the internal package count grew again to **16**:
> `core/index.ts` now also re-exports `@aptkit/memory` (`export * from
> '@aptkit/memory'`, `core/index.ts:8`), on top of the earlier `@aptkit/retrieval`,
> `@aptkit/provider-gemma`, and `@aptkit/agent-rag-query`. The *pattern* is
> unchanged — one facade hiding N packages — only N moved (now 16, `bundled
> count: 16` in `core/package.json`, v0.4.1). The teaching below holds; read
> "eleven"/"fifteen" as "sixteen and counting." That the count can grow without
> changing the public import path is the point of this file.

---

## Zoom out, then zoom in

AptKit is fifteen internal packages. The outside world sees *one*:
`@rlynjb/aptkit-core`. That package contains almost no logic — it's a
re-export.

```
  Zoom out — the public boundary

  ┌─ Host app (npm install @rlynjb/aptkit-core) ───────────────────┐
  │  import { QueryAgent, ModelProvider, runAgentLoop } from        │
  │         '@rlynjb/aptkit-core'                                   │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ one entry point
  ┌─ packages/core (the facade) ──▼─────────────────────────────────┐
  │  ★ index.ts: export * from '@aptkit/runtime'; ...15 packages ★  │
  │  bundledDependencies inlines all of them into one tarball       │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ re-exports (no logic of its own)
  ┌─ Internal packages (hidden) ──▼─────────────────────────────────┐
  │  runtime · tools · context · prompts · evals · workflows ·      │
  │  retrieval · provider-gemma · provider-local ·                  │
  │  6 agents — all versioned 0.0.0, never published directly       │
  └──────────────────────────────────────────────────────────────────┘
```

**Zoom in.** The pattern is the **facade / barrel** as an information-hiding
boundary. The internal `@aptkit/*` package split — which file lives where, how
many packages there are, their `0.0.0` versions — is an *implementation
detail*. The host app depends on names (`QueryAgent`, `ModelProvider`), not on
package layout. `core/index.ts` is the one place that decides what's public,
and it's a compatibility contract at semver `0.3.0`.

---

## Structure pass — layers · axis · seam

**Layers:** host app → `@rlynjb/aptkit-core` facade → internal `@aptkit/*`
packages → their source files.

**Axis — trace "what is allowed to be a breaking change?"**

```
  one question down the stack: "can I change this without a major bump?"

  ┌──────────────────────────────────────┐
  │ host app's imports                     │  → NO. these are the contract.
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ core/index.ts (what's re-exported) │  → NO. changing the surface = semver event.
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ internal package boundaries    │  → YES. split/merge freely.
          └──────────────────────────────┘
              ┌──────────────────────────┐
              │ internal file layout       │  → YES, totally. rename anything.
              └──────────────────────────┘

  the "can't break" / "can break" line falls at core/index.ts — that's the seam
```

**Seam:** `core/index.ts`. Above it, a published contract; below it, free-to-
refactor internals. This is the single most important seam in the whole repo
for the project's stated goal — and it's exactly why the agent-class *names*
in `04` must survive their refactor: they cross this seam.

---

## How it works

You know how you `export` only some functions from a module and keep the rest
file-private, so callers can't depend on your internals? `core/index.ts` is
that, applied to a whole monorepo: it's the `index.ts` of an eleven-package
module, and the eleven packages are the file-private helpers.

### Move 1 — the shape

```
  facade — one public name, many hidden packages

  outside ──► @rlynjb/aptkit-core ──┬─► @aptkit/runtime
                  (facade)          ├─► @aptkit/tools
                                    ├─► @aptkit/prompts
                                    ├─► @aptkit/evals
                                    ├─► ...
                                    └─► @aptkit/agent-query
       one import path                eleven hidden packages
       one version (0.3.0)            (all 0.0.0, never published)
```

### Move 2 — the parts

**Two export styles, on purpose.** Most packages use `export *` — re-export
everything. But the agent packages use *named* re-exports with explicit
renames (`Anomaly as MonitoringAnomaly`, `Anomaly as DiagnosticAnomaly`). The
boundary condition that forces this: three agents each export a type called
`Anomaly`. A blanket `export *` would collide. So the facade *curates* the
surface — it decides `MonitoringAnomaly` vs. `DiagnosticAnomaly` are the public
names, resolving a collision the internal packages don't have to care about.
That curation is the information-hiding work: the host app gets a clean,
non-colliding namespace it didn't have to assemble.

```
  the collision the facade resolves

  @aptkit/agent-anomaly-monitoring   exports  Anomaly  ┐
  @aptkit/agent-diagnostic-investig. exports  Anomaly  ┤ three "Anomaly"s
  (and recommendation uses it too)                     ┘
                    │
                    ▼  core/index.ts renames at the seam
  export { Anomaly as MonitoringAnomaly } from '...monitoring'
  export { Anomaly as DiagnosticAnomaly } from '...diagnostic'
                    │
                    ▼
  host app sees:  MonitoringAnomaly, DiagnosticAnomaly  (no collision)
```

**`bundledDependencies` makes the hiding physical.** The internal packages
aren't published separately — they're inlined into the core tarball by
`scripts/pack-core-standalone.mjs`. So "hidden" isn't just a naming
convention; the host app *literally cannot* `npm install @aptkit/runtime`.
What breaks without this: the host would have to install eleven packages and
know their layout — the internal structure would leak into the host's
`package.json`.

**The legacy alias is part of the contract.** `@aptkit/core` ↔
`@rlynjb/aptkit-core` must stay interchangeable (host apps alias
`npm:@rlynjb/aptkit-core`). That's a second name for the same surface, frozen
by the same compatibility promise.

### Move 3 — the principle

**A public API is the one boundary where you trade away refactoring freedom
for stability — so you make it as small and as curated as you can.** Every
name in `core/index.ts` is a promise you can't break without a major version.
The internal eleven-package split, the `0.0.0` versions, the file layout —
none of that is promised, so all of it stays refactorable. That's the same
information-hiding instinct as `ModelProvider` (`01`), scaled from a type to a
whole repo: expose the narrow surface, hide the wide implementation.

---

## Primary diagram

```
  the public surface — the full picture

  ┌─ Host app ─────────────────────────────────────────────────────┐
  │  import { ... } from '@rlynjb/aptkit-core'   (or @aptkit/core)   │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ CONTRACT (semver 0.3.0) — can't break
  ┌─ packages/core/src/index.ts ──▼─────────────────────────────────┐
  │  export *           from runtime/tools/context/prompts/...       │
  │  export { Anomaly as MonitoringAnomaly } from monitoring  ← curate│
  │  export { Anomaly as DiagnosticAnomaly } from diagnostic         │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ FREE TO REFACTOR below this line
  ┌─ 15 internal packages ────────▼─────────────────────────────────┐
  │  inlined via bundledDependencies → one standalone tarball       │
  └──────────────────────────────────────────────────────────────────┘
```

---

## Implementation in codebase

**Use cases.** A host app (the "Blooming Insights" shape AptKit was extracted
from) installs one package and imports agents, the provider interface, and the
loop by name — never reaching into `@aptkit/runtime` directly. CI publishes
the curated surface (`.github/workflows/publish-core.yml`); the inlining
script bundles the internals.

**The facade — `packages/core/src/index.ts:1-7` (the `export *` block):**

```
  export * from '@aptkit/runtime';     ┐
  export * from '@aptkit/tools';       │ blanket re-export: these packages
  export * from '@aptkit/context';     │ have no name collisions, so the
  export * from '@aptkit/prompts';     │ whole surface passes through.
  export * from '@aptkit/evals';       │
  export * from '@aptkit/workflows';   ┘
  export * from '@aptkit/agent-recommendation';
```

**The curated block — `core/index.ts:8-23` (named re-exports resolving
collisions):**

```
  export {
    ANOMALY_MONITORING_CAPABILITY_ID,
    AnomalyMonitoringAgent,            ← the class NAME crosses the seam:
    anomalyMonitoringToolPolicy,          this is why 04's refactor must keep it
    ...
  } from '@aptkit/agent-anomaly-monitoring';
  export type {
    Anomaly as MonitoringAnomaly,      ← rename at the boundary to dodge the
    AnomalyCategory as MonitoringAnomalyCategory,   3-way "Anomaly" collision
  } from '@aptkit/agent-anomaly-monitoring';
```

The contrast between lines 1-7 (`export *`) and 8-63 (curated, renamed)
*is* the design decision: blanket-export where the surface is clean, hand-curate
where it isn't. The facade absorbs the naming complexity so the host app
doesn't.

**The connection to `04`:** every agent class name and capability constant in
this curated block is a published promise. So when `04` recommends collapsing
the five agents' wiring into one `runCapability` helper, the refactor is safe
*precisely because* it changes the run-method bodies (below the seam) while
keeping `QueryAgent`, `AnomalyMonitoringAgent`, their `answer`/`scan` methods,
and the exported constants intact (the contract). This file is what makes that
"low-risk" claim true.

---

## Elaborate

This is the **Facade** pattern (GoF) operating at the package level, and the
**barrel file** idiom (a single `index.ts` re-exporting a directory) scaled to
a monorepo. The deeper principle is APOSD's information hiding applied to
module *boundaries*, not just module internals: the set of packages, their
versions, and their layout are decisions the public surface hides.

Why it's load-bearing for *this* repo: AptKit's entire reason to exist is
"ship reusable agent parts as a bundle without app logic leaking in." That
promise has two halves, and this pattern enforces both directions — app logic
can't leak *out* into core (the packages have no app dependency), and core's
internal structure can't leak *into* the host (the facade + `bundledDependencies`
hide it). The semver `0.3.0` contract is what makes the bundle trustworthy to
depend on; the curated `index.ts` is where that contract is literally written.

The tradeoff AptKit accepts: a curated facade is manual work — every new public
type needs a deliberate export line, and collisions like the three `Anomaly`s
must be resolved by hand. The payoff is that the host app gets a clean, stable
namespace and the team keeps full freedom to reshuffle the eleven packages
underneath.

---

## Interview defense

**Q: "You publish one package but have eleven. Why the indirection?"**

Because the eleven-package split is an implementation detail and the one
published package is the contract. The facade — `core/index.ts` — is the only
place that decides what's public, frozen at semver 0.3.0, while the internal
packages stay 0.0.0 and fully refactorable. `bundledDependencies` makes the
hiding physical: the host literally can't install the internals. And the
facade earns its keep by curating — three agents each export a type called
`Anomaly`, so the boundary renames them to `MonitoringAnomaly` /
`DiagnosticAnomaly` and hands the host a collision-free namespace it didn't
have to assemble.

```
  contract (frozen)        vs        internals (free)
  ┌──────────────────┐               ┌──────────────────────┐
  │ core/index.ts    │               │ 11 packages, 0.0.0   │
  │ semver 0.3.0     │               │ split/merge/rename   │
  │ every name = a   │               │ at will              │
  │ promise          │               └──────────────────────┘
  └──────────────────┘
```

**Anchor:** "One curated `index.ts` is the seam between what I promised and
what I'm free to refactor."

**Q: "How does this make the agent refactor in `04` safe?"** The class names
cross the seam, so they're frozen; the run-method bodies don't, so they're
free. Collapsing the wiring changes only what's below the line.

---

## Validate

1. **Reconstruct:** explain why `core/index.ts` uses `export *` for runtime
   but named exports for the agents. (Collision on `Anomaly`.) Check against
   `core/index.ts:1` vs. `:8`.
2. **Explain:** what would leak into the host app's `package.json` without
   `bundledDependencies`? (All eleven internal package deps + their layout.)
3. **Apply:** you want to merge `@aptkit/context` into `@aptkit/runtime`. Is
   that a breaking change for the host? (No — as long as the same names still
   re-export from `core/index.ts`.)
4. **Defend:** a teammate wants to publish `@aptkit/runtime` separately so
   other projects can use it. Argue the tradeoff against the bundle's
   single-surface promise and the `must-not-change` constraint.

---

## See also

- `01-model-provider-deep-module.md` — the same information-hiding instinct at
  the type level.
- `06-retrieval-contracts-as-deep-seams.md` — two of the newest packages
  (`@aptkit/retrieval`, `@aptkit/provider-gemma`) that joined this public
  surface, and the deep-module shape they reuse.
- `04-capability-agent-template.md` — why the agent class names must survive
  their refactor (they cross this seam).
- `audit.md` Lens 1 (the load-bearing contracts) and Lens 3 (provider-id
  strings as shared vocabulary).
- `.aipe/study-system-design/` — the package boundary as an architecture and
  publishing decision (higher altitude).
