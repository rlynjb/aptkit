# Study — Software Design (aptkit)

*A Philosophy of Software Design* (John Ousterhout), applied to the **live
aptkit repo**. Not the book — the findings about your code. This guide takes the
book's primitives (deep modules, information hiding, complexity, layering,
interface design, defining errors out of existence) and walks where aptkit
honors them, where it leaks, and the single move to fix each.

> **Source note.** Every primitive named here comes from Ousterhout's book.
> This guide teaches the ideas in original words and spends its weight on the
> code; for the full conceptual treatment of any primitive, read the book and
> see `read-aposd` (the book-style framework guide). The value here is the
> findings about *your* files — original by construction.

## The through-line

```
  complexity is the enemy   ──►   a deep module is the weapon
  ─────────────────────────       ──────────────────────────────
  change amplification             big behaviour
  cognitive load              =     ÷  small interface
  unknown-unknowns                 = depth

  aptkit's bet: a few narrow contracts (ModelProvider, VectorStore,
  EmbeddingProvider, CapabilityTraceSink) with deep, swappable bodies behind
  each. The audit measures how well that bet held.
```

The repo is young but the interface discipline is above the bar for its size.
The strongest single piece of evidence isn't a module — it's that
`@aptkit/memory` was built as a *second* consumer of the retrieval contracts
with zero new infrastructure. Interfaces drawn at the right place let that
happen.

## Reading order

```
  1. 00-overview.md          one-page orientation: the design shape at a glance
  2. audit.md                Pass 1 — the 8-lens audit, ranked, with the
                             red-flag checklist and the one-thing-to-fix-first
  3. 01-…06-                 Pass 2 — deep walks of the six load-bearing moves
```

Read `00-overview.md` for the map, `audit.md` for the verdicts, then the
pattern files for the move you care about.

## The discovered patterns (Pass 2)

Named after the design *moves* aptkit actually makes — the file list is itself a
teaching artifact:

| file | the move | book primitive |
| --- | --- | --- |
| `01-deep-provider-module.md` | one 3-method contract, many deep bodies | deep module / interface design |
| `02-emulation-hidden-behind-complete.md` | tool-calling Gemma doesn't have, hidden behind `complete()` | information hiding |
| `03-contract-as-the-product.md` | retrieval contracts that never name a vendor; memory reuses them | information hiding / abstraction |
| `04-guard-rails-as-information-hiding.md` | the search tool absorbs model weakness so callers never see it | define errors out of existence |
| `05-injectable-trace-seam.md` | one `emit()` interface, body injected (in-memory ↔ Supabase) | deep interface / a seam (and its honest weakness) |
| `06-capability-as-composition.md` | agent = prompt + policy + loop + validator, composed | layering / pull complexity down |

## The verdict, in one line

Above the bar for a repo this size. Fix first: **add a metadata filter to
`VectorStore.search`** — it collapses two duplicated over-fetch-then-filter
implementations, pushes the work down into each store, and kills the
`topK * 4` magic-number drift (audit lens 3 and 8).

## Cross-links

- `../study-system-design/` — the same contracts at *service* altitude:
  boundaries, the aptkit↔buffr split, where state lives. (Altitude rule:
  module/interface here; service/architecture there.)
- `../study-agent-architecture/` — `runAgentLoop` and agentic retrieval as
  *reasoning* patterns, not just module shapes.
- `../study-testing/` — the injectable-transport seam (`05-…`) is the same
  boundary the tests mock; fixtures and replay live there.
- `read-aposd` — the book-style framework guide that teaches these primitives
  abstractly. Read it for depth; read this for your code.
