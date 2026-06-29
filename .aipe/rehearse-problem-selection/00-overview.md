# Problem Selection — Overview

The one-page orientation. This brief argues **why aptkit deserved to get built before any line of it got designed** — the human layer that sits in front of the design doc, the demo, and the interview defense.

Coach posture: the goal isn't to make the project sound impressive. It's to rehearse the *honest* case, so that when a skeptical reviewer (a staff engineer, a hiring panel, future-Rein six months from now) asks "why did you build a framework instead of using one off the shelf?", the answer holds without flinching.

## The honest frame

```
  WHAT THIS PROBLEM IS — and what it is NOT

  ┌─ IS ──────────────────────────────────────────────┐
  │  • a personal-tooling problem (Rein's own apps)    │
  │  • a portfolio problem (frontend → AI pivot)       │
  │  • a learning problem (build the substrate to      │
  │    understand the substrate)                       │
  └────────────────────────────────────────────────────┘
  ┌─ IS NOT ──────────────────────────────────────────┐
  │  • a product with external users                   │
  │  • a market opportunity / startup thesis           │
  │  • an org mandate or a team's roadmap              │
  └────────────────────────────────────────────────────┘
```

There are **no external users**, by design. Every "beneficiary" in this brief is Rein in one of her roles: the app builder, the job candidate, the learner. Pretending otherwise would be the single fastest way to lose a review room. The strength of this problem is not its market — it's that the cost it removes is *real and measured in Rein's own repos*, and the artifact it produces is *evaluated, swappable, and shipped to one live consumer.*

## The fork

```
  THE DECISION — build the substrate vs adopt a framework

                    ┌─────────────────────────┐
   the pain ───────►│  build personal-agent   │──► aptkit (chosen)
   (re-wiring RAG   │  substrate (aptkit)     │
    every app,      └─────────────────────────┘
    welded to one   ┌─────────────────────────┐
    cloud vendor)   │  adopt off-the-shelf    │──► LangChain / LlamaIndex
                    │  agent framework        │    or a turnkey hosted agent
                    └─────────────────────────┘
                    ┌─────────────────────────┐
                    │  do nothing             │──► keep re-wiring per app
                    └─────────────────────────┘
```

**Chosen: build (aptkit).** The opportunity cost is real and named in `03-options-and-opportunity-cost.md` — weeks of substrate work that a framework would have given for free, paid deliberately to buy learning depth, local-first control, provider-neutrality, and a portfolio artifact that proves the AI-engineering pivot.

## The smallest useful scope that validated the premise

```
  de-risk spike  ──►  the 16 packages  ──►  one live consumer
  (does provider-      (provider-neutral     (buffr swaps
   neutral +           core, RAG from         InMemoryVectorStore
   local Gemma         scratch, evals)        → PgVectorStore on
   actually work?)                            Supabase pgvector)
```

The premise — "a provider-neutral, local-first agent layer can be reused across my apps without re-wiring" — is validated the moment **a second repo (buffr) consumes the published bundle and swaps one contract implementation without touching agent code.** That's the proof. Everything past it is expansion, not validation.

## The files in this brief

```
  00-overview.md                       ← you are here
  01-problem-brief.md                  pain · evidence · why now · beneficiaries · constraints
  02-scope-cuts-and-non-goals.md       smallest useful scope + what was deliberately NOT built
  03-options-and-opportunity-cost.md   build vs adopt vs do-nothing, each with its cost
  04-success-metrics-and-feedback-loop.md  observable outcomes + the loop that closes
  05-skeptical-reviewer-questions.md   the review-room questions and the answers that hold
```

## The 10-answer order (where each answer lives)

```
   1. user / operational problem      → 01  (pain)
   2. evidence + current cost         → 01  (evidence; evidence vs inference labelled)
   3. why now                         → 01  (why now)
   4. beneficiaries + exclusions      → 01  (beneficiaries)
   5. constraints                     → 01  (constraints)
   6. options (incl. do nothing)      → 03
   7. smallest useful scope           → 02
   8. non-goals + cuts                → 02
   9. success metrics + feedback loop → 04
  10. risks + objections              → 05
```

▸ Read in order. `01` makes the case there's a problem worth money. `02` and `03` prove the scope and the fork were chosen, not stumbled into. `04` defines what "it worked" means in observable terms. `05` is the rehearsal — the room where the case gets attacked.

## See also

- `01-problem-brief.md` — the core case
- `/Users/rein/Public/aptkit/.aipe/project/context.md` — the live repo grounding
- `/Users/rein/Public/buffr/src/pg-vector-store.ts` — the one live consumer's contract implementation
