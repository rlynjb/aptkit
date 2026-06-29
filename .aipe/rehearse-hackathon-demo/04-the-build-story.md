# Chapter 04 — The Build Story   (8:00–8:45, 45 sec)

## Opening hook

Forty-five seconds. This is the chapter that separates a working build from a
pitch deck — proof that what they just saw is real code, not a Figma mockup
wired to a happy path. You don't list features here; you name what shipped, the
one hard part you cracked, and the rough edge you own on purpose. Judges in
2026 assume heavy AI assistance and they assume rough edges. The confidence
comes from naming both before they ask.

The hard part is genuinely good, so lead with it: you taught a local model that
*can't* call tools to drive a tool-using agent loop — and you found and killed
a retrieval bug that a weak model's behavior caused. That's a real war story,
and it has a regression test behind it.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ──────────────────── 8:00 ─ 8:45 ─────────────────── 10:00 │
  │     THE BUILD STORY — you own 8:00 to 8:45 (45 sec)        │
  └──────────────────────────────────────────────────────────┘
```

In 45 seconds: name what shipped (one breath), tell the hard part (the spine),
own the rough edge (one sentence).

## The chapter-opening diagram — what actually shipped

This is the proof-of-real, at a glance: 16 packages bundled and published to
npm, six agents, Studio, evals — and buffr graduating to a live Postgres.

```
  WHAT SHIPPED — real code, in the repo, on npm

  ┌─ @rlynjb/aptkit-core (published to npm) ─────────────────────┐
  │  16 internal packages inlined into one tarball                │
  │  runtime · tools · context · retrieval · memory · prompts ·   │
  │  evals · workflows · 6 agents · 5 providers · core            │
  └───────────────────────────────────────────────────────────────┘
            │ consumed from npm by
            ▼
  ┌─ buffr (companion repo) ──────────────────────────────────────┐
  │  graduates the demo's in-memory store to a LIVE Supabase       │
  │  pgvector PgVectorStore — same VectorStore contract            │
  └───────────────────────────────────────────────────────────────┘

  + apps/studio: React/Vite, reincodes-themed, hash-routed,
    deployed to GitHub Pages (fixture-only static build)

  THE HARD PART ─────────────────────────────────────────────────
    teaching a tool-less local model (Gemma) to call tools
    → and the retrieval-miss bug that a weak model's hallucinated
      filter caused → caught, fixed, regression-tested
```

The picture's job: this is a published npm package and a companion runtime,
not a weekend toy. Point at "16 packages" and "buffr → live pgvector" so the
room sees the toolkit graduated past the demo.

## The body — three beats in 45 seconds

### Beat 1 — what shipped (one breath, ~10 sec)

```
  ┃ "This is 16 packages bundled into one npm release — the agent
  ┃  loop, the providers, the RAG pipeline, the evals — six agents
  ┃  on top, a Studio to preview them, and a companion runtime,
  ┃  buffr, that swaps today's in-memory store for live Supabase
  ┃  pgvector. Same contract, real database."
```

### Beat 2 — the hard part (the spine, ~25 sec)

This is the story. Tell it as a problem you hit and solved, not a feature.

```
  ┃ "The hard part: Gemma running locally can't call tools — it has
  ┃  no native tool API. So I taught the provider to fake the
  ┃  protocol: render the tools into the prompt, parse a JSON tool
  ┃  call back out, retry when it botches the JSON."
  ┃
  ┃ "And that flushed out a real bug. A weak model would sometimes
  ┃  hallucinate a metadata filter on the search — a key that
  ┃  doesn't exist on any chunk — and that filter would silently
  ┃  wipe every result. Retrieval would just return nothing.
  ┃  The fix: a filter key that's absent from a chunk's metadata is
  ┃  ignored instead of excluding it. It's a five-line change with a
  ┃  regression test that locks it in."
```

That bug and fix are real: `packages/retrieval/src/search-knowledge-base-tool.ts`
(`matchesFilter` — "Keys absent from a chunk's meta are ignored, so a weak
model's hallucinated filter can't silently wipe every result"), with the
regression test named in plain English in
`packages/retrieval/test/search-knowledge-base-tool.test.ts`: *"ignores filter
keys absent from chunk metadata (a hallucinated filter does not wipe results)."*
There's a companion `minTopK` floor test too ("a weak model cannot starve
retrieval"). When you say "regression test," you can point at the exact test
name. That's the difference between a claim and proof.

### Beat 3 — own the rough edge (one sentence, ~10 sec)

Name it before a judge does. Confidence, not apology.

```
  ┃ "The in-browser demo uses a deterministic stub embedder by
  ┃  design — so it can't break on stage and the score is
  ┃  reproducible. The real embedder is nomic-embed-text on Ollama;
  ┃  same contract, I just swap it in for the live run."
```

### The strong-vs-weak build-story move

```
  WEAK build story                   STRONG build story
  ─────────────────────────────      ─────────────────────────────────────
  "It's a really robust, scalable    "16 packages, published to npm. The
  toolkit with a lot of features —    hard part was teaching a tool-less
  we built agents, providers, RAG,    model to call tools — and the
  evals, memory, workflows..."        retrieval bug that uncovered, fixed,
  (a feature list; nothing proves     regression-tested." (a war story with
  it's real or hard)                  a named test behind it)
```

A feature list proves nothing. One hard problem, named precisely, with a test
you can point at, proves you built it.

## The IF-IT-BREAKS box

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ No live screen here — this is spoken over the "what shipped"       ║
║ slide. If the slide won't show → say the three beats from memory.  ║
║ If a judge interrupts to verify, offer the file path out loud:     ║
║ "the regression test is in retrieval's search-knowledge-base-tool  ║
║ test — I can open it." Don't break stride to open it mid-clock.    ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

This chapter is already 45 seconds — if you're behind, cut beat 1 (what
shipped) to "16 packages, published to npm" and go straight to the hard part.
**Floor: you must tell the hard part — the tool-emulation + the hallucinated-
filter bug and its fix.** That one story is the entire proof-of-real; the
package count and the rough-edge sentence are reinforcement you can drop.

## The one-page run sheet

```
  ┌─ THE BUILD STORY — 8:00 to 8:45 ─────────────────────────────────┐
  │ BEAT 1 (~10s) what shipped: "16 packages on npm, 6 agents,       │
  │   Studio, + buffr swaps in-memory store for live Supabase        │
  │   pgvector — same contract."                                     │
  │ BEAT 2 (~25s) THE HARD PART (the spine):                         │
  │   • taught tool-less Gemma to call tools (render tools into      │
  │     prompt, parse JSON back, retry on bad JSON)                  │
  │   • that flushed a bug: hallucinated filter key wiped ALL        │
  │     results → fix: absent keys ignored → regression test         │
  │   • test name: "a hallucinated filter does not wipe results"     │
  │ BEAT 3 (~10s) own it: "in-browser demo uses a deterministic stub │
  │   embedder BY DESIGN — real one is nomic on Ollama, same contract"│
  │                                                                   │
  │ NAIL THIS LINE:                                                   │
  │   "The hard part: teaching a tool-less local model to call tools │
  │    — and the retrieval bug that uncovered, fixed and tested."    │
  │                                                                   │
  │ IF IT BREAKS: say it from memory; offer the file path, don't open.│
  │ TIGHTEN: cut beat 1 to one phrase. Floor: tell the hard part.    │
  └───────────────────────────────────────────────────────────────────┘
```
