# Chapter 4 — The Build Story   (8:00–8:45, 45 seconds)

## Opening hook

Forty-five seconds. This is the chapter that separates a working build
from a pitch deck. The room has seen the demo and one diagram; now you
prove it's real with two things and nothing more: **what actually
shipped**, and **the one hard part you cracked**. No feature tour. No
roadmap. Two beats, fast, then out.

The mistake here is listing everything. You don't have time and the
room doesn't care about the count — they care that there's a genuine
obstacle behind the polish. So lead with the scale in one line, then
spend most of the budget on the hard part, because the hard part is
the proof.

## The time-budget bar

You own forty-five seconds. One line on what shipped, then the hard
part. That's it.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓░░░░░░░░░░░ │
  │ 8:00 ─ 8:45 ─────────────────────────────────── 10:00  │
  │     BUILD STORY — you own 8:00 to 8:45 (45 sec)       │
  └──────────────────────────────────────────────────────┘
```

## The diagram — what shipped, and where the hard part lived

The shape of the build: a bundle published to npm, the agents and
Studio on top, and one red box marking where the genuine bug lived.

```
  WHAT SHIPPED — and the hard part (red box)

  ┌─ published ──────────────────────────────────────────────────┐
  │ @rlynjb/aptkit-core  →  npm, 16 packages bundled into one tar │
  └───────────────────────────────────────────────────────────────┘
         │ consumed by
         ▼
  ┌─ agents (6, same shape) ─┐   ┌─ Studio ──────────┐  ┌─ evals ──┐
  │ query · recommendation · │   │ React+Vite, hash- │  │ precision│
  │ monitoring · diagnostic ·│   │ routed, static    │  │ @k /     │
  │ rubric · rag-query       │   │ GitHub Pages demo │  │ recall@k │
  └────────────┬─────────────┘   └───────────────────┘  └──────────┘
               │ the rag-query agent runs against a local model…
               ▼
  ┌─ THE HARD PART ───────────────────────────────────────────────┐
  │ teaching a tool-LESS local model (Gemma) to call tools —       │
  │ and the bug it caused: a hallucinated filter wiping retrieval  │
  │ → fixed in search_knowledge_base + a regression test           │
  └───────────────────────────────────────────────────────────────┘

  (buffr, the companion repo, graduates the same toolkit to a live
   Supabase pgvector store — future, see the close)
```

## Beat 1 — what shipped (8:00–8:15)

One line, said fast.

```
┃ "What's real: a sixteen-package toolkit published to npm as one
┃  bundle, six agents built on the same loop, Studio with a static
┃  demo, and an eval suite that scores retrieval. All of it ships."
```

## Beat 2 — the hard part (8:15–8:45)

This is where the budget goes. The genuine obstacle, the bug it
caused, and the fix — in the voice of someone who hit it and shipped
through it.

```
┃ "The hard part: I wanted the agent to run on a local model —
┃  Gemma through Ollama — but Gemma has no tool-calling at all. So
┃  I taught it: render the tools into the prompt, demand JSON, parse
┃  it back, retry if it's malformed."
```

```
┃ "And that broke retrieval in a way I didn't expect. The weak
┃  model would hallucinate a filter argument — a key that didn't
┃  exist — and the naive filter wiped every result to zero. So a
┃  question that should've been answered came back empty. I fixed
┃  it: a filter key now only excludes a chunk that HAS that key with
┃  a different value — a hallucinated key is ignored. Plus a top-k
┃  floor so the model can't starve a multi-part question, and a
┃  regression test so it stays fixed."
```

That's the build story. It's true and it's verifiable: the emulation
lives in `gemma-provider.ts`; the hallucinated-filter fix is
`matchesFilter` in
`packages/retrieval/src/search-knowledge-base-tool.ts` (a filter key
only excludes hits that *have* that key with a different value); the
`minTopK` floor is in the same file; the regression test is
`packages/retrieval/test/search-knowledge-base-tool.test.ts`.

## Own the rough edge

Say this plainly — it reads as confidence, and a judge who spots it
unprompted respects you more for naming it first:

```
┃ "The honest rough edge: the in-browser demo uses a deterministic
┃  stub embedder by design, so it can't flake on stage. The real
┃  embeddings run through local Ollama — which you saw in the CLI."
```

## Strong vs weak — the build story

```
  WEAK build story                   STRONG build story
  ─────────────────────────────      ──────────────────────────────
  "We built sixteen packages, an     "Sixteen packages on npm, six
  agent loop, five providers, a       agents, a static demo — all
  Studio, an eval suite, content      ships. The hard part: a local
  workflows, memory, prompts,         model with no tool-calling, the
  policies…" (a feature inventory)    retrieval bug it caused, the fix
                                       and the regression test."

  room hears a list, believes        room hears a real obstacle
  none of it specifically            cracked, believes the whole thing
```

## IF IT BREAKS

No live beat here — it's spoken over the diagram slide. The only risk
is overrunning.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS (running long)                                        ║
║ You're past 8:45 → drop beat 1 entirely (the "what shipped" line)  ║
║ and keep only the hard part. The hard part is the proof; the       ║
║ inventory is skippable. Get to the close by 8:50 at the latest.    ║
╚══════════════════════════════════════════════════════════════════╝
```

## Tighten it

If the slot is tight, cut beat 1 and compress the hard part to one
sentence: "The hard part was teaching a tool-less local model to call
tools — and fixing the retrieval bug when it hallucinated a filter
that wiped every result." The floor: the hard part must survive in
some form. It's the only thing in this chapter that's load-bearing —
cut the inventory before the obstacle.

## One-page run sheet — BUILD STORY

```
  ┌──────────────────────────────────────────────────────────────┐
  │ BUILD STORY            8:00–8:45          (no money shot)      │
  │                                                                │
  │ BEAT 1 (15s) — what shipped, one line:                         │
  │  • "16-package toolkit on npm, 6 agents on one loop, Studio    │
  │     with a static demo, an eval suite that scores retrieval."  │
  │                                                                │
  │ BEAT 2 (30s) — the hard part (spend the budget here):          │
  │  • "Local model — Gemma — has no tool-calling, so I taught it: │
  │     render tools into the prompt, demand JSON, parse, retry."  │
  │  • "It hallucinated a filter that wiped every result. Fix: a   │
  │     filter key only excludes a chunk that HAS it; ignore       │
  │     hallucinated keys. Plus a top-k floor and a regression     │
  │     test."                                                     │
  │                                                                │
  │ OWN IT: "browser uses a stub embedder by design; real          │
  │          embeddings run on local Ollama."                      │
  │ NAIL: the hard-part two-liner                                  │
  │ IF LONG: drop beat 1, keep the hard part                       │
  │ TIGHTEN: hard part to one sentence; never cut the hard part    │
  └──────────────────────────────────────────────────────────────┘
```
