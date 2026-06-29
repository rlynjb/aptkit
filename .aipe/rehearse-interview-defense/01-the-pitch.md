# Chapter 1 — The Pitch

In the first ten minutes of every senior interview someone asks you to
describe a project. Most candidates ramble — they start in the middle, name
six technologies, and lose the room before the first follow-up. This chapter
is about saying what aptkit is in three calibrated lengths — ten seconds,
thirty seconds, ninety seconds — without rambling, and landing the one idea
that makes an interviewer lean in.

The discipline here is compression, and compression is harder than it looks.
You know too much about aptkit. The pitch is the act of throwing away 95% of
what you know and keeping the 5% that earns the next question.

## The chapter-opening diagram — the pitch as a funnel

Here's the shape of a good pitch: it narrows from a one-line frame to the
single idea you want them to remember, and only then opens into detail *if
they ask*. You control the funnel; you don't dump the whole bucket.

```
THE PITCH FUNNEL — compression, then expansion on demand

  10 SECONDS  ┌────────────────────────────────────────────┐
  the frame   │ "aptkit is a published npm bundle of the    │
              │  reusable parts of an AI agent system —     │
              │  agent loop, swappable providers, RAG."     │
              └───────────────────┬────────────────────────┘
                                  │  if they nod, go on
  30 SECONDS  ┌───────────────────▼────────────────────────┐
  + the thesis│ "...the thesis is a clean split: aptkit is  │
              │  a deployment-agnostic LIBRARY; a separate  │
              │  app, buffr, is the durable RUNTIME that    │
              │  fills the storage slot."                   │
              └───────────────────┬────────────────────────┘
                                  │  if "tell me more"
  90 SECONDS  ┌───────────────────▼────────────────────────┐
  + the proof │ two contracts (ModelProvider, VectorStore), │
              │  a local Gemma taught to call tools, RAG    │
              │  from scratch, scored with precision@k,     │
              │  buffr swaps in pgvector in one line.       │
              └─────────────────────────────────────────────┘

  the money idea (carry it the whole interview):
  ▸ aptkit ships the slots; buffr fills them.
```

The funnel is the technique. Each level is a complete, satisfying answer on
its own — you stop where they stop nodding. Now let's build each one.

### Question 1 — "Tell me about a project you've built"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Tell me about a project you built."              │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Can you compress? Do you lead with the idea or    │
│   the tech list? Is there ONE clear thesis, or is   │
│   it a pile of features? A senior candidate has a   │
│   spine; a junior has a feature tour.               │
└─────────────────────────────────────────────────────┘
```

Here's what I'd say at ninety seconds — the full answer to the open prompt.
Read it aloud; it should sound like you talking, not a brochure:

> "I built aptkit — a TypeScript monorepo that packages the reusable guts of
> an AI agent system into one published npm bundle, `@rlynjb/aptkit-core`.
> The core idea is a clean library-versus-deployment split. aptkit is the
> library: a bounded agent loop, model providers behind a single
> `complete()` contract — including a *local* Gemma I taught to call tools
> since Gemma has no native tool-calling — and a RAG pipeline I built from
> scratch behind two swappable contracts, a `VectorStore` and an
> `EmbeddingProvider`. It runs entirely local by default, on Ollama, no cloud
> key.
>
> The deployment lives in a separate repo, buffr. buffr consumes the
> published bundle and fills the storage slot — it implements that same
> `VectorStore` contract over Supabase pgvector with an HNSW index. So the
> swap from my in-memory store to a durable Postgres one is a single line,
> because they satisfy the same contract. That's the whole thesis: aptkit
> ships the slots, buffr fills them."

That's it. Two contracts, a local model doing something it normally can't, a
one-line swap that proves the boundary was real. I stop there and let them
pick the thread.

### The thirty-second version

When the room is moving fast — a recruiter screen, a hallway — drop to thirty:

> "aptkit is a published npm bundle of the reusable parts of an AI agent
> system — a bounded agent loop, model providers behind one contract
> including a local Gemma, and a from-scratch RAG pipeline. The thesis is a
> library/deployment split: aptkit stays deployment-agnostic, and a separate
> app called buffr fills in the durable Postgres storage by implementing my
> `VectorStore` contract. The boundary is real enough that swapping stores is
> one line."

### The ten-second version

For "what have you been working on lately" in passing:

> "A published npm bundle of the reusable parts of an AI agent system — agent
> loop, swappable model providers including a local one, RAG from scratch —
> built so a separate deployment can fill in the storage without the core
> knowing."

```
┃ You stop where they stop nodding. The pitch is a funnel
┃ you control, not a bucket you empty.
```

### Strong vs weak — the same project, two pitches

The contrast is the whole lesson here. Watch what the weak pitch signals.

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK PITCH                   │ STRONG PITCH                 │
├──────────────────────────────┼──────────────────────────────┤
│ "It's a TypeScript monorepo  │ "It's a published npm bundle │
│  with npm workspaces, it     │  of the reusable parts of an │
│  uses Ollama and Anthropic   │  AI agent system. The idea   │
│  and OpenAI, it's got React  │  is a library/deployment     │
│  18 and Vite for the Studio, │  split — aptkit is the       │
│  pgvector, HNSW, a bunch of  │  library, buffr is the       │
│  agents, evals with          │  runtime that fills the      │
│  precision@k, fixtures..."   │  storage slot. One contract  │
│                              │  swap proves the boundary."  │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ It's a parts list. No        │ Leads with the IDEA. The     │
│ thesis. The interviewer      │ tech is evidence FOR the     │
│ can't tell what you cared    │ thesis, summoned only when    │
│ about or what's load-        │ asked. The interviewer knows │
│ bearing. You sound like you  │ exactly what you cared about │
│ assembled it, not designed   │ and has a clear thread to    │
│ it.                          │ pull.                        │
└──────────────────────────────┴──────────────────────────────┘
```

