# Problem Selection — Overview

*Why aptkit deserved to be built before any line of it was designed.*

This is the human layer that sits *before* the design doc. The design doc
answers "how did you build the provider-neutral core." This brief answers
the harder question a skeptical reviewer asks first: **"why build a
substrate at all instead of `npm install`-ing one?"**

Read these in order. The numbered files map 1:1 to the ten problem-brief
answers the spec requires.

```
  Where this brief sits in the rehearse family

  ┌─ THIS BRIEF ──────────────────────────────────────────────┐
  │  rehearse-problem-selection   WHY this problem deserves    │ ← here
  │                                investment                  │
  └────────────────────────────┬───────────────────────────────┘
                               │  once "why" holds, then:
  ┌────────────────────────────▼───────────────────────────────┐
  │  rehearse-design-doc          HOW the decision is written   │
  │  rehearse-hackathon-demo      HOW the value is shown        │
  │  rehearse-interview-defense   HOW the work is defended      │
  └──────────────────────────────────────────────────────────────┘
```

## The honest frame (read this first)

┃ aptkit has **no external users**. By design. It is personal tooling plus
┃ a portfolio artifact for a frontend→AI pivot. There is no revenue, no
┃ org mandate, no customer ticket. Pretending otherwise would be the
┃ fastest way to fail the skeptical-reviewer block.

So this brief does not invent a market. It justifies investment on the two
honest grounds that *do* hold:

▸ **Operational pain (real, evidenced):** every AI app Rein has shipped
  re-wired its own RAG/agent plumbing and welded itself to one cloud
  vendor. AdvntrCue is the proof — bespoke Next.js + pgvector + GPT-4,
  none of it reusable by the next app.

▸ **Portfolio leverage (the pivot):** the substrate *is* the artifact. A
  provider-neutral core with from-scratch RAG and an eval harness is a
  stronger frontend→AI signal than another vendor-glued demo app.

Where evidence is thin, the brief says so and writes the discovery
question instead of faking a number.

## The strategic fork in one diagram

The whole brief turns on one decision. Here it is up front.

```
  The build-vs-adopt fork

                        ┌─────────────────────────┐
                        │  recurring pain:        │
                        │  every app re-wires RAG │
                        │  + welds to one vendor  │
                        └────────────┬────────────┘
                                     │
                 ┌───────────────────┼───────────────────┐
                 ▼                   ▼                   ▼
         ┌──────────────┐   ┌──────────────┐   ┌──────────────────┐
         │  DO NOTHING  │   │  ADOPT a     │   │  BUILD the       │
         │  keep        │   │  framework   │   │  substrate       │
         │  re-wiring   │   │ (LangChain / │   │  (aptkit)        │ ★ chosen
         │  per app     │   │  LlamaIndex) │   │                  │
         └──────────────┘   └──────────────┘   └──────────────────┘
           cost: pain        cost: learning     cost: build time +
           compounds         + control go to    you own the
           every new app     the framework      maintenance
```

★ **Chosen: BUILD.** Named opportunity cost: the weeks of build-and-maintain
time that adopting LangChain/LlamaIndex would have spent for you — and the
turnkey RAG those frameworks hand you on day one. Full reasoning in
`03-options-and-opportunity-cost.md`.

## The three success metrics (the whole bet in three numbers)

These are how you'll know the substrate earned its keep. All three are
grounded in code that exists today — see `04-success-metrics-and-feedback-loop.md`.

```
  Did the substrate earn its keep? — three checks

  ┌─ 1. RETRIEVAL QUALITY ────────────────────────────────────┐
  │  precision@k / recall@k over a small REAL corpus          │
  │  evidence: scorePrecisionAtK / scoreRecallAtK             │
  │            (packages/evals/src/precision-at-k.ts)         │
  └────────────────────────────────────────────────────────────┘
  ┌─ 2. ANSWER QUALITY ───────────────────────────────────────┐
  │  rubric-judge scores grounded/cited answers               │
  │  evidence: packages/evals/src/rubric-judge.ts             │
  └────────────────────────────────────────────────────────────┘
  ┌─ 3. THE SWAP HELD ────────────────────────────────────────┐
  │  one-line VectorStore swap (InMemory → Pg) verified       │
  │  across TWO repos; clean-clone npm install builds in buffr│
  │  evidence: PgVectorStore implements VectorStore           │
  │            (buffr/src/pg-vector-store.ts:19), wired in     │
  │            buffr/src/session.ts:41                         │
  └────────────────────────────────────────────────────────────┘
```

Metric 3 is the load-bearing one. The first two say "the RAG works." The
third says "the *substrate* works" — the entire premise of building over
adopting. If the contract didn't let buffr swap `InMemoryVectorStore` for
`PgVectorStore` in one line across a repo boundary, the build was a waste
and adopt was the right call.

## Reading order

```
  00-overview.md ......................... you are here
  01-problem-brief.md .................... pain · evidence · why now · beneficiaries · constraints
  02-scope-cuts-and-non-goals.md ......... smallest useful scope · what NOT to build
  03-options-and-opportunity-cost.md ..... do-nothing / adopt / build · the named costs
  04-success-metrics-and-feedback-loop.md  the three metrics · how the loop closes
  05-skeptical-reviewer-questions.md ..... the review-room questions that bite
```
