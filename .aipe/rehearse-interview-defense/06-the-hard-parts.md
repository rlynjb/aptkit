# Chapter 6 — The hard parts

## Opening hook

This is the chapter where the interviewer stops testing whether you can describe your system and starts testing whether you *lived* in it. Three questions do most of the work: "what was the hardest bug?", "what part are you proudest of?", and "what part are you least confident defending?" The first two are easy to ramble. The third is where most candidates collapse — they hear "least confident" and start apologizing, and an apology reads as "I shipped something I don't understand."

Here is the reframe I want you holding the whole chapter: **none of these three questions is a trap.** The hardest-bug question rewards a debugger who reasons backward from a symptom. The proudest-part question rewards someone who can point at evidence that an abstraction was right. And the least-confident question — handled correctly — is the strongest signal in the whole loop, because naming a real limit with a plan reads as senior judgment, while faking confidence reads as a junior who got lucky. You built a RAG agent on a weak 9B local model. You have real answers to all three. Let's make them land.

## The chapter-opening diagram — the confidence map

Before the questions, here is the map of aptkit by how confidently you can defend each region — green you own cold, yellow you defend with a named limit, red you do not fake. The whole chapter is teaching you to stay standing in yellow and red.

```
  CONFIDENCE MAP — aptkit's hard parts, by how you defend each

  ┌─ GREEN: you own this cold ──────────────────────────────────┐
  │  • the retrieval-miss diagnosis (you read the trace          │
  │    backward, three layers from the symptom)                  │
  │  • matchesFilter fix + its regression test                   │
  │    (packages/retrieval/.../search-knowledge-base-tool.ts)    │
  │  • RAG + emulated tool-calling built FROM CONTRACTS          │
  │    (packages/providers/gemma, packages/agents/rag-query)     │
  │  • the drop-in: zero new control flow in runAgentLoop        │
  └─────────────────────────────────────────────────────────────┘
                          │  defend with a named limit
                          ▼
  ┌─ YELLOW: name the limit, why it was right, what's next ──────┐
  │  • no fine-tuning / no training (deliberate — eval-gated)    │
  │  • single-user, no RLS enforced in aptkit                    │
  │  • weak 9B Gemma needs guard rails (minTopK, parse-retry)    │
  └─────────────────────────────────────────────────────────────┘
                          │  do NOT fake — recover honestly
                          ▼
  ┌─ RED: outside your portfolio — recover, don't bluff ────────┐
  │  • Gemma's transformer internals / attention mechanics       │
  │  • distributed retrieval / sharded vector search at scale    │
  │  • the math of HNSW / ANN index internals                    │
  └─────────────────────────────────────────────────────────────┘
```

The move for the rest of the chapter: answer green with detail, yellow with a named limit and a plan, red with a clean recovery. Never let yellow drift into an apology, and never let red drift into a bluff.

```
┃ "Least confident to defend" is not a confession.
┃  It's where you prove you have judgment.
```

---

## Prompt 1 — the hardest bug: the retrieval miss

This is your best story in the whole book. Tell it as a *debugging* story, not a *fix* story — the interviewer wants to watch you reason, and the reasoning is the part that transfers.

```
┌─────────────────────────────────────────────────┐
│ THEY ASK                                         │
│   "What was the hardest bug you debugged on      │
│    this, and how did you find it?"               │
│                                                  │
│ WHAT THEY'RE TESTING                             │
│   Can you reason backward from a symptom to a    │
│   root cause that's several layers away? Do you  │
│   have observability you actually used, or did   │
│   you debug by guessing? Do you know the         │
│   difference between "the agent was wrong" and   │
│   "I know exactly which layer lied"?             │
└─────────────────────────────────────────────────┘
```

The symptom was as misleading as symptoms get: the agent answered **"I couldn't find anything in the knowledge base to answer that"** — for a question the corpus clearly covered. The easy wrong conclusion is "retrieval quality is bad, the embeddings are weak." That conclusion sends you tuning the wrong layer for a day. You didn't take it.

Here's the diagram you draw while you tell this — the trace read backward, three layers from the symptom.

