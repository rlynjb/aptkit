# Interview Defense — aptkit

You built aptkit. Now you have to defend it in a room, out loud, while
someone who has read a lot of bad architecture diagrams pokes at the seams.
This book is the rehearsal. Not the comprehension guide — you already
understand the code. This is the performance: turning what you know into
speech that holds up under follow-ups.

I'm going to be direct with you the whole way through, because that's what
gets you hired. I've sat on enough hiring committees to know the difference
between a candidate who *built* a thing and one who *watched a thing get
built*. The difference is almost never knowledge. It's composure under the
second follow-up. This book is about earning that composure by walking every
branch before you're in the room.

```
THE BOOK AT A GLANCE — what each chapter buys you

  ┌──────────────────────────────────────────────────────────────┐
  │  THE OPENER (first 10 minutes)                                 │
  │                                                                │
  │   01 the pitch ────────► 10s / 30s / 90s, no rambling          │
  │   02 the architecture ─► whiteboard the system in 90s          │
  │                                                                │
  ├──────────────────────────────────────────────────────────────┤
  │  THE DRILL (the middle, where it's won or lost)                │
  │                                                                │
  │   03 the choices ──────► defend every load-bearing decision    │
  │   04 the scale story ──► what breaks first at 10x              │
  │   05 the failure story ► what happens when it goes wrong       │
  │   06 the hard parts ───► hardest bug · proudest · weakest      │
  │                                                                │
  ├──────────────────────────────────────────────────────────────┤
  │  THE CLOSE (senior signal)                                     │
  │                                                                │
  │   07 the counterfactuals ► what you'd change, volunteered      │
  │   08 the AI question ────► owning how you built it in 2026     │
  └──────────────────────────────────────────────────────────────┘

  read top to bottom once. then live in 03–06.
```

That's the spine. The opener gets you taken seriously; the drill is where
the offer is decided; the close is where you separate from the other senior
candidates who can't volunteer a regret without sounding apologetic.

## The system you're defending — the master diagram

This is the picture you return to whenever you lose your place. Every chapter
is a zoom into one band of it. Memorize this and you can re-anchor mid-answer.

```
THE APTKIT SYSTEM — one library, one durable runtime

  ┌─ STUDIO (apps/studio, React 18 + Vite) ──────────────────────────┐
  │  in-browser RAG playground · trace replay · doc pages            │
  │  static GitHub Pages build — no server                           │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │  uses
  ┌─ AGENTS (6 capabilities) ─────▼──────────────────────────────────┐
  │  rag-query · recommendation · anomaly-monitoring                 │
  │  diagnostic-investigation · query · rubric-improvement           │
  │  each = prompt package + tool policy + loop config + validator   │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │  runs on
  ┌─ RUNTIME (packages/runtime) ──▼──────────────────────────────────┐
  │  runAgentLoop — bounded turns, forced synthesis on last turn     │
  │  CapabilityEvent trace · ModelProvider.complete() contract       │
  └──────────────┬──────────────────────────────┬─────────────────────┘
                │                               │
  ┌─ PROVIDERS ─▼────────────┐    ┌─ RETRIEVAL ─▼────────────────────┐
  │  gemma (local default,   │    │  EmbeddingProvider + VectorStore │
  │   EMULATED tool-calling) │    │   contracts                       │
  │  anthropic · openai      │    │  InMemoryVectorStore (cosine)    │
  │  fallback · local guard  │    │  nomic-768 · search_knowledge_base│
  └──────────────────────────┘    └───────────────┬───────────────────┘
                                                  │  same contracts
  ┌─ DEPLOYMENT SEAM ─────────────────────────────▼───────────────────┐
  │  aptkit = deployment-agnostic LIBRARY (published bundle)          │
  │  buffr  = durable RUNTIME — PgVectorStore implements VectorStore  │
  │           over Supabase pgvector + HNSW; agents schema in reindb  │
  │           consumes @rlynjb/aptkit-core ^0.4.1 (one-line swap)     │
  └────────────────────────────────────────────────────────────────────┘
```

The two things to never lose under pressure: **the whole system hangs off two
contracts** (`ModelProvider.complete()` and `VectorStore`/`EmbeddingProvider`),
and **the library/runtime split is the thesis** — aptkit ships the slots,
buffr fills them.

## What this is, in one breath

aptkit is a TypeScript monorepo that packages the reusable parts of an AI
agent system — a bounded agent loop, swappable model providers including a
*local* Gemma, a from-scratch RAG pipeline behind two contracts, and a Studio
UI — into one published npm bundle (`@rlynjb/aptkit-core`), so a separate
deployment ("buffr") can fill in the durable Postgres/pgvector binding without
the core ever knowing it exists.

## How to use this book

```
  FIRST READ      one chapter per sitting, in order. the openers
                  (01, 02) build the spine; the drill (03–06) is
                  where you'll spend the real prep time.

  REVIEW          skim the chapter-opening diagrams, the pull quotes,
                  and the "I don't know" boxes. that's ~70% of it.

  NIGHT BEFORE    read ONLY the one-page summary at the end of each
                  chapter. eight pages, tight, every claim walkable.
```

## The six visual treatments you'll see throughout

Each is a recurring motif so your eye finds it on a re-read:

- **Chapter-opening diagram** — the visual anchor for the whole chapter.
- **"What they're really asking" callout** (`┌─┐`) — the probe under the
  question.
- **Strong / weak side-by-side** — the contrast does the teaching.
- **"When you don't know" box** (`╔═╗`, double border) — the recovery line
  for territory you can't fake. These lean toward your real gaps: no
  distributed scale, no HNSW internals, no fine-tuning, single-user/no-RLS.
- **Follow-up decision tree** — the 2–4 branches the conversation takes after
  your answer.
- **Pull quote** (`┃` or `▸`) — the line you carry into the room.

## The honesty posture (this runs through every chapter)

You built this with heavy AI assistance. So did everyone else interviewing in
2026, and senior interviewers know it. What separates you is whether you
understand what you shipped well enough to own it. Throughout the book I'll
tag decisions by *how* they were made:

```
  deliberate              you chose it, you can defend the criteria
  evaluated-and-accepted  AI suggested it, you weighed it, you kept it
  defaulted-to            AI's default, you didn't deeply evaluate it
```

The third mode is the riskiest to own and the strongest senior signal when
owned well. We'll name which decisions fall where, especially in Chapter 8.

## Connection to the rest of your study system

This is the *project-level* defense — the wide opener, "walk me through what
you built." The *concept-level* defenses (one decision in depth — provider
abstraction, the retrieval contracts) live in the Interview-defense blocks
inside `.aipe/study-system-design/` and `.aipe/study-ai-engineering/`. Use
both: the concept files prepare the deep dive, this book prepares the opener.

```
  this book           the concept files
  ─────────           ─────────────────
  "walk me through    "why did you make the
   your project"       VectorStore a contract
  the wide opener      and not a class?"
                       the deep dive
```

Now turn to Chapter 1. The first sixty seconds decide how the next forty-five
minutes feel.