The weak pitch isn't *wrong* — every fact in it is true. It fails because it
has no spine. An interviewer hears a parts list and concludes you don't know
which parts matter. Lead with the idea; let the parts earn their way in.

### Where the conversation goes next

After a good ninety-second pitch, the follow-ups are predictable. Walk the
branches now so none of them surprises you:

```
You give the library/deployment-split pitch.
      │
      ├─► IF THEY ASK "why split it that way?"
      │     The reusable agent code shouldn't carry a
      │     storage decision. aptkit ships the VectorStore
      │     CONTRACT; buffr ships PgVectorStore that
      │     implements it. → full answer in Ch03 + Ch07.
      │
      ├─► IF THEY ASK "what's the local Gemma about?"
      │     Gemma via Ollama has no native tool-calling.
      │     I emulate it: prompt it to emit a JSON tool
      │     call, parse it, feed the result back. → Ch06.
      │
      ├─► IF THEY ASK "how do you know the RAG works?"
      │     precision@k / recall@k scorers in
      │     packages/evals/src/precision-at-k.ts, plus a
      │     Claude-judges-Gemma rubric. → Ch03, Ch08.
      │
      └─► IF THEY ASK "is this in production?"
            Honest: it's a portfolio system. buffr runs it
            on a laptop against Supabase, single-user, no
            RLS yet. I say "single-user" plainly. → Ch04.
```

Notice the last branch. "Is this in production" is a trap if you oversell.
The honest answer — "it's a portfolio system, buffr runs it single-user on a
laptop" — costs you nothing and buys you credibility on every later claim.

```
╔════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                     ║
║                                                         ║
║   They push on the pitch: "What's your daily active     ║
║   user count? What traffic does this handle?"           ║
║                                                         ║
║   You don't have those numbers because this isn't a     ║
║   production product with users. Don't invent a         ║
║   number. Don't get defensive.                          ║
║                                                         ║
║   Say:                                                  ║
║   "It's not a production product with live users —      ║
║    it's a portfolio system I built to work through the  ║
║    AI-engineering substrate. buffr runs it single-user  ║
║    on a laptop against Supabase. So I don't have        ║
║    traffic numbers. What I CAN walk you through is the  ║
║    architecture and how I'd reason about scaling it —   ║
║    want me to do that?"                                 ║
║                                                         ║
║   What this signals: you know the difference between a  ║
║   portfolio project and a production system, you don't  ║
║   pad your story, and you redirect to where you're      ║
║   strong (the design) without dodging the question.     ║
║                                                         ║
║   Do NOT say:                                           ║
║   "Well, it could scale to thousands of users           ║
║    easily..." — you can't back that and they'll spend   ║
║    the next ten minutes proving you can't.              ║
╚════════════════════════════════════════════════════════╝
```

```
        ▸ A pitch is a thesis with evidence on call —
          never a parts list read at speed.
```

## What you'd change

If I were pitching this today I'd lead even harder on the *one-line swap* as
the proof point and hold the tech stack further back. The first time I
pitched aptkit I front-loaded "TypeScript monorepo, npm workspaces, 16
bundled packages" — true, but it's plumbing, and plumbing first signals you
think the plumbing is the achievement. The achievement is that the
`VectorStore` boundary was clean enough that a *different repo* slotted in a
production store without touching the core. That's the line I'd open the
expansion with now.

## One-page summary — Chapter 1

```
CORE CLAIM
  A pitch is a funnel you control: lead with the idea
  (library/deployment split), let the tech earn its way in.

QUESTIONS COVERED
  Q: Tell me about a project you built.
     A: aptkit — published bundle of reusable AI-agent parts;
        thesis is library (aptkit) vs runtime (buffr); two
        contracts; one-line VectorStore swap proves the boundary.
  Q: Is this in production?
     A: No — portfolio system, buffr runs it single-user on a
        laptop against Supabase. State it plainly.
  Q: 10s / 30s / 90s versions?
     A: Frame → thesis → proof. Stop where they stop nodding.

PULL QUOTES
  ▸ aptkit ships the slots; buffr fills them.
  ▸ You stop where they stop nodding.
  ▸ A pitch is a thesis with evidence on call, not a parts list.

WHAT YOU'D CHANGE
  Open the expansion on the one-line contract swap, not the
  monorepo plumbing — the boundary is the achievement.
```