```
  DEBUGGING THE RETRIEVAL MISS — reading the trace backward

  Layer 3 (symptom)   final answer: "couldn't find anything"
        │  ▲  read UP the persisted trajectory, not down
        ▼  │
  Layer 2             tool_call_end: results = [ ]   ← empty, not an error
        │  ▲          (silent empty — the sharp blind spot)
        ▼  │
  Layer 1 (cause)     tool_call_start args:
                        { query: "...", filter: {textContains:"..."} }
                                              └─ HALLUCINATED key
                                                 no chunk carries it →
                                                 exact-match filter
                                                 silently dropped EVERY hit
```

The strong answer, in your voice:

> "The agent said it couldn't find anything, for a question the corpus covered. I didn't trust the final answer — I read the persisted trajectory backward. Final answer first: 'couldn't find anything.' One layer down, the `tool_call_end` event: the tool returned an *empty array*, not an error. That's the dangerous part — an empty result is silent, it doesn't throw, so nothing upstream knows retrieval failed. So I went one more layer down to the `tool_call_start` args, and there it was: the weak Gemma model had hallucinated a filter key, `{textContains: ...}`, that no chunk in the corpus carries. My filter was exact-match, and it silently dropped every hit because none of them had that key. Three layers from the symptom. The fix is in `matchesFilter` — a filter key now only excludes a hit that *has* that key with a different value; absent keys are ignored. So a hallucinated filter can't wipe the result set anymore. I locked it with a regression test that asserts a `{textContains: 'moon'}` filter still returns results. The lesson I took: with a weak model, the trace was the only bridge from a vague symptom to an exact cause, and silently-empty results are the blind spot — they look like 'nothing matched' when they're actually 'a bug ate everything.'"

Every claim there is real. The fix lives in `matchesFilter` in `packages/retrieval/src/search-knowledge-base-tool.ts` — `Object.entries(filter).every(([key, value]) => !(key in hit.meta) || hit.meta[key] === value)`. The regression test is the case named `ignores filter keys absent from chunk metadata (a hallucinated filter does not wipe results)` in `packages/retrieval/test/search-knowledge-base-tool.test.ts`, which feeds `{ textContains: 'moon' }` and asserts `results.length > 0`.

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "The retrieval was      │ "The agent said it      │
│ failing so I improved   │ found nothing. I read   │
│ the filtering logic.    │ the trace backward:     │
│ The model was           │ final answer → empty    │
│ hallucinating so I made │ tool result → the args  │
│ the filter more         │ showed a hallucinated   │
│ tolerant and added a    │ filter key the exact-   │
│ test."                  │ match filter silently   │
│                         │ dropped on. Three       │
│                         │ layers down. Fixed      │
│                         │ matchesFilter to ignore │
│                         │ absent keys; locked it  │
│                         │ with a regression test."│
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Describes the FIX, not  │ Describes the           │
│ the HUNT. "The model    │ INVESTIGATION. Names    │
│ was hallucinating"      │ the exact layers, the   │
│ skips how you knew      │ silent-empty blind      │
│ that. No evidence you   │ spot, and the tool that │
│ used the trace. Sounds  │ made it findable. This  │
│ like you guessed and    │ is a debugger talking,  │
│ got lucky.              │ not a guesser.          │
└─────────────────────────┴─────────────────────────┘
```

```
        ▸ The bug wasn't bad retrieval. It was a
          silent empty result. The trace was the
          only thing that told them apart.
```

Now the follow-up tree — they will push on the methodology, and you want each branch already walked.

```
  "How did you find it?"
        │
        ▼
  You give the read-the-trace-backward answer.
        │
        ├─► IF THEY ASK "why didn't a test catch it first?"
        │     Honest: the original tests covered the happy
        │     path and a valid filter (`{ docId: 'cooking' }`).
        │     They didn't cover a HALLUCINATED key — that's a
        │     failure mode unique to a weak model. The
        │     regression test now closes exactly that gap.
        │
        ├─► IF THEY ASK "why is a silent empty result so bad?"
        │     Because nothing throws. An exception propagates
        │     and gets logged; an empty array looks identical
        │     to a legitimate no-match. The only way to tell
        │     them apart is to inspect the args that produced
        │     it. That's why the persisted trajectory matters.
        │
        └─► IF THEY ASK "would the fix mask a real no-match?"
              No — a present filter key with a wrong value still
              excludes the hit. Only ABSENT keys are ignored.
              minTopK is a separate guard for under-fetching.
              I can walk both if you want.
