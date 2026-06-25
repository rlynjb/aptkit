# Chapter 1 — The pitch

## Opening hook

In the first ten minutes of every senior interview, someone leans back and says "tell me about a project you built." That moment is yours to lose. Most candidates take it as an invitation to narrate — they start at "so there's a monorepo" and forty-five seconds later they're describing their CSS strategy and the interviewer has stopped listening. The pitch is a compression problem, and aptkit gives you a hard one: it's a published TypeScript toolkit, a from-scratch RAG stack running a local model, an eval harness, and a second repo proving it works end to end. Four impressive things, and if you try to say all four at once you'll say none of them.

This chapter teaches you to pitch aptkit at three lengths — 10 seconds, 30 seconds, 90 seconds — and to pick the right one for the room. The discipline is the same one you already run when you decide how much of a system to put on screen versus behind a `fetch()`: say the load-bearing thing, hide the rest behind a clean boundary, and reveal more only when asked. We'll also land the angle that makes this project read as growth and not a repeat: this is your **second** RAG system. AdvntrCue was cloud RAG — Next.js, pgvector, GPT-4. aptkit is the contracts-and-local-open-weights version of the same idea, built from scratch. That arc is the story.

## The chapter-opening diagram

Here is aptkit at a glance — the shape you're compressing into three sentences, with the load-bearing seam (`ModelProvider.complete()`) marked so you can find it under pressure.

```
  aptkit AT A GLANCE — what you're pitching

  ┌─ PUBLISHED SURFACE ─────────────────────────────────────────┐
  │  @rlynjb/aptkit-core @ 0.4.1 on npm                          │
  │  one tarball, 16 internal @aptkit/* packages bundled         │
  └───────────────────────────┬─────────────────────────────────┘
                              │ re-exports
  ┌─ AGENT LAYER ─────────────▼─────────────────────────────────┐
  │  rag-query (capstone) · recommendation · query · diagnostic │
  │  each = prompt pkg + tool policy + runAgentLoop + validator  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ every call goes through ONE contract
  ┌─ THE SEAM ───────────────▼──────────────────────────────────┐
  │      ★ ModelProvider.complete(request) ★   ← we are here     │
  │   swap anthropic / openai / gemma / fixture, agents untouched│
  └──────┬─────────────────────────────────────┬────────────────┘
         │                                      │
  ┌─ PROVIDERS ──────────────┐   ┌─ RETRIEVAL (from scratch) ───┐
  │ anthropic · openai       │   │ EmbeddingProvider (nomic-768)│
  │ gemma (LOCAL, Ollama,    │   │ VectorStore (cosine scan)    │
  │   emulated tool-calling) │   │ search_knowledge_base tool   │
  │ fallback · context-guard │   │ precision@k / recall@k evals │
  └──────────────────────────┘   └──────────────────────────────┘
         │                                      │
  ┌─ PROOF: buffr (companion repo) ─────────────▼───────────────┐
  │  consumes @rlynjb/aptkit-core from npm; supplies            │
  │  PgVectorStore (implements VectorStore over Supabase/pgvector)│
  │  live: index → ask (cited) → eval p@1 = r@3 = 1.0 → persist │
  └─────────────────────────────────────────────────────────────┘
```

Everything in that picture funnels through the one starred box — and that's the secret to the pitch: you don't describe four things, you describe one contract and the four things it makes possible.

## The three pitches

### The 10-second elevator

You have one breath. No architecture, no package count, no npm. One sentence that makes the interviewer want the next ninety seconds.

> ▸ "aptkit is a published TypeScript toolkit for building LLM agents
>   without vendor lock-in — every agent talks to one provider
>   contract, so I can swap Claude for a local Gemma model without
>   touching the agent."

That's it. It names what (a toolkit for agents), the differentiator (no lock-in, one contract), and a concrete payoff (swap cloud for local). If they say "huh, how?" — you've earned the 30. If they nod and move on, you didn't waste their time.

### The 30-second hallway

Now you add the hard part and the proof, still without a whiteboard.

