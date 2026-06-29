# Chapter 1 — The Pitch

In the first ten minutes of every senior interview, someone asks you to describe a project. You get one shot at a first impression, and most candidates blow it the same way: they start in the middle, name three technologies before naming the problem, and trail off when they realize they've been talking for two minutes with no landing. This chapter is about saying what aptkit is in ninety seconds — and in thirty, and in ten — without rambling.

Compression is harder than depth. You know everything about this codebase; that's the trap. You'll want to say all of it. The discipline is choosing what to leave out.

## The chapter-opening diagram — the pitch as a funnel

Three pitches, three lengths, same spine. Each one is the layer below it, expanded. Learn the 10-second version cold; the others are it with detail added.

```
  THE PITCH FUNNEL — same spine, three depths

  ┌─ 10 SECONDS (the elevator) ──────────────────────────────────────┐
  │  "It's a TypeScript toolkit that packages the reusable parts of   │
  │   an AI agent system — the loop, the providers, the RAG pipeline  │
  │   — behind swappable contracts, so they ship as one npm bundle."  │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  add: the two seams + why a library
  ┌─ 30 SECONDS (the hallway) ─────▼──────────────────────────────────┐
  │  + "Everything depends on two contracts: a model port and the     │
  │     retrieval ports. The default model runs locally — Gemma over  │
  │     Ollama, no cloud key. A separate repo, buffr, consumes the    │
  │     published bundle and fills the durable slot with Postgres."   │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  add: the why, the arc, the proof
  ┌─ 90 SECONDS (the real answer) ─▼──────────────────────────────────┐
  │  + the problem it solves (agent code tangled with product logic)  │
  │  + the arc (I'd shipped framework RAG before — AdvntrCue; this    │
  │     is the substrate, built from contracts)                       │
  │  + the one proof point (memory reuses the retrieval contracts     │
  │     with zero new infrastructure — that's the boundary paying off)│
  └────────────────────────────────────────────────────────────────────┘
```

The funnel is the technique: never start wide and hope to land. Start with the tightest true sentence, then add rings only as the room asks for them. The sentence above the funnel is the one you say first, every time.

## The 90-second answer

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Tell me about a project you've built."                 │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Can you compress? Do you lead with the problem or the   │
│   tech? Can you name what's actually interesting about    │
│   it in one breath, or do you list features until the     │
│   interviewer interrupts? The pitch is a proxy for        │
│   whether you can communicate under pressure at all.      │
└─────────────────────────────────────────────────────────┘
```

Here's the version you say. Read it aloud — it should sound like you, not like a brochure.

> "AptKit is a TypeScript toolkit that packages the reusable parts of an AI agent system. I'd shipped a RAG app before — AdvntrCue, Next.js and pgvector and GPT-4 — but that was framework code tangled with product logic. AptKit is the substrate underneath: a bounded agent loop, provider adapters, a from-scratch RAG pipeline, all sitting behind swappable contracts so they ship as one npm bundle, `@rlynjb/aptkit-core`.
>
> The whole thing rests on two seams. One is the model port — `ModelProvider.complete()` — and the default behind it is Gemma running locally over Ollama, with no cloud key, which means I had to emulate tool-calling because Gemma doesn't have it natively. The other seam is the retrieval ports, `EmbeddingProvider` and `VectorStore`. AptKit ships an in-memory vector store; a separate repo, buffr, consumes the published bundle and swaps in a Postgres-backed store in one line.
>
> The thing I'm proudest of: I added episodic conversation memory later, and it reused the retrieval contracts with zero new infrastructure. That's the signal the boundary was drawn in the right place."

That's about ninety seconds spoken. It names the problem, the arc, the two seams, and one proof point — then stops. The stop is the hard part.

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "It's an AI agent framework  │ "It's a toolkit that packages│
│ I built. It's got a bunch of │ the reusable parts of an     │
│ packages — runtime, tools,   │ agent system behind two      │
│ context, retrieval, memory,  │ contracts: a model port and  │
│ evals, workflows, six agents,│ the retrieval ports. The     │
│ providers for Anthropic,     │ default model runs locally,  │
│ OpenAI, Gemma, a Studio UI   │ and a second repo fills the  │
│ in React, and it publishes   │ durable storage slot."       │
│ to npm..."                   │                              │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ It's a package manifest read │ It leads with the shape (two │
│ aloud. The interviewer can't │ seams), not the inventory.   │
│ hold 16 nouns. Nothing is    │ The listener can hold "two   │
│ ranked. You've told them WHAT │ contracts" and "library +    │
│ is in the repo, not what     │ deployment." They now want   │
│ MATTERS about it.            │ to ask about a seam — which  │
│                              │ is exactly where you want    │
│                              │ the conversation to go.      │
└──────────────────────────────┴──────────────────────────────┘
```