```

---

## Prompt 2 — the proudest part: built from contracts, dropped in clean

This is where you get to show that the engineering was design, not typing. The proudest-part answer fails when it's a feature list ("I'm proud I built RAG"). It lands when it points at *evidence that a design decision was right.*

```
┌─────────────────────────────────────────────────┐
│ THEY ASK                                         │
│   "What part of this are you proudest of?"       │
│                                                  │
│ WHAT THEY'RE TESTING                             │
│   Do you know the difference between 'I built a  │
│   thing' and 'I built it in a way that proved    │
│   the architecture was right'? Can you point at  │
│   evidence, not just effort? Do you understand   │
│   what good abstraction boundaries actually buy  │
│   you?                                           │
└─────────────────────────────────────────────────┘
```

The proud thing is not "I built RAG." It's that you built RAG *plus emulated tool-calling for a model that has no native tool-calling* — from your own contracts, not a framework — and it dropped into the existing bounded agent loop with **zero new control flow.** That last fact is the evidence. If your abstractions had been wrong, adding a fundamentally new capability would have forced new branches into the loop. It didn't.

```
  THE DROP-IN — new capability, zero new control flow

  ┌─ existing runtime (unchanged) ──────────────────────────────┐
  │  runAgentLoop({ model, tools, system, userPrompt,           │
  │                 toolSchemas, maxTurns, maxToolCalls,         │
  │                 synthesisInstruction })                     │
  │     ▲ these options already existed for the other 5 agents  │
  └─────┼───────────────────────────────────────────────────────┘
        │ same call, new wiring slotted into existing seams
   ┌────┴──────────┬──────────────────────┬─────────────────────┐
   │ GemmaProvider │ search_knowledge_base│  injectProfile      │
   │ (emulates     │  tool over the       │  (me.md → system)   │
   │  tool-calling)│  retrieval pipeline  │                     │
   │  = a          │  = a ToolRegistry    │  = a pure string    │
   │  ModelProvider│    entry             │    transform        │
   └───────────────┴──────────────────────┴─────────────────────┘
   each new piece implements an EXISTING contract → the loop
   never learned that the model is weak or local. That's the win.
```

The strong answer, in your voice:

> "The part I'm proudest of is that I built RAG with *emulated* tool-calling for Gemma — a local model with no native tool-calling at all — from my own contracts, not a framework, and it dropped into the existing agent loop with zero new control flow. Gemma can't take a `tools` array, so the provider renders the tool schemas into the system prompt, demands a single JSON object back, and parse-retries with a corrective nudge if Gemma fumbles the JSON. From the loop's point of view it's just a `ModelProvider` that returns a `tool_use` block — identical to how the Anthropic adapter looks. So the RAG agent in `packages/agents/rag-query` is the sixth instance of the same capability shape as the other five agents: a provider, a tool policy, a loop config, a validator. The same `runAgentLoop` with the same `maxTurns`, `maxToolCalls`, and `synthesisInstruction` options the other agents already used. I didn't add a branch. That's the evidence the abstraction was right — I bolted on a genuinely new capability and the control flow never noticed. Then I published it as `@rlynjb/aptkit-core` on npm so the companion runtime, buffr, consumes it cleanly off the registry."

Grounded: the Gemma provider's `buildSystemText` renders tools into the system text and the `RETRY_NUDGE` / `maxToolCallAttempts` path handles parse-retry (`packages/providers/gemma/src/gemma-provider.ts`). The RAG agent calls `runAgentLoop` with `maxTurns: 6, maxToolCalls: 4, synthesisInstruction` — all pre-existing options in `packages/runtime/src/run-agent-loop.ts` (lines 45–46, 89–90). Published bundle is `@rlynjb/aptkit-core@0.4.1` on npm.

```
┃ "Zero new control flow" is the proudest line.
┃  It's not a feature — it's proof the
┃  abstraction boundaries were drawn right.
```

```
  "What are you proudest of?"
        │
        ▼
  You give the from-contracts / zero-new-control-flow answer.
        │
        ├─► IF THEY ASK "why not just use LangChain?"
        │     The contracts ARE the lesson. A framework would
        │     own the loop; I'd be defending its decisions, not
        │     mine. Building from contracts means the loop is
        │     bounded by me (maxTurns, maxToolCalls) and every
        │     seam is one I can swap — provider, vector store,
        │     embedder.
        │
        ├─► IF THEY ASK "how does emulated tool-calling fail?"
        │     Gemma emits malformed JSON or prose when it
        │     should call a tool. The provider parse-retries
        │     with a nudge up to maxToolCallAttempts, then
        │     falls back to treating the text as a real answer.
        │     looksLikeToolAttempt gates the retry so plain
        │     prose isn't retried needlessly.
        │
        └─► IF THEY ASK "what proves the abstraction is good?"
              That I added RAG without touching runAgentLoop.
              If the boundaries were wrong, a new capability
              would force new branches. It didn't. The 6th
              agent reused the 5-agent shape verbatim.
