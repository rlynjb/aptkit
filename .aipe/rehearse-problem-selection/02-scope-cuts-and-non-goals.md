# Scope, Cuts, and Non-Goals

The fastest way to lose a review room is a wishlist — a problem framed so big that nothing could falsify it. This file does the opposite: it draws the *smallest slice that can fail*, then lists everything deliberately left out. The constraints come first, because they're what make the slice the right size.

## The constraints that shape the slice

You don't get to pick scope in a vacuum. Here are the constraints visible in the repo, drawn as the box the slice has to fit inside.

```
  THE CONSTRAINT BOX

  ┌─ TIME ─────────────────────────────────────────────────────┐
  │  Solo. One person's evenings-and-weekends budget.          │
  └─────────────────────────────────────────────────────────────┘
  ┌─ DEPLOYMENT ───────────────────────────────────────────────┐
  │  Local-first. Laptop. No per-token cloud bill on the        │
  │  default path. Gemma2:9b over Ollama @ localhost:11434.    │
  └─────────────────────────────────────────────────────────────┘
  ┌─ BOUNDARY ─────────────────────────────────────────────────┐
  │  Library, not app. aptkit stays deployment-agnostic; the   │
  │  runtime never imports a vendor SDK (model-provider.ts).   │
  └─────────────────────────────────────────────────────────────┘
  ┌─ CONSUMERS ────────────────────────────────────────────────┐
  │  Exactly ONE real consumer: buffr. Everything has to be    │
  │  validated against n=1, not a hypothetical fleet of apps.  │
  └─────────────────────────────────────────────────────────────┘
  ┌─ DATA ─────────────────────────────────────────────────────┐
  │  Shared reindb Postgres, `agents` schema, app_id-keyed.    │
  │  RLS deferred — single-operator trust model for now.       │
  └─────────────────────────────────────────────────────────────┘
```

Every one of these constraints is a *reason a non-goal is a non-goal.* Multi-tenant SaaS isn't cut because it's hard — it's cut because there's one operator and RLS is deferred. The constraints make the cuts honest instead of arbitrary.

## The smallest useful scope

The premise to validate is three words: **reusable, swappable, local.** The narrowest slice that can prove or break all three is this — not a feature set, a falsification path.

```
  THE SLICE — narrowest thing that validates the premise

  ┌─ 0. DE-RISK SPIKE ─────────────────────────────────────────┐
  │  Can a local 9B model run a bounded agent loop at all?     │
  │  Prove the riskiest assumption FIRST, before building out. │
  └───────────────────────────────┬────────────────────────────┘
                                  │ if yes, build the spine:
  ┌─ A. RUNTIME + PROVIDER SEAM ──▼────────────────────────────┐
  │  ModelProvider.complete() · runAgentLoop (bounded by       │
  │  maxTurns/maxToolCalls) · gemma provider EMULATES tools    │
  └───────────────────────────────┬────────────────────────────┘
  ┌─ B. RETRIEVAL ────────────────▼────────────────────────────┐
  │  EmbeddingProvider + VectorStore contracts ·               │
  │  InMemoryVectorStore (cosine, zero-infra) ·                │
  │  search_knowledge_base tool                                 │
  └───────────────────────────────┬────────────────────────────┘
  ┌─ C. AGENT ────────────────────▼────────────────────────────┐
  │  rag-query agent: one-tool allowlist, maxTurns:6,          │
  │  maxToolCalls:4 — the smallest real agent that uses A + B  │
  └───────────────────────────────┬────────────────────────────┘
  ┌─ D. EVALS ────────────────────▼────────────────────────────┐
  │  precision@k / recall@k · rubric-judge · replay fixtures   │
  └───────────────────────────────┬────────────────────────────┘
  ┌─ E. ONE CONSUMER ─────────────▼────────────────────────────┐
  │  buffr: PgVectorStore implements the SAME VectorStore      │
  │  contract against LIVE Supabase pgvector. ← the real test. │
  └─────────────────────────────────────────────────────────────┘
```

