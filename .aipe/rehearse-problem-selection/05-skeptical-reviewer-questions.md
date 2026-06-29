# Skeptical Reviewer Questions

Answer 10: the review room. Coach posture — these are the questions a staff engineer or hiring panel *will* ask, sharpened to their hardest form, with the answer that holds. The format mirrors interview defense: the question, the trap inside it, the answer, and a one-line anchor you can say out loud. Where the honest answer is "I don't know yet," the brief says so and names the discovery question — a defended "I don't know" beats a bluffed "yes."

```
  HOW TO READ THIS — each question is a trap + a hold

  ┌─ the question ──┐   what they ask
  ┌─ the trap ──────┐   the assumption that sinks a weak answer
  ┌─ the hold ──────┐   the answer that survives
  ┌─ anchor ────────┐   the one line you say out loud
```

## Q1 — "Why build a framework instead of using LangChain or LlamaIndex?"

**The trap:** they want you to defend building as universally correct. It isn't. Defend it *for this problem*.

**The hold:** because the dominant axes for this problem are **learning depth and portfolio signal**, not time-to-ship — and on those axes, adopting a framework loses (`03`, Option B). A framework does the interesting parts *for* you: the emulated tool-calling for Gemma (which has none), the dimension-mismatch one-way door, the precision@k harness. For a frontend → AI pivot, *not* building those is the wrong trade. And critically — the same scoring picks LangChain the moment the problem has external users and a deadline. The decision is contingent on the problem's shape, which is exactly why it's defensible.

> ┃ anchor: "For a product with users I'd reach for LangChain. For a pivot
> ┃ portfolio with no user deadline, building the substrate IS the deliverable."

## Q2 — "There are no users. How is this a problem worth solving?"

**The trap:** they want you to invent users or a market. Don't. The instant you fabricate a user, the whole brief is suspect.

**The hold:** it's a personal-tooling + portfolio problem, stated honestly — no external users, by design (`00`, `01`). The cost it removes is real and measured in Rein's own repos: re-deriving RAG/agent plumbing per app, and vendor lock-in per app (AdvntrCue is the evidence). The value it creates is a portfolio artifact for the pivot. Both are legitimate problems; neither requires a user. The brief that *invents* a user to look more serious is the one that fails the room.

> ┃ anchor: "No users is the honest frame, not a gap. The cost is my
> ┃ engineering time and lock-in; the value is the pivot portfolio."

## Q3 — "How do you know it works if you can't measure user outcomes?"

**The trap:** "no users" implies "no metrics." It doesn't.

**The hold:** the metrics measure quality and reuse, not user behavior (`04`). Quality: `scorePrecisionAtK` / `scoreRecallAtK` over a small real corpus + `rubric-judge` on grounded answers. Reuse: the one-line `VectorStore` swap verified across two repos (`InMemoryVectorStore` → `PgVectorStore`), and a clean-clone `npm install` building in buffr. These are observable — you run a scorer and read a number, or you run a test and read pass/fail. The feedback loop (live run → artifact → eval → promote → replay) keeps them true as the code changes.

> ┃ anchor: "Success is a number from precision@k and a passing swap test
> ┃ across two repos — not a retention chart I don't have."

## Q4 — "Isn't 'provider-neutral' just speculative abstraction you'll never use twice?"

**The trap:** the classic YAGNI attack — abstractions built for a second consumer that never arrives.

**The hold:** it already got used twice, two different ways, and one of them was unplanned. (1) The episodic memory package is a *second consumer* of the exact `EmbeddingProvider`/`VectorStore` contracts with **zero new infrastructure** — `remember` is the index path, `recall` the query path (`packages/memory`; `context.md` calls this "the strongest evidence the contracts were the right boundary"). (2) buffr implements `PgVectorStore` against the same `VectorStore` contract and consumes the published bundle. An abstraction reused by an *unplanned* second consumer without modification isn't speculative — it's load-bearing.

> ┃ anchor: "The memory engine reuses the retrieval contracts with zero new
> ┃ infra. That's the proof the boundary was real, not guessed."

## Q5 — "Why ship code (the memory package) that no agent in this repo even uses?"

**The trap:** unused code looks like scope creep or gold-plating.

**The hold:** it's a deliberate trim, not a leak (`02`). Memory is built in aptkit but *wired* by buffr's session runtime — aptkit stays deployment-agnostic; buffr fills the slot. Shipping the capability unwired is consistent with the whole design: the core provides contracts and capabilities; the consumer binds them. The same is true of cloud providers (adapters present, local is the default) and the OpenAI cost ledger (prices only `gpt-4.1-*`, the model actually used).