```

---

## Prompt 3 — least confident to defend: name the limit, don't apologize

This is the one that separates the loop. There are three real limits in aptkit, and the *frame* matters more than the content. For each: **name the limit → say why it was the right call now → say what you'd do next.** Three beats, no fourth beat of apology.

```
┌─────────────────────────────────────────────────┐
│ THEY ASK                                         │
│   "What part of this are you least confident      │
│    defending?"                                   │
│                                                  │
│ WHAT THEY'RE TESTING                             │
│   Do you know where your own limits are? Can you  │
│   name one without collapsing into 'I don't       │
│   really know what I'm doing'? Did you make       │
│   deliberate scope cuts, or did you just not      │
│   think about it? The honest, bounded answer is   │
│   a STRONGER signal than a flawless one.          │
└─────────────────────────────────────────────────┘
```

### Limit (i): no fine-tuning, no training

> "I did no fine-tuning and no training — that was deliberate, not a gap I overlooked. I'm running off-the-shelf Gemma 2 9B through Ollama. Fine-tuning is the *ceiling*, not the floor: you reach for it only when you have eval evidence that prompting and retrieval have stopped paying off, and I'm not there — `precision@k` and `recall@k` scorers exist in `packages/evals/src/precision-at-k.ts`, and the retrieval quality holds. And I'd never pre-train; that's a different universe of cost and data. So the honest frame is: fine-tuning is on the eval-gated roadmap, not done, because I haven't earned the right to it yet. When my precision@k regresses on a corpus prompting can't fix, that's the trigger."

That is a senior answer. It names the limit, justifies it as a deliberate sequencing decision, and gives the exact signal that would change it.

### Limit (ii): single-user, no RLS enforced

> "aptkit is single-user — there's no row-level security enforced in this repo. That was the right cut for the core: aptkit is deployment-agnostic, it's the reusable library, and multi-tenant isolation belongs in the deployment that has a database. The persistent Postgres `agents` schema and the `app_id`-keyed isolation live in the companion runtime, buffr, not here. The in-repo vector store is in-memory. So the next move isn't 'add RLS to aptkit' — it's that buffr's `PgVectorStore`, which already implements my `VectorStore` contract, is where tenant scoping lands. The contract is the seam that makes that clean."

### Limit (iii): the model is a weak 9B that needs guard rails

> "The model is the weakest link, on purpose — Gemma 2 9B is a small local model, and it needs guard rails I had to build explicitly. It under-fetches: it'll pass `top_k: 1` and starve its own retrieval on a multi-part question, so there's a `minTopK` floor that lifts it back up. It hallucinates filter keys — that was the hardest bug, and `matchesFilter` now tolerates it. It fumbles tool-call JSON, so the provider parse-retries with a nudge. I'm not defending the model's raw capability — I'm defending that I *bounded* it. The guard rails are the engineering."

```
┌─────────────────────────┬─────────────────────────┐
│ WEAK ANSWER             │ STRONG ANSWER           │
├─────────────────────────┼─────────────────────────┤
│ "Yeah, I didn't really  │ "I didn't fine-tune —   │
│ do any fine-tuning, I    │ that was deliberate.    │
│ wasn't sure how, and    │ Fine-tuning is the      │
│ the model's pretty      │ ceiling you reach for   │
│ weak so the results     │ on eval evidence, and   │
│ aren't always great,    │ my precision@k holds,   │
│ honestly it could be    │ so I haven't earned it  │
│ better."                │ yet. Here's the trigger │
│                         │ that would change that."│
├─────────────────────────┼─────────────────────────┤
│ Why it's weak:          │ Why it works:           │
│ Collapses. "Wasn't sure │ Names the limit as a    │
│ how" + "could be        │ DECISION with a reason  │
│ better" reads as 'I     │ and a measured trigger. │
│ shipped something I     │ Reads as someone who    │
│ don't understand.' An   │ sequenced the work and  │
│ apology, not a limit.   │ knows the next step,    │
│ The interviewer now     │ not someone who ran out │
│ doubts everything else. │ of road.                │
└─────────────────────────┴─────────────────────────┘
```

```
┃ Fine-tuning is the ceiling, reached for on eval
┃  evidence — never the floor, never pre-training.
```

Now the recovery box — because this is exactly where the interviewer pushes past your depth, and the difference between an honest limit and a faked one is the whole game.

```
╔═══════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                    ║
║                                                       ║
║   They push past the limit you named — "okay, walk    ║
║   me through HOW you'd fine-tune Gemma, the data,     ║
║   the loss, the eval split." You haven't done it.     ║
║                                                       ║
║   Say:                                                ║
║   "I haven't fine-tuned a model end to end, so I      ║
║    won't pretend to walk you through a training       ║
║    loop I haven't run. What I HAVE built is the       ║
║    eval harness that would gate the decision —        ║
║    precision@k and recall@k in                        ║
║    packages/evals/src/precision-at-k.ts. The way I    ║
║    think about it: I'd hold out a labeled eval set,   ║
║    confirm prompting and retrieval have plateaued     ║
║    on it, THEN fine-tune, and re-score against the    ║
║    same set to prove the lift. I can reason about     ║
║    the gating; I'd be guessing about the training     ║
║    internals, and I'd rather tell you that."          ║
║                                                       ║
║   What this signals: you know exactly where your      ║
║   line is, you bring it back to something you DID     ║
║   build (the evals), and you don't bluff the part     ║
║   you haven't done. All three are senior signals.     ║
║                                                       ║
║   Do NOT say:                                         ║
║   "Yeah, you'd just take your data and run a few      ║
║    epochs with a low learning rate and... it          ║
║    learns the domain." Hand-wavy confidence in        ║
║    territory you haven't touched is the fastest       ║
║    way to lose the room — now they re-examine         ║
║    every confident thing you said earlier.            ║
╚═══════════════════════════════════════════════════════╝
```

The contrast that box is teaching: **"I didn't fine-tune; here's the eval that would gate it and here's the trigger"** is an honest limit that keeps you standing. **"You'd just run a few epochs and it learns"** is faked confidence that takes down everything else you said. Same gap in knowledge — opposite outcomes in the room. The whole skill is staying on the left side of that line.

A second recovery, shorter, for the model-internals push:

```
╔═══════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW — the model internals push        ║
║                                                       ║
║   "How does Gemma's attention actually work? Why 9B   ║
║    and not a different size?"                         ║
║                                                       ║
║   Say:                                                ║
║   "I treat Gemma as a swappable ModelProvider — I     ║
║    picked 9B because it runs locally on my machine    ║
║    with no key and no cloud call, and I bounded its   ║
║    weaknesses with guard rails. I haven't gone deep   ║
║    on the transformer internals; that's not where     ║
║    my engineering went. My engineering went into the  ║
║    contract that lets me swap it. If you want to dig  ║
║    into attention, you'll have to start me off."      ║
║                                                       ║
║   This is honest AND it redirects to your real        ║
║   work — the provider abstraction — without faking    ║
║   the part you don't own.                             ║
╚═══════════════════════════════════════════════════════╝
```

```
  "What's your least-confident part?"
        │
        ▼
  You name a limit (no fine-tuning / single-user / weak model).
        │
        ├─► IF THEY PUSH on fine-tuning mechanics
        │     Recovery box #1. Bring it back to the eval
        │     harness you built. Don't bluff the training loop.
        │
        ├─► IF THEY PUSH on multi-tenant / RLS
        │     The cut was deliberate: core is deployment-
        │     agnostic. Isolation lands in buffr's PgVectorStore
        │     via the same VectorStore contract. Name the seam.
        │
        └─► IF THEY PUSH on the weak model
              Don't defend the model — defend the guard rails.
              minTopK floor, matchesFilter tolerance, parse-
              retry. "I bounded it" is the answer, not "it's
              actually pretty good."
