# Study — Software Design (AptKit)

A code-level design audit of the AptKit monorepo through the primitives
in **John Ousterhout's *A Philosophy of Software Design*** — deep
modules, information hiding, complexity, layering, pull-complexity-down,
define-errors-out, readability. Two-pass, audit-style: one lens audit,
then a file per design move the repo actually makes.

> **The through-line:** complexity is the enemy; deep modules are the
> weapon. AptKit's spine is a set of deliberately deep ports (the model
> contract, the two retrieval contracts) that hide a lot behind a little.
> The best findings are how much they hide; the debt is a few facts that
> leaked out of their module into two or three files.

## Source note

The design primitives are from **A Philosophy of Software Design**
(Ousterhout). They're taught here in original words and applied to
AptKit's real files — read the book for the full framework, or the
`read-aposd` guide for it taught chapter by chapter. The ports & adapters
role-vocabulary is standard (Cockburn's hexagonal architecture / the
dependency-inversion principle).

## Reading order

```
  1. 00-overview.md   — the map + the PATTERN VOCABULARY this guide owns
                        (port · adapter · client · seam · factory · DI · DIP)
  2. audit.md         — Pass 1: the 8-lens audit, verdicts, ranked fixes
  ────────────────────────────────────────────────────────────────────
  Pass 2 — the design moves the repo exercises (deep walks):
  3. 01-deep-provider-port.md             — the ModelProvider / retrieval ports
  4. 02-emulation-hidden-behind-the-port.md — Gemma's hidden tool-call emulation
  5. 03-contract-as-the-product.md         — the retrieval contract as deliverable
  6. 04-guard-rails-as-information-hiding.md — minTopK / matchesFilter / dim guards
  7. 05-injectable-transport-seam.md       — the sub-port that makes Gemma testable
  8. 06-capability-as-composition.md       — the RAG agent assembled from ports
```

Read `audit.md` for what's good, what's weak, and the three fixes ranked.
Read the `0N-` files for the deep walks behind the patterns it cites.

## The map

```
  ┌─ 00-overview ─────────────────────────────────────────────┐
  │  the deep seams + the PATTERN VOCABULARY (the dictionary)  │
  └───────────────────────────┬───────────────────────────────┘
  ┌─ audit ───────────────────▼───────────────────────────────┐
  │  8 lenses → ranked findings → top-3 fixes                  │
  └───────────────────────────┬───────────────────────────────┘
        ┌────────────┬─────────┴────────┬────────────┬─────────┐
        ▼            ▼                  ▼            ▼         ▼
     01 ports    02 emulation       03 contract  04 guards  05 seam
     (deepest)   (deepest adapter)  (the product)(info-hide)(testable)
        └──────────────────── all compose into ──────────────────┘
                                    ▼
                          06 capability-as-composition
                          (the agent built from the ports)
```

## The three fixes the audit ranks (across the whole repo)

1. **Collapse the dimension check to one `assertWiring`.** One invariant
   written in three files (`pipeline.ts:23`, `in-memory-vector-store.ts:37`,
   `conversation-memory.ts:62`). Lowest effort, clearest win.
2. **Hoist `FixtureModelProvider` into a shared package.** An identical
   18-line class copied into 5 agent packages.
3. **Add an optional `filter` predicate to the `VectorStore` port.**
   Removes the over-fetch-then-post-filter workaround from two call sites
   and lets buffr's `PgVectorStore` push the filter into SQL.

## Cross-links

- `../study-system-design/` — the same provider/retrieval seams one
  altitude up (service boundaries, scale). It cross-links back to the
  PATTERN VOCABULARY here for the role definitions.
- `../study-agent-architecture/` — the ReAct loop as a client of these ports.
- `../study-testing/` — the fixture/replay test doubles this audit references.
- `read-aposd` — the book taught as a standalone framework.

Every claim cites a real `path:line` in this repo. Inferences are
labeled. No invented code.