> ┃ anchor: "aptkit ships the capability; buffr wires it. Unwired-in-core is
> ┃ the deployment-agnostic design, not dead code."

## Q6 — "You scoped 16 packages. Isn't that over-built for a personal tool?"

**The trap:** package count reads as complexity-for-its-own-sake.

**The hold:** the count is a packaging decision, not a complexity one — 16 internal packages re-export into **one** published bundle (`@rlynjb/aptkit-core@0.4.1`), inlined via `bundledDependencies` so a consumer runs one `npm install` (`context.md` publishing). The capability shape is reused, not multiplied: capability = prompt package + tool policy + agent loop config + validator, and the RAG agent is the *6th instance of one shape*, not a 6th architecture. The smallest-scope test in `02` shows each ring is load-bearing — remove any and the premise stops being provable.

> ┃ anchor: "16 packages, one bundle, one install. The agent shape is reused
> ┃ six times, not reinvented six times."

## Q7 — "What's the weakest part of this case?"

**The trap:** they want to see if you'll defend everything equally. Don't — name the soft spot first; it buys credibility for the rest.

**The hold (named honestly):**

```
  WEAK SPOTS — ranked, each with its discovery question

  1. "the tax compounds per app" is INFERENCE, not measured.
     at decision time there was ONE bespoke app (AdvntrCue), not
     a trend.  → discovery Q: does a 3rd app reuse it? (open by
     design — >1 consumer is a non-goal)

  2. clean-clone install is PARTIALLY OPEN — flagged "verify,
     don't assume" (01/04).  → run it; read the exit code.

  3. the feedback loop is open at ONE node: rubric-improvement
     has no replay:promoted script in the root pipeline
     (context.md notes).  → wire it to fully close the loop.
```

The strongest version of the case leans on what's *shipped and verified* (the two-repo swap, the memory reuse), not on the forward-looking inference that the cost compounds.

> ┃ anchor: "The weakest claim is that the re-wiring cost compounds — that's
> ┃ a one-data-point inference. The case rests on the verified two-repo swap."

## Q8 — "Six months from now, what tells you this was the right call?"

**The trap:** they want a vanity metric. Give a falsifiable one.

**The hold:** two falsifiable signals. (1) **The pivot lands** — the portfolio artifact does its job in an AI-engineering interview loop (the artifact's whole purpose, `me.md`). (2) **The substrate survives contact with change** — a model swap, an embedding-provider swap, or a third app binds the existing contracts without a core rewrite, *and* precision@k on the promoted fixtures doesn't regress. If instead every reuse requires reopening the contracts, the abstraction was wrong and "do nothing" (Option C) would have been cheaper.

> ┃ anchor: "Right call if the next reuse is a binding, not a rewrite — and
> ┃ if the pivot portfolio actually opens doors."

## The room, in one frame

```
  THE DEFENSE THAT HOLDS — lead with shipped, name the soft spot

  ┌─ lead with ──────────────────────────────────────────────┐
  │  SHIPPED + VERIFIED:                                       │
  │   • two-repo VectorStore swap (InMemory → Pg, Supabase)   │
  │   • memory reuses retrieval contracts, zero new infra      │
  │   • local Gemma runs the loop, no cloud call               │
  └────────────────────────────────────────────────────────────┘
  ┌─ then concede ───────────────────────────────────────────┐
  │  HONEST SOFT SPOTS:                                        │
  │   • "cost compounds" is 1-data-point inference             │
  │   • clean-clone install: verify, don't assume              │
  │   • loop open at one node (rubric-improvement)             │
  └────────────────────────────────────────────────────────────┘
  ┌─ and frame ──────────────────────────────────────────────┐
  │  the BUILD call is contingent on a portfolio problem with  │
  │  no user deadline. different problem → different call.      │
  └────────────────────────────────────────────────────────────┘
```

▸ The room is won by the order: shipped evidence first, conceded soft spots second, contingent framing third. A reviewer trusts the engineer who names the weak claim before they have to ask.

## See also

- `01-problem-brief.md` — the evidence-vs-inference ladder the answers draw on
- `03-options-and-opportunity-cost.md` — the build-vs-adopt fork defended in full
- `04-success-metrics-and-feedback-loop.md` — the observable metrics behind Q3 and Q8
