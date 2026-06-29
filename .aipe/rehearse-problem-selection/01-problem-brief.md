# Problem Brief

The core case, in the spec's answer order: pain → evidence → why now → beneficiaries → constraints. Coach posture — every claim is labelled **EVIDENCE** (grounded in a repo file or context) or **INFERENCE** (a reasonable read that a reviewer could push on). Where the evidence is thin, the brief produces the **discovery question** instead of inventing the answer.

## 1. The operational problem — who feels what pain

```
  THE PAIN — re-wiring the same plumbing, welded to one vendor

  app #1 (AdvntrCue)        app #2 (buffr)         app #N (next one)
  ┌──────────────────┐     ┌──────────────────┐    ┌──────────────────┐
  │ Next.js          │     │ React Native     │    │ ???              │
  │ pgvector         │     │ ???              │    │ ???              │
  │ GPT-4 (welded)   │     │ ???              │    │ ???              │
  │ bespoke RAG loop │     │ bespoke RAG loop │    │ bespoke RAG loop │  ← rebuilt
  │ bespoke tool-call│     │ bespoke tool-call│    │ bespoke tool-call│    every
  └──────────────────┘     └──────────────────┘    └──────────────────┘    time
        ▲                         ▲                        ▲
        └──── no shared layer; each app re-derives the substrate ────┘
```

**The pain:** Every AI app Rein builds re-derives its own RAG pipeline, its own agent loop, its own tool-calling glue — and each one is welded to a single cloud vendor's SDK. Swap the vendor and you rewrite the app; start a new app and you rebuild the plumbing.

- **EVIDENCE:** AdvntrCue is a bespoke `Next.js + pgvector + GPT-4 + Drizzle + Netlify Functions` stack with a hand-rolled RAG + tool-calling + session-memory layer (`me.md` system-design portfolio table; `context.md` "extracted from working apps"). The vendor is welded in — GPT-4 is the model, not *a* model behind a contract.
- **INFERENCE:** that the *next* app would repeat the cost. This is a forward-looking claim, not yet a second data point at the time the decision was made. The discovery question that retires it: *does a second app actually reuse the layer without re-wiring?* — and `02`/`04` show buffr now answers it.

▸ The pain is concrete and singular at decision time: **one app proved the welded-bespoke pattern; the cost of repeating it is the problem.**

## 2. Evidence and current cost — what the repo proves

The honest split. Some of this is hard repo evidence; some is the inference the evidence supports.

```
  EVIDENCE LADDER — strongest at the bottom (shipped + verified)

  ┌─ inference ───────────────────────────────────────────────┐
  │  "future apps will keep paying the re-wiring tax"          │  weakest
  ├─ evidence (decision-time) ────────────────────────────────┤
  │  AdvntrCue is bespoke + vendor-welded (one data point)     │
  ├─ evidence (built) ────────────────────────────────────────┤
  │  provider-neutral core exists: ModelProvider.complete()    │
  │  + EmbeddingProvider / VectorStore contracts               │
  ├─ evidence (built + reused) ───────────────────────────────┤
  │  memory pkg reuses the SAME retrieval contracts, zero new  │
  │  infra (the contracts were the right boundary)             │
  ├─ evidence (shipped + verified) ───────────────────────────┤
  │  buffr consumes @rlynjb/aptkit-core@^0.4.1 and swaps        │  strongest
  │  InMemoryVectorStore → PgVectorStore on the SAME contract  │
  └────────────────────────────────────────────────────────────┘
```

- **EVIDENCE (built):** the provider-neutral core exists. Everything depends on `ModelProvider.complete()`, never a vendor SDK directly; RAG runs behind `EmbeddingProvider` + `VectorStore` contracts (`packages/retrieval/src/contracts.ts`, lines 22 + 33). `context.md` "Architecture seams."
- **EVIDENCE (built + reused):** the episodic memory package is a *second consumer* of the exact same `EmbeddingProvider`/`VectorStore` contracts — `remember` is the index path, `recall` is the query path — with **zero new infrastructure** (`packages/memory`, `context.md` calls this "the strongest evidence the contracts were the right boundary"). A contract reused without modification by an unplanned second consumer is the clearest signal the boundary was real, not speculative.
- **EVIDENCE (shipped + verified):** buffr depends on `"@rlynjb/aptkit-core": "^0.4.1"` (`/Users/rein/Public/buffr/package.json`) and implements the durable `PgVectorStore` against the same `VectorStore` contract (`/Users/rein/Public/buffr/src/pg-vector-store.ts`), tested at `/Users/rein/Public/buffr/test/pg-vector-store.test.ts`.

**Current cost (honest):** the cost is *not* dollars or user churn — there are no users. The cost is **Rein's engineering time, paid once per app, to re-derive plumbing**, plus the **lock-in cost** of a vendor-welded app that can't move models. Both are real; neither is large in absolute terms, because the portfolio is small.

## 3. Why now

