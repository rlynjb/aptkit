# Scope, Cuts, and Non-Goals

*Brief-answers 7 and 8: the narrowest slice that validates the premise, and
everything deliberately left unbuilt.*

The premise to validate: **a provider-neutral, local-first contract lets one
substrate serve more than one app without a rewrite.** The smallest scope
that actually tests that — not a feature wishlist.

---

## 7. Smallest useful scope

The narrowest slice runs as a three-step pipeline. Each step de-risks the
next; you don't proceed until the prior one holds.

```
  Smallest useful scope — three steps, each de-risks the next

  ┌─ STEP 1: DE-RISK SPIKE ──────────────────────────────────┐
  │ prove the hard parts work at all:                        │
  │  • local Gemma via Ollama, tool-calling EMULATED         │
  │    (Gemma has none) — packages/providers/gemma           │
  │  • RAG from scratch: embed → chunk → store → search      │
  │    → rank — packages/retrieval                           │
  │ done when: a grounded answer comes back locally          │
  └────────────────────────────┬───────────────────────────────┘
                               │  spike holds →
  ┌─ STEP 2: PACKAGES ─────────▼───────────────────────────────┐
  │ extract the proven parts behind contracts:                │
  │  • ModelProvider.complete()                               │
  │  • EmbeddingProvider + VectorStore                        │
  │  • bundle as @rlynjb/aptkit-core (16 pkgs)                │
  │ done when: clean InMemoryVectorStore RAG runs + evals     │
  └────────────────────────────┬───────────────────────────────┘
                               │  contracts hold →
  ┌─ STEP 3: ONE CONSUMER LIVE ▼───────────────────────────────┐
  │ prove the contract crosses a repo boundary:               │
  │  • buffr installs the published bundle                    │
  │  • buffr supplies PgVectorStore implements VectorStore    │
  │    (buffr/src/pg-vector-store.ts:19, session.ts:41)       │
  │ done when: InMemory→Pg swap is ONE line, buffr runs RAG   │
  └────────────────────────────────────────────────────────────┘
```

The slice is deliberately one consumer deep. Step 3 is the validation:
if a *different* repo can swap the in-memory store for Postgres/pgvector
by implementing one contract, the premise holds. A second app would add
confidence but not change the answer — so it's a non-goal, not part of the
minimum slice.

┃ Why this is the *smallest* useful scope: drop step 3 and you've built a
┃ library nobody consumes — the "reusable" claim is untested. Drop step 1
┃ and you've designed contracts against an unproven mechanism. The three
┃ steps are the irreducible kernel; remove any one and the premise goes
┃ unvalidated.

---

## 8. Non-goals and cuts

Each is a real capability deliberately NOT built. For each: what it would
cost, and why cutting it is correct *for this problem*.

```
  The non-goals — what NOT to build, and why the cut is right

  NON-GOAL                  WHY CUT (for personal-tooling + portfolio)
  ────────                  ──────────────────────────────────────────
  multi-tenant SaaS         no tenants exist. Multi-tenancy is the most
                            expensive thing to retrofit AND the most
                            expensive to build speculatively. Cut.

  RLS / auth                no untrusted users. buffr is single-operator,
                            local-first. Auth solves a problem this
                            substrate does not have.

  hosted provider default   the whole point is local-first + neutral. A
                            hosted default would re-weld to a vendor —
                            the exact pain being solved. local Gemma is
                            the default; cloud is opt-in via env key.

  distributed scale         solo, no sustained traffic, no SLA. Queue
                            infra / replication / load balancing solve
                            scale problems that don't exist here.

  native-tool models        scoped to Gemma-via-Ollama, which has NO
                            native tool-calling — so tool-calling is
                            EMULATED. Supporting native-tool models is a
                            later drop-in, not part of validating the core.

  >1 consumer               buffr is the one consumer. A second proves
                            generality but isn't needed to validate the
                            contract crosses ONE boundary. Deferred — it
                            is the open discovery question from 01.
```

## The cut line in one picture

```
  What's inside the line vs deliberately outside

  ┌─ BUILT (validates the premise) ──────────────────────────┐
  │  provider-neutral ModelProvider contract                  │
  │  EmbeddingProvider + VectorStore contracts                │
  │  RAG from scratch (InMemoryVectorStore + Ollama embed)    │
  │  local Gemma provider (emulated tool-calling)             │
  │  eval harness (precision@k / recall@k / rubric-judge)     │
  │  ONE published bundle + ONE live consumer (buffr/Pg)      │
  └────────────────────────────────────────────────────────────┘
                          ╪  the cut line  ╪
  ┌─ NOT BUILT (deliberate, see table above) ────────────────┐
  │  multi-tenant · RLS/auth · hosted default · scale ·       │
  │  native-tool models · second consumer                     │
  └────────────────────────────────────────────────────────────┘
```

▸ The cut line is drawn at "what proves a neutral contract serves more than
  one app." Everything left of it is load-bearing for that proof.
  Everything right of it solves problems a personal-tooling + portfolio
  artifact does not have — and would trade build time for capability that
  no user is waiting on.
