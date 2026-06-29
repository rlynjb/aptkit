# Scope, Cuts, and Non-Goals

Answers 7 and 8 of the brief: the **smallest useful scope** that validates the premise, and the **non-goals** — what was deliberately *not* built. Coach posture: the discipline a review room rewards is showing you cut on purpose, not that you ran out of time. A non-goal you can defend is a stronger signal than a feature you shipped.

## The premise the scope must validate

> ┃ A provider-neutral, local-first agent layer can be reused across Rein's apps
> ┃ without re-wiring the plumbing — and that reuse is *demonstrable*, not asserted.

Everything in scope exists to make that sentence true and checkable. Everything out of scope is there because it doesn't move that needle yet.

## The smallest useful scope — three rings

```
  SMALLEST USEFUL SCOPE — narrowest slice that proves the premise

  ring 1: DE-RISK SPIKE
  ┌────────────────────────────────────────────────────────┐
  │  does provider-neutral + local Gemma actually run an    │
  │  agent loop with NO cloud call?                         │
  │  → answers "is the hard part even possible?"            │
  └───────────────────────────┬────────────────────────────┘
                              │ yes → build the real thing
  ring 2: THE PACKAGES
  ┌───────────────────────────▼────────────────────────────┐
  │  the contracts + the minimum to exercise them:          │
  │  ModelProvider.complete() · EmbeddingProvider ·         │
  │  VectorStore · RAG from scratch · evals · agent loop    │
  │  → answers "is the boundary the right boundary?"        │
  └───────────────────────────┬────────────────────────────┘
                              │ yes → prove reuse
  ring 3: ONE LIVE CONSUMER
  ┌───────────────────────────▼────────────────────────────┐
  │  buffr installs @rlynjb/aptkit-core@^0.4.1 and swaps    │
  │  InMemoryVectorStore → PgVectorStore on Supabase        │
  │  pgvector — ONE contract, ONE line, agent code untouched│
  │  → answers "does reuse actually happen across repos?"   │
  └─────────────────────────────────────────────────────────┘
```

- **EVIDENCE (ring 1):** the local Gemma provider runs the loop offline with emulated tool-calling and parse-retry (`packages/providers/gemma/src/gemma-provider.ts`; `context.md` stack). The local default makes no cloud call.
- **EVIDENCE (ring 2):** the contracts are real and minimal — `EmbeddingProvider` + `VectorStore` at `packages/retrieval/src/contracts.ts:22,33`; RAG index/query pipeline at `packages/retrieval/src/pipeline.ts`; ranked-retrieval scorers `scorePrecisionAtK`/`scoreRecallAtK` at `packages/evals/src/precision-at-k.ts`; `rubric-judge` at `packages/evals/src/rubric-judge.ts`.
- **EVIDENCE (ring 3):** buffr consumes the published bundle (`buffr/package.json`) and implements the swap at `/Users/rein/Public/buffr/src/pg-vector-store.ts`, tested at `/Users/rein/Public/buffr/test/pg-vector-store.test.ts`.

▸ **The validating move is ring 3 against ring 2:** the same `VectorStore` contract has two implementations — `InMemoryVectorStore` (cosine scan, in aptkit) and `PgVectorStore` (Supabase pgvector, in buffr) — and switching between them is one binding at the edge, not an agent rewrite. *That swap is the whole premise made observable.*

## What was deliberately NOT built — the non-goals

```
  NON-GOALS — cut on purpose, each with the reason it's out

  ┌─ multi-tenant SaaS ────────────┐  no external users → no tenants.
  │                                │  cutting it removes app_id-keyed
  │                                │  tenancy from aptkit entirely.
  ├─ RLS / auth ───────────────────┤  no users, no auth boundary to
  │                                │  enforce. (buffr is single-operator.)
  ├─ hosted-provider default ──────┤  local-first is the POINT. cloud
  │                                │  providers exist as adapters, never
  │                                │  the default — the default makes no
  │                                │  cloud call.
  ├─ distributed / horizontal scale┤  one operator, one laptop. no queue
  │                                │  infra, no replication, no LB.
  ├─ native-tool models ───────────┤  Gemma has no tool-calling; the
  │                                │  emulation IS the interesting work.
  │                                │  designing for native-tool models
  │                                │  would skip the hard part.
  └─ >1 consumer (a third app) ────┘  the premise is validated at TWO
                                      repos. a third proves nothing new
                                      yet — it's expansion, not validation.
```

- **EVIDENCE:** "no SQL/relational DB *in this repo*"; the persistent `agents` schema (documents/chunks/conversations/messages/profiles, **app_id-keyed**) lives in buffr, not aptkit (`context.md` "Data model"). Multi-tenancy was pushed out of the core on purpose.
- **EVIDENCE:** the local default makes no cloud call; cloud SDKs are swappable adapters behind `ModelProvider` (`context.md` stack + seams).
- **EVIDENCE:** no distributed-scale infra anywhere in the portfolio — `me.md` names this gap honestly ("not in your portfolio yet").

## The cuts inside the scope — what got trimmed even in-ring

These aren't non-goals (whole capabilities excluded); they're **trims** — places where the slice stayed narrow on purpose:

```
  IN-SCOPE TRIMS — narrow on purpose

  • RAG corpus: SMALL + REAL, not large.  enough to score
    precision@k / recall@k meaningfully, not a benchmark suite.
  • memory: BUILT but NOT WIRED into any aptkit agent.  buffr's
    session runtime wires it; aptkit ships the capability unused.
  • OpenAI cost ledger: covers gpt-4.1-* ONLY.  priced what's
    used, not every model.
  • one agent shape, reused 6×: capability = prompt pkg + tool
    policy + loop config + validator.  the RAG agent is the 6th
    instance, not a 6th architecture.
```

- **EVIDENCE:** memory is built but "no aptkit agent wires memory yet; buffr's session runtime does" (`context.md` seams). The OpenAI ledger covering only `gpt-4.1-*` is named in `context.md` "Notes / open items." The capability shape reused six times is `context.md` "Architecture seams."

▸ The trims are the honest part. Shipping memory *unwired* and pricing *only the model in use* are the marks of someone scoping to validate a premise, not to fill a feature matrix.

## Why this is the *smallest* scope, not just *a* scope

A reviewer's sharpest scope question is "could you have validated the premise with less?" The answer:

```
  could-we-cut-more test

  drop ring 1 (spike)?    → no. building the packages before
                            proving local Gemma runs the loop risks
                            weeks of work on an impossible substrate.
  drop ring 3 (consumer)? → no. without a SECOND repo consuming the
                            bundle, "reusable" is an assertion. the
                            premise is literally untested.
  drop evals?             → no. without precision@k / rubric-judge,
                            "RAG works" has no observable definition
                            (see 04). you'd be shipping a vibe.
  drop the 5 analytics    → these PREDATE the centralization premise
  agents?                   (extracted from Blooming Insights). they're
                            the raw material, not the validating slice —
                            but they're sunk, not added scope.
```

The slice is minimal: remove any ring and the premise stops being provable. That's the test for "smallest useful."

## See also

- `01-problem-brief.md` — the premise and its evidence ladder
- `03-options-and-opportunity-cost.md` — why building this slice beat adopting a framework
- `04-success-metrics-and-feedback-loop.md` — how "it worked" becomes observable
