# Chapter 3 — Under the Hood   (6:00–8:00, 2 minutes)

## Opening hook

The room has seen it work. Now they want one reason to believe you
built something *structurally* interesting and not just a script that
prints a hardcoded answer. You have two minutes. That is enough for
exactly one diagram and three sentences. It is not enough for an
architecture tour, and if you try to give one you'll lose the room you
just won.

Go exactly one level deep and stop. The one non-obvious thing worth
showing in AptKit is the **two ports** the whole toolkit hangs off —
the model provider and the vector store — plus the trick that makes a
tool-less local model behave like a tool-calling one. Show that, earn
the credibility, get out.

## The time-budget bar

You own two minutes. One diagram, the two ports, the tool-calling
trick. Then stop.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░ │
  │ 6:00 ──────── 8:00 ─────────────────────────── 10:00   │
  │     UNDER THE HOOD — you own 6:00 to 8:00 (2 min)     │
  └──────────────────────────────────────────────────────┘
```

## The one diagram — two ports and emulated tool-calling

This is the single technical picture. The agent loop in the middle
talks to two swappable contracts — a model provider port and a vector
store port. Swap the adapter behind either port and nothing in the
loop changes. The third piece is the part people don't expect: the
local Gemma adapter *emulates* tool-calling, because Gemma has no
native tool API.

```
  THE TWO PORTS + EMULATED TOOL-CALLING

  ┌─ Agent loop (runAgentLoop, @aptkit/runtime) ──────────────────┐
  │   model decides: answer now, or call search_knowledge_base    │
  └───────┬───────────────────────────────────────────┬──────────┘
          │ ModelProvider.complete()                   │ tool call
          │ (PORT 1)                                   │ → VectorStore
          ▼                                            ▼ (PORT 2)
  ┌─ model adapters ────────────┐          ┌─ vector adapters ──────────┐
  │  Anthropic │ OpenAI │ Gemma │          │ InMemoryVectorStore (now)  │
  │            │        │ (local│          │ PgVectorStore (buffr, live)│
  │            │        │ Ollama│          │ same VectorStore contract  │
  └────────────┴────────┴───┬───┘          └────────────────────────────┘
                            │
              ┌─────────────▼──────────────────────────────┐
              │ Gemma has NO native tools. So the adapter:  │
              │  out: renders tools into the system prompt, │
              │       demands a JSON tool call              │
              │  in:  parses the JSON back into a tool_use  │
              │       (parse-retry if Gemma botches it)     │
              └─────────────────────────────────────────────┘
```

## The three sentences

Said while pointing at the diagram — not read off it.

```
┃ "The whole toolkit depends on two contracts: a model provider
┃  and a vector store. The loop never knows which one it's talking
┃  to — Anthropic, OpenAI, or a local Gemma; in-memory or Postgres
┃  pgvector — it just calls the contract."
```

```
┃ "That's why the same agent runs in the browser, against a cloud
┃  model, or fully local with one line changed. Swap the adapter,
┃  not the loop."
```

```
┃ "The interesting part: Gemma has no tool-calling. So the local
┃  adapter fakes it — it renders the tools into the system prompt,
┃  asks for a JSON tool call, and parses it back. The loop above it
┃  can't tell the difference."
```

That last sentence is the one that lands, because it's the
non-obvious one. It's the load-bearing trick, and naming it signals
you built the thing rather than wired a library.

The real code: the ports are `ModelProvider` (`@aptkit/runtime`) and
`VectorStore` (`@aptkit/retrieval`); the emulation is
`GemmaModelProvider` in `packages/providers/gemma/src/gemma-provider.ts`
— it renders tools into system text on the way out and runs
`parseAgentJson` with a corrective retry on the way back.

## Strong vs weak — going one level deep

```
  WEAK under-the-hood                STRONG under-the-hood
  ─────────────────────────────      ──────────────────────────────
  walks all 16 packages, the         ONE diagram: two ports + the
  build chain, the npm bundling,     Gemma tool-call trick. Three
  the monorepo layout, the CI…       sentences. Done in 90 seconds.

  five diagrams, each half-          one diagram the room can hold;
  explained                          the surprising part named

  room loses the thread; the         room thinks "okay, this person
  wow from the demo evaporates        actually built it" and the wow
                                       from the demo is still warm
```

## IF IT BREAKS

This chapter has no live on-screen beat — it's one diagram on a
slide. The only failure mode is going long.

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS (running long)                                        ║
║ You hit 7:30 still talking → stop mid-sentence on the third        ║
║ sentence, say "and that local-model trick is the part I'd love to  ║
║ dig into in Q&A," and move to the close. Do not finish the         ║
║ explanation at the cost of the close.                              ║
╚══════════════════════════════════════════════════════════════════╝
```

## Tighten it

If the slot is tight, cut this to **one sentence and the diagram**:
"Everything hangs off two swappable contracts — model provider and
vector store — and the local Gemma adapter fakes tool-calling so the
loop doesn't care it's a local model." The floor: the two-ports idea
plus the emulation trick, in one breath, with the diagram up. If you
have to cut the whole chapter to protect the close, cut it — this is a
ceiling, not a floor.

## One-page run sheet — UNDER THE HOOD

```
  ┌──────────────────────────────────────────────────────────────┐
  │ UNDER THE HOOD         6:00–8:00          (no money shot)      │
  │                                                                │
  │ ONE DIAGRAM up: two ports + Gemma emulated tool-calling        │
  │                                                                │
  │ THREE SENTENCES (point, don't read):                           │
  │  • "Two contracts: a model provider and a vector store. The   │
  │     loop never knows which adapter it's talking to."          │
  │  • "Same agent: browser, cloud, or fully local — swap the     │
  │     adapter, not the loop."                                   │
  │  • "Gemma has no tool-calling, so the adapter fakes it —      │
  │     renders tools into the prompt, parses JSON back. The loop │
  │     can't tell." ← the one that lands                         │
  │                                                                │
  │ NAIL: the Gemma-fakes-tool-calling sentence                    │
  │ IF LONG: stop on sentence 3, "love to dig into that in Q&A,"   │
  │          move to close                                        │
  │ TIGHTEN: collapse to one sentence + diagram; cut whole chapter │
  │          before you cut the close                             │
  └──────────────────────────────────────────────────────────────┘
```