The weak answer isn't wrong — every word is true. It fails because it's flat. Sixteen packages presented as equals teaches the interviewer nothing about your judgment. The strong answer ranks: two seams carry the weight, everything else is an adapter. Ranking is the senior signal.

```
  ▸ Don't read the package manifest aloud. Lead with the
    two seams, and let everything else be an adapter.
```

## Where the pitch goes next

The pitch is a setup. The interviewer's follow-up tells you which chapter of this book you're now in.

```
  "Tell me about a project."
        │
        ▼
  You give the 90-second pitch (two seams + library/deployment split).
        │
        ├─► IF THEY SAY "walk me through the architecture"
        │     → Chapter 2. Draw Studio → agents → runtime → providers
        │       + retrieval → buffr. Start at the diagram, not a file.
        │
        ├─► IF THEY ASK "why local Gemma / why build RAG yourself"
        │     → Chapter 3. Name the alternative, the criterion, the cost.
        │       Don't defend it as obviously right — name what you'd flip.
        │
        ├─► IF THEY ASK "what's the hardest thing you hit"
        │     → Chapter 6. The agent said 'not available' on a good corpus.
        │       Tell the war story — induce, diagnose, fix, prove.
        │
        └─► IF THEY ASK "did you build this with AI?"
              → Chapter 8. Matter-of-fact. Three modes: deliberate,
                evaluated-and-accepted, defaulted-to.
```

You're not improvising the follow-up. You've already walked every branch. That's what kills the nerves — you know where the road goes.

## When you don't know — the scale question after the pitch

The most common pitch trap: you mention "scales" or "production" in the pitch and the interviewer pounces.

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                        ║
║                                                           ║
║   You pitch the project and they ask: "What's your        ║
║   throughput? How many requests per second has this       ║
║   handled in production?"                                 ║
║                                                           ║
║   You haven't run this under sustained load. It's a       ║
║   library and a single-user laptop runtime. There is no   ║
║   RPS number, and inventing one is the fastest way to     ║
║   lose the room.                                          ║
║                                                           ║
║   Say:                                                    ║
║   "This hasn't run under production load — it's a         ║
║    library plus a single-user runtime in buffr, so I      ║
║    don't have an RPS number to give you. What I can       ║
║    walk you through is where the first bottleneck is by   ║
║    design: the in-memory vector store does a linear       ║
║    cosine scan, so it's the first thing that breaks as    ║
║    the corpus grows — which is exactly why buffr swaps    ║
║    in pgvector with an HNSW index."                       ║
║                                                           ║
║   What this signals: you don't fake a metric, and you     ║
║   redirect to the real systems thinking you DO have —     ║
║   knowing where your own design breaks first.             ║
║                                                           ║
║   Do NOT say:                                             ║
║   "It scales well, it can handle a lot of traffic."       ║
║   That's a marketing sentence with no number behind it.   ║
║   The next question buries you.                           ║
╚═══════════════════════════════════════════════════════════╝
```

## What you'd change

If you were pitching this project fresh today, you'd cut the word "framework" entirely — it invites the "why not LangChain" comparison before you've earned the chance to explain that the point was building the substrate, not adopting one. "Toolkit defined by two contracts" is the honest frame and it sidesteps the framework-versus-framework fight you don't want in the first thirty seconds.

```
  ▸ The pitch is a proxy. They're not grading the project
    yet — they're grading whether you can compress it.
```

## One-page summary

**Core claim:** Lead with the two seams (model port + retrieval ports) and the library-plus-deployment split. Never read the package manifest aloud.

**Questions covered:**
- *"Tell me about a project."* → 90 seconds: problem (agent code tangled with product logic), arc (shipped framework RAG before; this is the substrate), two seams, one proof point (memory reused the retrieval contracts with zero new infra).
- *"What's your throughput in production?"* → Don't fake a number. "It's a library plus single-user runtime; here's where it breaks first by design."

**Pull quotes:**
- Don't read the package manifest aloud. Lead with the two seams, and let everything else be an adapter.
- The pitch is a proxy. They're grading whether you can compress, not the project yet.

**What you'd change:** Drop "framework" from the pitch — it invites the LangChain comparison before you can frame this as substrate-from-contracts.