```
  WHY NOW — three clocks that line up

  career clock   ──►  the frontend → AI pivot needs a portfolio
                      artifact NOW, not after the next job
  capability clock ─► local models (Gemma via Ollama) became
                      good enough to run an agent loop offline
  cost clock     ──►  AdvntrCue proved the welded pattern; the
                      next app would compound it if not stopped
```

- **EVIDENCE:** the deliberate frontend → AI pivot is the spine of `me.md` ("now → next: AI engineer"). The portfolio is explicitly the case for the combination. A portfolio artifact has a *deadline shape* — it's worth most before the next role, not after.
- **EVIDENCE:** local Gemma via Ollama is wired and working (`packages/providers/gemma/src/gemma-provider.ts`; emulated tool-calling because Gemma has none — `context.md`). The local-first option is only viable *because* local models crossed a usability line; building this two years earlier would have meant a cloud-only substrate.
- **INFERENCE:** that "the next app would compound the cost" is forward-looking — the same inference flagged in §1, surfaced here as the *why-now* pressure. Discovery question already answered by buffr.

▸ The why-now that holds hardest in a review room is the **career clock**: the pivot is happening, and a build-from-scratch substrate is a sharper proof of AI-engineering depth than a wired-together framework demo.

## 4. Beneficiaries and exclusions

```
  WHO BENEFITS — all three are Rein, in different roles

  ┌─ Rein the app-builder ─────┐   reuses aptkit across apps;
  │  buffr already consumes it │   no re-wiring per app
  └────────────────────────────┘
  ┌─ Rein the candidate ───────┐   portfolio artifact proving the
  │  frontend → AI pivot proof │   AI-engineering pivot
  └────────────────────────────┘
  ┌─ Rein the learner ─────────┐   built the substrate to
  │  RAG / agent loop / evals  │   understand the substrate
  │  from scratch              │   (me.md: hands-on = real)
  └────────────────────────────┘

  EXCLUDED ON PURPOSE:
  ✗ external users / customers      ✗ a team of other engineers
  ✗ multi-tenant SaaS tenants       ✗ open-source contributors at scale
```

- **EVIDENCE:** the only live consumer is buffr — one repo, Rein's (`context.md` companion-repo note; buffr `package.json`). `me.md` establishes the pivot and the hands-on learning loop ("the RAG pattern isn't real until you shipped AdvntrCue").
- **Honest exclusion:** there are **no external beneficiaries**, and that is the design, not a gap. The brief does not invent them.

## 5. Constraints — what's actually fixed

```
  CONSTRAINTS — the walls the solution had to fit inside

  ┌─ TECHNICAL ──────────────────────────────────────────────┐
  │  • published API is a compatibility contract (semver      │
  │    0.4.x) — re-exported names can't break host apps       │
  │  • core must NOT import app-specific product logic         │
  │  • ModelProvider / VectorStore / EmbeddingProvider shape   │
  │    changes ripple across packages + buffr's PgVectorStore  │
  │  • embedding dimension is a one-way door (768; mismatch    │
  │    throws at wiring time)                                  │
  └────────────────────────────────────────────────────────────┘
  ┌─ TIME / PEOPLE ──────────────────────────────────────────┐
  │  • one engineer, part-time, alongside IK frontend program │
  └────────────────────────────────────────────────────────────┘
  ┌─ MIGRATION ──────────────────────────────────────────────┐
  │  • buffr binds the slots at runtime; aptkit stays          │
  │    deployment-agnostic — the seam must survive the swap    │
  └────────────────────────────────────────────────────────────┘
```

- **EVIDENCE:** the must-not-change list — published API as compatibility contract, no app logic in core, the load-bearing contracts that ripple to buffr, the one-way dimension door — is all in `context.md` "Must-not-change constraints" + "Data model."
- **EVIDENCE (people/time):** one engineer, pivoting, in parallel with IK's frontend program (`me.md`).
- **No org constraints invented.** There is no team, no roadmap, no compliance regime. A reviewer who asks "what did the org require?" gets: *there is no org — this is personal tooling.*

## The discovery questions that remain

Where evidence was thin, these are the questions a reviewer should ask — and where each now stands:

```
  Q: will a SECOND app reuse the layer without re-wiring?
     → ANSWERED. buffr consumes the bundle + swaps one contract.
  Q: is provider-neutrality real or cosmetic?
     → ANSWERED (internally). memory reuses the contracts with
        zero new infra; local Gemma runs the loop with no cloud call.
  Q: does the published bundle install clean in a fresh consumer?
     → PARTIALLY OPEN. tracked as a success metric in 04 (clean-clone
        npm install builds in buffr) — verify, don't assume.
  Q: will a THIRD app ever exist to justify "reusable"?
     → OPEN BY DESIGN. >1 consumer is a non-goal (see 02). The
        premise is validated at two repos, not promised at N.
```

## See also

- `02-scope-cuts-and-non-goals.md` — the slice that validated this, and what was cut
- `03-options-and-opportunity-cost.md` — the build-vs-adopt fork
- `/Users/rein/Public/aptkit/packages/retrieval/src/contracts.ts` — the load-bearing contracts
- `/Users/rein/Public/buffr/src/pg-vector-store.ts` — the live swap