> ▸ "It's published on npm as @rlynjb/aptkit-core — sixteen internal
>   packages bundled into one. The core idea is that everything routes
>   through a single ModelProvider.complete() contract, so providers
>   are swappable adapters. To prove the abstraction holds, I built a
>   RAG stack from scratch that runs a LOCAL Gemma model through Ollama
>   — and Gemma has no native tool-calling, so I emulated it. Then a
>   second repo, buffr, consumes the npm package and swaps the
>   in-memory vector store for Postgres/pgvector. Same contracts, runs
>   live."

Thirty seconds, four proof points: published, the contract, the hard part (local + emulated tools), and the end-to-end proof. Every clause earns its place.

### The 90-second answer — "tell me about a project you built"

This is the real one. It has a shape: **problem → architecture → the hard part → the proof**, in that order, because that's the order an interviewer scores you on. Here's the whole thing, speakable, with the beats marked.

**Beat 1 — the problem (≈15s).**

> I kept rebuilding the same agent plumbing in every app — a provider client, a tool loop, retrieval — and every time it was wired straight to one vendor's SDK. So aptkit is me extracting the reusable parts of an LLM agent into a TypeScript toolkit that doesn't lock you to a provider. The problem it solves is: build the agent once, run it against any model.

**Beat 2 — the architecture (≈25s).**

> The load-bearing idea is a single contract. Every model call in the system goes through `ModelProvider.complete()` — it lives in `packages/runtime/src/model-provider.ts`, and it's a tiny type: an `id`, a `defaultModel`, and a `complete(request)` that returns content blocks. Agents only know that contract. Anthropic, OpenAI, a local Gemma provider, and a fixture provider for tests are all just adapters behind it. I reused the same adapter shape for retrieval — `EmbeddingProvider` and `VectorStore` are vendor-neutral contracts too, so the vector store is swappable the same way the model is.

**Beat 3 — the hard part (≈30s).**

> The part I'm proudest of is the RAG stack, because I built it from scratch against a *weak* model on purpose. The provider is Gemma 2:9b running locally through Ollama — no API key, no cloud. Gemma has no native tool-calling, so in `packages/providers/gemma/src/gemma-provider.ts` I emulate it: I render the tool schemas into the system prompt, demand a single JSON object back, parse it into a `tool_use` block, and if the JSON is malformed I append a corrective nudge and retry once. The retrieval pipeline is the classic shape — doc → chunk → embed → upsert, then query → embed → search → rank — with cosine similarity over nomic-768 embeddings, exposed to the agent as a `search_knowledge_base` tool. And I measured it: precision@k and recall@k scorers in `packages/evals/src/precision-at-k.ts`, plus a rubric-judge that has Claude grade Gemma so the judge isn't the same model being judged.

**Beat 4 — the proof (≈20s).**

> It's not a demo that only runs on my machine. It's published — `@rlynjb/aptkit-core@0.4.1` on npm, sixteen packages in one bundled tarball. And there's a companion repo, buffr, that consumes it from npm and supplies a `PgVectorStore` implementing my `VectorStore` contract against Supabase/pgvector. I ran it live: index a folder of notes, ask a grounded and cited question, run the eval — precision@1 and recall@3 both came back 1.0 — and the trajectory persisted to Postgres. That's the whole loop, end to end, against a real database.

Land the arc at the end if they give you room:

> ▸ "This is my second RAG system. The first, AdvntrCue, was cloud
>   RAG — Next.js, pgvector, GPT-4. aptkit is the same idea rebuilt
>   around contracts and local open-weights. The first one taught me
>   RAG works; this one taught me how to make it portable and
>   measured."

### Now — what they're actually testing with each

