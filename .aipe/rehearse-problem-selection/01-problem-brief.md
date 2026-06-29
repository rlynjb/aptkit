# Problem Brief

*The core: who hurts, what proves it, why now, who benefits, what constrains.*

This file covers brief-answers 1–5 (pain · evidence · why-now · beneficiaries
· constraints). Options live in `03`, scope in `02`, metrics in `04`.

---

## 1. The problem — who experiences what pain

One person: Rein. The pain is operational, and it repeats.

```
  The recurring pain — re-wiring + vendor-welding, per app

  app 1 (AdvntrCue)        app 2 (next)            app 3 (next)
  ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
  │ bespoke RAG      │    │ bespoke RAG      │    │ bespoke RAG      │
  │ pgvector         │    │ ??? rewire       │    │ ??? rewire       │
  │ GPT-4 (welded)   │    │ vendor (welded)  │    │ vendor (welded)  │
  └──────────────────┘    └──────────────────┘    └──────────────────┘
         │                       │                       │
         └── nothing reused ─────┴── nothing reused ──────┘
                    every app pays the plumbing cost again
```

Two distinct pains stacked on each other:

▸ **Re-wiring.** The RAG/agent plumbing — embed, chunk, store, retrieve,
  rank, loop, parse — gets rebuilt from scratch in each new app. None of
  it carries forward.

▸ **Vendor-welding.** Each app is soldered to one cloud vendor (GPT-4 in
  AdvntrCue). Swapping the model or the vector store means a rewrite, not
  a config change. There is no seam to swap at.

The second pain is the worse one, because it's the one a framework
*doesn't* fully solve and a from-scratch contract *does*.

---

## 2. Evidence vs inference

The spec demands these be distinguished. They are.

```
  EVIDENCE (in the repos, verifiable)        INFERENCE (labeled, not faked)
  ─────────────────────────────────         ──────────────────────────────
  AdvntrCue = bespoke Next.js +              "every future app would
    pgvector + GPT-4, none reusable          re-wire" — INFERENCE from one
    (me.md system-design portfolio;          data point (AdvntrCue). Honest:
    docs/personal-agent-packages.md)         n=1, not a trend line.

  aptkit ships ONE bundle                    "this saves time across apps"
    @rlynjb/aptkit-core@0.4.1,               — INFERENCE. Only ONE consumer
    16 internal packages                     (buffr) exists today. The
    (packages/core/package.json)             second app hasn't been built.

  buffr consumes the published bundle:       "the contract is the right
    "@rlynjb/aptkit-core": "^0.4.1"          boundary" — EVIDENCE, not
    (buffr/package.json)                     inference: @aptkit/memory reuses
                                             the SAME EmbeddingProvider/
  PgVectorStore implements VectorStore       VectorStore contracts with zero
    (buffr/src/pg-vector-store.ts:19),       new infra (context.md, seams).
    wired in buffr/src/session.ts:41         A second consumer of the
                                             contract already exists.
```

┃ The strongest evidence isn't the second *app* — it's the second
┃ *consumer of the contract*. `@aptkit/memory` reuses
┃ `EmbeddingProvider`/`VectorStore` (`remember` = the index path, `recall`
┃ = the query path) with no new infrastructure. That's the contract
┃ proving it was drawn at the right seam, inside the same repo, today.

**Discovery question still open** (where evidence is thin):

▸ *Does a genuinely different second app reuse the bundle without forking
  it?* buffr is the only external consumer. Until app #2 adopts
  `@rlynjb/aptkit-core` unmodified, "reusable across apps" stays an
  inference. The non-goal `>1 consumer` (see `02`) deliberately defers
  answering this.

---

## 3. Why now

Two things changed at once.

```
  The timing — why build it now, not before or later

  ┌─ pull: the pivot ────────────┐   ┌─ push: local models matured ──┐
  │ frontend → AI engineering    │   │ Gemma runs locally via Ollama │
  │ needs a portfolio artifact   │   │ (no key, no TLS, :11434)      │
  │ that is substrate, not       │   │ → local-first RAG is now      │
  │ another vendor-glued demo    │   │   actually viable             │
  └──────────────┬───────────────┘   └───────────────┬───────────────┘
                 └──────────────┬────────────────────┘
                                ▼
                    build the substrate now:
                    the pivot needs the artifact AND
                    local models make local-first real
```

▸ **The pivot is active now** (me.md: "this is where you are"). The
  portfolio needs an artifact that signals AI-engineering depth — a
  from-scratch RAG pipeline + eval harness + provider-neutral contracts
  reads stronger than a fifth CRUD-plus-LLM app.

▸ **Local models crossed the viability line.** Gemma-via-Ollama
  (`@aptkit/provider-gemma`, local HTTP `:11434`, emulated tool-calling)
  makes "local-first, provider-neutral" a buildable target, not a wish.
  The compounding cost: every additional welded app makes the eventual
  un-welding more expensive. Build the seam before app #2, not after.

---

## 4. Beneficiaries and exclusions

```
  Who benefits — and who is deliberately outside the line

  IN SCOPE (benefits)                    OUT OF SCOPE (deliberate)
  ─────────────────                      ──────────────────────────
  ▸ Rein's own apps that consume         ▸ external users / customers
    @rlynjb/aptkit-core                    (NONE exist — by design)
    (today: buffr)                       ▸ multi-tenant SaaS tenants
  ▸ Rein as portfolio owner              ▸ a team of contributors
    (the pivot artifact)                 ▸ anyone needing RLS/auth or a
  ▸ future Rein apps (INFERENCE —          hosted default
    not yet built)                       ▸ >1 consumer (deferred, see 02)
```

The honest beneficiary count is **one person, one consuming app**. The
brief does not inflate this.

---

## 5. Constraints

Visible from the repos and supplied context — not invented.

```
  The constraints box — what bounds the build

  ┌─ TECHNICAL ──────────────────────────────────────────────┐
  │ • TS monorepo, ESM-only, NodeNext, strict (tsconfig.base) │
  │ • published API is a SEMVER compatibility contract        │
  │   (@rlynjb/aptkit-core 0.4.x) — re-exported names frozen  │
  │ • core must NOT import app-specific product logic         │
  │   (the whole reason the monorepo exists)                  │
  │ • ModelProvider / EmbeddingProvider / VectorStore are     │
  │   load-bearing — shape changes ripple across packages     │
  │   AND across the repo boundary into buffr's PgVectorStore │
  └────────────────────────────────────────────────────────────┘
  ┌─ TIME / PEOPLE ──────────────────────────────────────────┐
  │ • solo developer, building alongside IK frontend program  │
  │ • no team, no on-call, no SLA                             │
  └────────────────────────────────────────────────────────────┘
  ┌─ PRODUCT ────────────────────────────────────────────────┐
  │ • deployment-agnostic core; buffr fills the deploy slots  │
  │   (Supabase/pgvector, agents schema, persistence)         │
  └────────────────────────────────────────────────────────────┘
```

┃ The tightest constraint is the published-API contract. Once
┃ `@rlynjb/aptkit-core@0.4.x` shipped and buffr pinned `^0.4.1`, the
┃ re-exported surface became a one-way door — buffr's `PgVectorStore
┃ implements VectorStore` breaks if the `VectorStore` shape changes. That
┃ constraint is *self-imposed* and it's the point: it's what forced the
┃ contract to be good before it was published.

There is **no organizational constraint** to report — no compliance, no
approval gate, no migration deadline. Saying so is more honest than
inventing one.