```

---

## Prompt 4 (optional) — the judgment vs the typing

If the conversation opens the door — and in 2026 it usually does — volunteer this. It's the line that reframes "you used AI to write the code" before they can use it against you.

```
┌─────────────────────────────────────────────────┐
│ THEY ASK                                         │
│   "How much of this did you actually engineer    │
│    versus generate?"                             │
│                                                  │
│ WHAT THEY'RE TESTING                             │
│   In a world where the typing is cheap, do you   │
│   know what the actual engineering was? Can you   │
│   point at the decisions that required judgment   │
│   — not the lines of code?                       │
└─────────────────────────────────────────────────┘
```

> "The lines of code were the cheap part. The engineering was three things, none of which is typing. First, the contracts — deciding that `ModelProvider`, `VectorStore`, and `EmbeddingProvider` were the right seams, which is what let me drop emulated tool-calling into the loop with zero new control flow. Second, the evals — `precision@k` and `recall@k`, the harness that tells me whether retrieval is good enough that I *don't* need to fine-tune yet. Third, the verification — when the agent said 'not available,' the judgment was reading the trace backward three layers instead of trusting the symptom, and then locking the fix with a regression test so it can't come back. A model can generate a `matchesFilter` function. It can't decide that the empty result was the bug instead of the answer. That decision was mine."

```
        ▸ The engineering was the contracts, the
          evals, and the verification — not the
          lines of code. That's what I defend.