The pitch question looks like an icebreaker. It isn't.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Tell me about a project you built."              │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Can you compress? Do you know what's load-bearing │
│   in your own system versus incidental? Do you lead │
│   with the problem or with the tech? A senior        │
│   engineer names the ONE idea the system turns on.   │
│   A junior lists features.                           │
└─────────────────────────────────────────────────────┘
```

The trap is breadth. You have four impressive things and the instinct is to mention all four immediately so none gets missed. That instinct fails you — it reads as someone who can't tell what matters. The fix is to lead with the single contract and let the other three hang off it.

Here's the contrast that does the teaching:

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "So it's a TypeScript        │ "aptkit extracts the reusable│
│ monorepo with sixteen        │ parts of an LLM agent into a │
│ packages — there's a runtime,│ toolkit with no vendor       │
│ tools, context, retrieval,   │ lock-in. The whole thing     │
│ prompts, evals, workflows,   │ turns on one contract —      │
│ five agents, a Studio UI,    │ ModelProvider.complete(). I  │
│ providers for Anthropic and  │ swap Claude for a local      │
│ OpenAI and Gemma, and it's   │ Gemma model without touching │
│ published to npm, and I also │ the agent. To prove that, I  │
│ built a second repo, and..." │ built a from-scratch RAG     │
│                              │ stack on a local model and   │
│                              │ a second repo that runs it   │
│                              │ live against pgvector."      │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ A package inventory. The     │ Leads with the problem, then │
│ interviewer can't tell what  │ the ONE load-bearing idea,   │
│ the project IS or why it's   │ then uses the hard part and  │
│ hard. Breadth with no spine. │ the proof as evidence FOR    │
│ Sounds like a tour, not a    │ that idea. Has a spine. You  │
│ system.                      │ could draw it on a napkin.   │
└──────────────────────────────┴──────────────────────────────┘
```

The strong answer isn't shorter because it's lazier. It's shorter because it knows what to cut.

> ┃ "Breadth is the enemy of the pitch. Name the one contract
> ┃  the system turns on, and let everything else be evidence for it."

### Where the conversation goes next

Once you've given the 90-second answer, the interviewer picks a thread. You can predict which threads. Here's the map — walk these branches before the interview and you'll never be caught flat.

```
  You finish the 90-second pitch.
        │
        ▼
  Interviewer picks ONE thread:
        │
        ├─► "Why provider-neutral? Isn't that premature abstraction?"
        │     → Go to the cost answer. The contract is ONE type
        │       (model-provider.ts) — it cost me almost nothing, and
        │       it bought the local-Gemma swap and fixture-based tests.
        │       Don't oversell it as architecture; it's a small seam
        │       that pays off. (Chapter 3 drills this.)
        │
        ├─► "Walk me through the RAG flow on the whiteboard."
        │     → Switch to the architecture diagram: doc→chunk→embed→
        │       upsert, query→embed→search→rank, search_knowledge_base
        │       as the tool the agent calls. (Chapter 2 owns this.)
        │
        ├─► "Why a LOCAL model? Why make it harder on yourself?"
        │     → The honest answer: to prove the contract holds against
        │       a model with no native tool-calling. If the abstraction
        │       survives Gemma, it survives anything. Plus: no key, no
        │       cloud cost, runs offline. Then mention the emulation.
        │
        └─► "How do you know the RAG actually works?"
              → This is the eval question — your strongest ground.
                precision@k / recall@k scorers, rubric-judge with
                Claude grading Gemma (anti-circular), and the live
                buffr run: p@1 = r@3 = 1.0 over a real pg corpus.
```

The branch you want them to take is the last one. Most candidates can't answer "how do you know it works" with a number. You can. If they don't ask it, volunteer it.

> ┃ "Most candidates demo. You measure. 'precision@1 and recall@3
> ┃  both came back 1.0 on a live pg corpus' is the line that
> ┃  separates 'played with an LLM' from 'does AI engineering.'"

## When you don't know

The pitch invites a deep follow-up, and the most likely place you get pushed past your depth is the embedding model — you picked `nomic-embed-text` because it runs locally in Ollama and is 768-dimensional, not because you benchmarked its retrieval quality against alternatives. Own that cleanly.

