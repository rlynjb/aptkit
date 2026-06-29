# Chapter 03 — Under the Hood   (6:00–8:00, 2 min)

## Opening hook

The room just saw a score land. Now they're wondering whether there's anything
behind it or whether it's a demo trick. You have two minutes to earn
credibility — and the trap here is going three levels deep and losing them.
**Go exactly one level deep and stop.** One diagram, three sentences. The
moment you start explaining cosine similarity math or the agent loop's turn
budget, you've left the demo behind and the clock is still running.

The one impressive, non-obvious thing in AptKit isn't the RAG result itself —
it's *why* the same code runs deterministically in a browser and live against a
local model with zero changes. The answer is two contracts and a tool. That's
the whole story you tell here.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ──────────────── 6:00 ──── 8:00 ───────────────── 10:00 │
  │     UNDER THE HOOD — you own 6:00 to 8:00 (2 min)          │
  └──────────────────────────────────────────────────────────┘
```

In two minutes: show one diagram — the two contracts plus emulated
tool-calling — and explain in three sentences why that boundary is what let
the demo be both safe and real.

## The chapter-opening diagram — the two contracts

This is the one diagram for this chapter. It's the seam that makes everything
else possible: the agent talks to two interfaces — a `ModelProvider` and a
`VectorStore` (via an `EmbeddingProvider`) — and never to a vendor directly.
Swap what's behind the interface, the agent doesn't notice.

```
  THE TWO CONTRACTS — same agent, swappable backs

  ┌─ Agent layer (packages/agents/rag-query) ──────────────────────┐
  │  RagQueryAgent.answer(question)  →  runAgentLoop (bounded)      │
  │  talks ONLY to two contracts, never a vendor SDK               │
  └───────┬─────────────────────────────────────────┬─────────────┘
          │ ModelProvider.complete()                 │ search_knowledge_base
          │ (the reasoning seam)                      │ tool → VectorStore
          ▼                                           ▼
  ┌─ Provider contract ──────────┐        ┌─ Retrieval contracts ──────────┐
  │ DEMO:   FixtureModelProvider │        │ EmbeddingProvider + VectorStore │
  │   (recorded Gemma responses) │        │ DEMO: keyword-hash embedder      │
  │ LIVE:   GemmaModelProvider   │        │   + InMemoryVectorStore (cosine) │
  │   (local Ollama, emulated    │        │ LIVE: OllamaEmbeddingProvider    │
  │    tool-calling)             │        │   (nomic, 768-dim) + InMemory    │
  │ also: Anthropic / OpenAI     │        │ buffr: PgVectorStore (pgvector)  │
  └──────────────────────────────┘        └──────────────────────────────────┘

  the demo and the live CLI are the SAME agent — only what sits
  behind the two contracts changed
```

The thing to make the room see: the deterministic browser demo and the live
local-model CLI are byte-for-byte the same agent code. Only the two boxes
behind the contracts swapped. That's the non-obvious win.

## The body — three sentences, then stop

Say these three things, in order, while pointing at the diagram. Resist adding
a fourth.

```
  SAY (out loud), pointing at the diagram
  ─────────────────────────────────────────────────────────────────
  1 (the seam):    "The agent only ever talks to two contracts — a
                    model provider and a vector store. It never knows
                    which vendor is behind them."
  2 (the payoff):  "So the browser demo and the live local model are
                    the exact same agent — I just swapped recorded
                    responses for a real Gemma, and an in-memory store
                    for the deterministic one. Nothing in the agent
                    changed."
  3 (the twist):   "And Gemma can't natively call tools — so the
                    provider EMULATES tool-calling: it renders the
                    tools into the prompt and parses a JSON tool call
                    back out. That's how a tool-less local model drives
                    the same loop a frontier model does."
```

```
  ┃ "Two contracts and a tool. That's the whole trick — swap the
  ┃  back, the agent doesn't notice, and a local model that can't
  ┃  call tools gets taught to anyway."
```

The emulated tool-calling claim is real and worth landing because it's the
genuinely non-obvious part: `packages/providers/gemma/src/gemma-provider.ts`
renders the tool schemas into the system text and demands a single JSON object
back (`{"tool": "...", "arguments": {...}}`), with a parse-retry nudge when
Gemma botches the JSON. Frontier models get a native `tools` array; Gemma
doesn't, so the provider fakes the protocol on both ends.

If a judge wants more — the cosine scan, the `minTopK` floor, the agent loop's
turn budget — that's a *post-clock* conversation (chapter 06), not this beat.
One level deep, then stop.

## The IF-IT-BREAKS box

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ This chapter has no live screen — it's one diagram you can put on  ║
║ a slide. If the slide won't show → draw the two boxes on a         ║
║ whiteboard or in the air with your hands: "model contract here,    ║
║ vector contract here, agent in the middle talks to both." The      ║
║ three sentences carry it with no visual at all.                    ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Running long? Drop sentence 3 (emulated tool-calling) and stop after the
payoff — the swappable-contracts point is the load-bearing one; the Gemma
tool-emulation twist is the bonus that impresses an AI judge. **Floor: you must
say sentence 1 and 2 (the seam and the payoff).** Without them the demo looks
like a single hardcoded page instead of a real agent on a real boundary.

## The one-page run sheet

```
  ┌─ UNDER THE HOOD — 6:00 to 8:00 ──────────────────────────────────┐
  │ ONE diagram: two contracts (ModelProvider + VectorStore via       │
  │   EmbeddingProvider) + emulated tool-calling.                     │
  │                                                                   │
  │ SAY, in order (point at the diagram):                             │
  │   1. seam: "the agent only talks to two contracts, never a vendor"│
  │   2. payoff: "browser demo and live Gemma are the SAME agent —    │
  │      I just swapped what's behind the contracts"                  │
  │   3. twist: "Gemma can't call tools natively — the provider       │
  │      emulates it: renders tools into the prompt, parses JSON back"│
  │                                                                   │
  │ NAIL THIS LINE:                                                   │
  │   "Two contracts and a tool. That's the whole trick."             │
  │                                                                   │
  │ ONE LEVEL DEEP, THEN STOP. Cosine / turn budget = ch06, post-clock.│
  │ IF IT BREAKS: draw two boxes in the air; sentences carry it.      │
  │ TIGHTEN: drop sentence 3. Floor: keep seam + payoff.              │
  └───────────────────────────────────────────────────────────────────┘
```