Step E is the whole point. Everything A–D could be self-deception — a substrate that's only ever "reused" by itself. The premise is only validated when a *separate repo* drops the `VectorStore` contract in unchanged and runs against live Postgres. That one drop-in is the falsifiable claim.

```
┃ "The slice isn't 'build the toolkit.' It's: prove a
┃  SECOND repo can consume one contract unchanged against
┃  a live database. If buffr can't, the premise is wrong —
┃  and I'd rather find that out at one consumer than five."
```

## What's deliberately NOT in scope

The cuts are not deferrals you forgot to do. They're decisions, each tied to a constraint above.

```
  NON-GOALS — and the constraint that justifies each cut

  CUT                              │  WHY IT'S CUT (the constraint)
  ─────────────────────────────────┼──────────────────────────────────
  Multi-tenant SaaS                 │  one operator; not a product for
                                    │  external devs
  ─────────────────────────────────┼──────────────────────────────────
  RLS / auth / row-level security   │  single-operator trust model;
                                    │  app_id-keyed is enough for n=1
  ─────────────────────────────────┼──────────────────────────────────
  A hosted / cloud-DEFAULT provider │  local-first is the bet; cloud
                                    │  providers exist in the monorepo
                                    │  but are NOT in the bundle
  ─────────────────────────────────┼──────────────────────────────────
  Distributed-scale ANN / HNSW      │  one consumer, small corpus;
  tuning                            │  pgvector's defaults suffice
  ─────────────────────────────────┼──────────────────────────────────
  Swapping in a native-tool-calling │  emulation over Gemma IS the
  model to dodge emulation          │  learning artifact — cutting it
                                    │  cuts the depth-signal
  ─────────────────────────────────┼──────────────────────────────────
  A second / third consumer         │  validate at n=1 first; a wishlist
                                    │  of consumers proves nothing
```

A reviewer who sees this list reads it as discipline, not as gaps. The signal is that you know what you didn't build *and why* — each cut points back at a constraint, not at "ran out of time."

## The honest gap inside the slice — name it first

There's one thing inside the scope that's built but not wired, and you volunteer it before anyone finds it.

```
  BUILT-BUT-NOT-ACTIVE — the episodic memory gap

  ┌─ EXISTS ───────────────────────────────────────────────────┐
  │  createConversationMemory (packages/memory) REUSES the     │
  │  same EmbeddingProvider + VectorStore contracts as RAG.    │
  └───────────────────────────────┬────────────────────────────┘
                                  │ but...
  ┌─ NOT WIRED ───────────────────▼────────────────────────────┐
  │  NO aptkit agent consumes it yet. Only buffr's chat        │
  │  runtime does. The contract-reuse is proven; the in-aptkit │
  │  integration is a real, named gap — not a hidden one.      │
  └─────────────────────────────────────────────────────────────┘
```

Naming this unprompted is the move. It proves the contract-reuse claim is honest (memory *does* reuse the retrieval contracts — that's real) while admitting the integration is incomplete. A reviewer who finds a gap you already disclosed trusts the rest of the brief more, not less.

```
▸ A cut you can name and tie to a constraint reads as
  judgment. A cut a reviewer discovers reads as a hole.
  The episodic-memory gap is named here on purpose — so
  it's the first one, not the worst one.
```

## One-screen recap

```
  SCOPE IN ONE FRAME

  PREMISE   reusable + swappable + local
  SLICE     spike → runtime/provider → retrieval → agent →
            evals → ONE consumer (buffr) on live pgvector
  FALSIFY   if buffr can't drop in the VectorStore contract
            unchanged, the premise is wrong
  CUTS      multi-tenant · RLS · cloud-default · ANN tuning ·
            native-tool models · a 2nd consumer
  GAP       episodic memory reuses the contracts but no aptkit
            agent wires it (buffr does) — named, not hidden
  CONSTRAINTS solo time · local-first · library boundary ·
            n=1 consumer · shared reindb, RLS deferred
```

**The one thing to remember:** the slice is the narrowest thing that can *fail*, not the most you could build. One consumer dropping in one contract unchanged is the whole falsifiable bet — and every cut points back at a constraint, so the non-goals read as decisions, not as a to-do list you abandoned.