```
╔═══════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                   ║
║                                                       ║
║   They ask: "Why nomic-embed-text? How does it       ║
║   compare to OpenAI's text-embedding-3 or BGE on      ║
║   retrieval benchmarks?"                              ║
║                                                       ║
║   You picked it for one reason: it runs locally in    ║
║   Ollama and the whole point was no cloud. You did    ║
║   NOT benchmark it head-to-head. Don't pretend you    ║
║   did.                                                 ║
║                                                       ║
║   Say:                                                ║
║   "I picked nomic for one operational reason — it     ║
║    runs locally in Ollama, which was the whole        ║
║    constraint. I didn't benchmark it against          ║
║    text-embedding-3 or BGE on MTEB-style retrieval    ║
║    numbers. What I did do is put it behind an          ║
║    EmbeddingProvider contract with a fixed dimension, ║
║    so swapping it is a one-file change — and the      ║
║    dimension mismatch fails loud at wiring time so I  ║
║    can't silently mix corpora. If retrieval quality   ║
║    were the bottleneck, that's the first knob I'd     ║
║    turn, and the contract is built to let me."        ║
║                                                       ║
║   What this signals: you know exactly why you chose   ║
║   it, you know what you DIDN'T evaluate, and you      ║
║   built the seam that makes the gap cheap to close.   ║
║   That's three senior signals in one answer.          ║
║                                                       ║
║   Do NOT say:                                         ║
║   "nomic is one of the best open embedding models,    ║
║    it scores really well on the benchmarks."          ║
║   You'll get asked "which benchmarks, what score"     ║
║   and you have nothing. Fake specificity is worse     ║
║   than honest ignorance.                              ║
╚═══════════════════════════════════════════════════════╝
```

The move here is the same one you'd make defending any frontend choice you defaulted on: name the real reason you picked it, name what you didn't measure, and name the cheap path to fixing it if it mattered. The contract (`EmbeddingProvider` in `packages/retrieval/src/contracts.ts`) is what makes that last part true and not a hand-wave.

## What you'd change

If you were pitching this project a second time, the thing to reconsider is **where you put the "second RAG system" line.** Right now it's the closer, and that's the safe spot. But if the interviewer's first question is "what have you built in AI before this," lead with it instead — open on "I've now built two RAG systems, a cloud one and a local one, and the second taught me the part the first hid: portability and measurement." That reframes the whole conversation from "here's a project" to "here's an arc," which is the more senior posture. The pitch content doesn't change; the placement of the growth story does, and placement is most of what a pitch is.

## One-page summary

**Core claim:** The pitch is a compression problem. Lead with the one contract the system turns on — `ModelProvider.complete()` — and let the published package, the from-scratch local RAG, and the live buffr proof be evidence for it. Breadth kills the pitch.

**The three lengths:**
- **10s** — "A published TypeScript toolkit for LLM agents with no vendor lock-in: every agent talks to one provider contract, so I swap Claude for local Gemma without touching the agent."
- **30s** — Add: published as `@rlynjb/aptkit-core` (16 packages bundled), built a from-scratch RAG stack on a *local* Gemma model with *emulated* tool-calling, and a second repo (buffr) that swaps in pgvector. Runs live.
- **90s** — problem (reusable agents, no lock-in) → architecture (everything behind `ModelProvider.complete()`, `packages/runtime/src/model-provider.ts`) → hard part (from-scratch RAG + emulated tool-calling for a weak local model, `packages/providers/gemma/src/gemma-provider.ts`, measured with precision@k in `packages/evals/src/precision-at-k.ts`) → proof (npm + buffr's `PgVectorStore`, live eval p@1 = r@3 = 1.0).

**Questions covered:**
- "Tell me about a project you built." → Lead with the contract; problem → architecture → hard part → proof.
- "Why provider-neutral / why local / how do you know it works?" → the three follow-up branches; steer toward the eval numbers.
- "Why nomic-embed-text?" → the "I don't know" recovery: operational reason, honest about no benchmark, cheap to swap behind the contract.

**Pull quotes:**
- "Breadth is the enemy of the pitch. Name the one contract the system turns on, and let everything else be evidence for it."
- "Most candidates demo. You measure. 'precision@1 and recall@3 both came back 1.0' is the line that separates 'played with an LLM' from 'does AI engineering.'"
- "This is my second RAG system. The first taught me RAG works; this one taught me how to make it portable and measured."

**What you'd change:** Move the "second RAG system" line from the closer to the opener when the interviewer asks about your AI background first — pitch the arc, not just the project.

---
Updated: 2026-06-24 — Published version `0.4.0 → 0.4.1` and bundle count `15 → 16` (added `@aptkit/memory`) across the at-a-glance diagram and all three pitch lengths.