```

---

## What you'd change

In this chapter's territory — the hard parts — the thing I'd change is the observability that made the hardest bug findable but slow. I diagnosed the retrieval miss by reading the persisted trajectory backward by hand, layer by layer. That worked, but it was manual archaeology. If I were doing it again I'd add an assertion at the tool boundary that flags a *silent empty result* loudly — distinguishing "the filter excluded everything" from "the query genuinely matched nothing" at the moment it happens, not three layers later when I'm reading the trace. The bug taught me where the blind spot is; the change is making the system surface that blind spot itself instead of waiting for me to find it. Same instinct that drove the regression test — turn a lesson into something the system enforces, so I never have to re-learn it the hard way.

---

## One-page summary — the night-before read

**Core claim:** The hard-parts questions aren't traps. The hardest bug rewards backward reasoning, the proudest part rewards evidence over effort, and "least confident" is the strongest signal in the loop when you name the limit instead of apologizing for it.

**The questions, one-line answers:**

- **Hardest bug?** "Agent said 'not available' for a covered question. I read the trace backward — final answer → empty tool result → a hallucinated `{textContains}` filter key the exact-match filter silently dropped on. Three layers from the symptom. Fixed `matchesFilter` to ignore absent keys; locked with a regression test."
- **Proudest part?** "RAG plus emulated tool-calling for a model with no native tool-calling, built from my own contracts, dropped into the existing `runAgentLoop` with zero new control flow — the proof the abstractions were right. Then published to npm as `@rlynjb/aptkit-core`."
- **Least confident?** "No fine-tuning (deliberate — it's the eval-gated ceiling, not the floor; never pre-train), single-user with no RLS (a deliberate cut — isolation lands in buffr's `PgVectorStore` via the `VectorStore` contract), and a weak 9B model I bounded with guard rails (`minTopK` floor, filter tolerance, parse-retry). I defend the guard rails, not the model."
- **Judgment vs typing?** "The engineering was the contracts, the evals, and the verification — deciding the empty result was the bug, not the answer. A model can't make that call."

**Pull quotes:**

```
┃ "Least confident to defend" is not a confession.
┃  It's where you prove you have judgment.

┃ "Zero new control flow" is the proudest line —
┃  proof the abstraction boundaries were right.

┃ Fine-tuning is the ceiling, reached for on eval
┃  evidence — never the floor, never pre-training.
```

**The recovery line to memorize:** "I haven't done X end to end, so I won't pretend to walk you through it. What I *have* built is [the real thing], and here's how I reason about the gate." Honest limit beats faked confidence every time — same knowledge gap, opposite outcome in the room.

**What you'd change:** Add a tool-boundary assertion that flags a silent empty result loudly, so the system surfaces the blind spot instead of waiting for me to find it three layers down in the trace.

---
Updated: 2026-06-24 — Published version reconciled to `@rlynjb/aptkit-core@0.4.1` (0.4.1 is now the published bundle, no longer dev-only).
