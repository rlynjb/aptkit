# Chapter 2 — The Demo   (1:00–6:00, 5 minutes)

## Opening hook

This is the chapter that wins or loses the demo. Five minutes, the
biggest budget in the slot, and one job: make the room *see the thing
work* — not hear about it. You already opened on the RAG page running.
Now you walk it deliberately so the room understands what they just
saw, then you fire the money shot inside the first third of the whole
slot, around 3:00.

The money shot here is specific and you should be able to point at it:
**the eval score reading "Passing / Precision@1 1.00 / Recall@3 1.00"
sitting directly beside a correct, cited answer.** That side-by-side
is the "oh" moment. Most demos show an answer and ask you to trust it.
You show an answer *and a measurement that says it's right*, computed
live, in the browser. That's the beat the room repeats afterward.

Three real beats, all verified in `apps/studio/src/`:

  1. The RAG Query page — the money shot (1:00–3:30)
  2. A real agent replay trace — proof the loop is real (3:30–5:00)
  3. The local `ask` CLI — proof it runs against a real local model
     (5:00–6:00, the first beat to cut if you're long)

## The time-budget bar

You own five minutes — the centerpiece. The money shot fires by 3:00.

```
  ┌──────────────────────────────────────────────────────┐
  │ ░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ──────────── 3:00 ★ ──────── 6:00 ──────── 10:00  │
  │     THE DEMO — you own 1:00 to 6:00 (5 min)            │
  │            ★ money shot lands ~3:00                     │
  └──────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the click-path

Here is the exact sequence of screens for all three beats. You walk
it left to right; the star marks the money shot.

```
  CLICK-PATH — three beats, screens in order

  BEAT 1: RAG Query page (#rag-query)        BEAT 2: replay trace
  ┌─────────────────────────┐               ┌─────────────────────────┐
  │ question pre-loaded      │               │ Recommendation / any    │
  │   ↓ click Run fixture    │               │ AgentReplayShell page   │
  │ chunks light up          │               │   ↓ click Run fixture   │
  │ (relevant = highlighted) │               │ trace streams:          │
  │   ↓                      │               │  step → tool_call_start │
  │ answer w/ [citations]    │               │  → tool_call_end →      │
  │   ↓                      │               │  model_usage            │
  │ ★ EVAL: Passing 1.00 ★   │               │ (a real CapabilityEvent │
  │   beside the answer      │               │  trace, not a mockup)   │
  └─────────────────────────┘               └─────────────────────────┘
            │                                          │
            └──────────────┬───────────────────────────┘
                           ▼
              BEAT 3 (optional): terminal — `npm run ask`
              ┌─────────────────────────────────────────┐
              │ Gemma (local, Ollama :11434) + real RAG  │
              │  → tool: search_knowledge_base(...)       │
              │  ← retrieved N chunks                     │
              │  A: grounded answer, no cloud call        │
              └─────────────────────────────────────────┘
```

## Beat 1 — the RAG Query page and the money shot (1:00–3:30)

This is `RagQueryWorkspace` (`apps/studio/src/RagQueryWorkspace.tsx`).
You may have already run it once in the cold open — that's fine. Now
you slow down and let the room read each part. If you want a clean
populate for the room, pick the second fixture from the dropdown
("What does the author use to run AI models locally?") so they watch
it fill from empty.

```
  SHOW (on screen)                   SAY (out loud)
  ─────────────────────────────      ──────────────────────────────
  the question at the top:           "I'm asking a question across a
  "What does the author use to        small set of personal notes.
  run AI models locally?"             The agent decides on its own
                                       whether it needs to search."

  click Run fixture                  "Watch the retrieval panel."

  Retrieved chunks panel fills;      "It pulled three chunks and
  stack.md highlighted as relevant,   ranked them. The one it needs —
  others dimmed; scores shown         my stack note — scores highest
                                       and lights up as relevant."

  Answer panel fills with text       "Here's the answer — and it
  ending in [stack.md]                cites the note it came from.
                                       That bracket is a real citation,
                                       not decoration."

  Eval panel: Passing /              "And THIS is the part I care
  Precision@1 1.00 / Recall@3 1.00   about. Right next to the answer,   ★
  beside the answer                   the eval scored the retrieval:    MONEY
                                       precision one, recall one.        SHOT
                                       The system measured that it got
                                       the right source. Live. No
                                       backend — this is all running
                                       in your browser."
```

The money-shot line, said with the eval panel and the answer both on
screen:

```
┃ "That's the whole point — the answer is cited, and the score
┃  next to it says the retrieval was actually correct. Most demos
┃  ask you to trust the answer. This one measures it."
```

Then name the honest edge before anyone wonders — owning it reads as
confidence, not weakness:

```
┃ "To be clear: in the browser this uses a deterministic stub
┃  embedder so the demo can't flake on stage. The real pipeline
┃  uses local Ollama embeddings — and I'll show you that running
┃  for real in a second."
```

That's true: the in-browser embedder is the 64-dimension keyword-hash
`makeFixtureEmbedder` in `apps/studio/src/agent-runners.ts`, feeding a
real `InMemoryVectorStore` and the real `scorePrecisionAtK` /
`scoreRecallAtK` scorers from `@aptkit/evals`. The retrieval and the
scoring are real; only the embedder is stubbed for determinism.

## Beat 2 — the replay trace, proof the loop is real (3:30–5:00)

Money shot landed. Now you earn credibility: this isn't a hardcoded
string, it's a real agent loop emitting a real event trace. Open any
shared-shell agent page (`AgentReplayShell` — Recommendation,
Monitoring, Diagnostic, Query) and run a fixture so the room sees the
trace stream.

```
  SHOW (on screen)                   SAY (out loud)
  ─────────────────────────────      ──────────────────────────────
  switch to an agent page            "That answer came out of a real
  (e.g. Recommendation), the          agent loop — not a hardcoded
  trace panel visible                 string. Here's another agent on
                                       the same engine."

  click Run fixture; trace            "This is the actual event trace:
  panel streams events:               the model takes a step, calls a
  step → tool_call_start →            tool, gets a result, reports its
  tool_call_end → model_usage         token usage. Every agent in the
                                       toolkit emits this same trace."

  point at the eval / passing         "And every one is checked by an
  indicator                           eval too — that's how I know a
                                       change didn't break it."
```

```
┃ "Same engine, same trace, same eval gate — every capability in
┃  the toolkit is built the same way."
```

## Beat 3 — the local `ask` CLI (5:00–6:00, cut first if long)

If you have the minute and a terminal ready, this is the strongest
"it's real" proof: the same agent running against a **real local
model** — Gemma via Ollama — with real embeddings, no cloud. This is
`packages/agents/rag-query/scripts/ask.ts`.

```
  SHOW (on screen)                   SAY (out loud)
  ─────────────────────────────      ──────────────────────────────
  terminal:                          "Same agent, but now against a
  npm run ask -w                      real local model — Gemma, running
  @aptkit/agent-rag-query             through Ollama on my machine.
  -- "what do I use for               No cloud, no API key."
  embeddings and how's my coffee?"

  output streams:                    "It indexes the notes with real
  Indexing 3 documents...             local embeddings, the model
  → tool: search_knowledge_base(…)    decides to search, retrieves the
  ← retrieved N chunks                chunks, and answers grounded —
  A: grounded answer                  in my voice, because the profile
                                       is injected into the prompt."
```

```
┃ "This is the same toolkit running entirely on my laptop —
┃  local model, local embeddings, no network in the loop."
```

## IF IT BREAKS

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ BEAT 1 (money shot) — the page won't populate:                     ║
║   → open the static GitHub Pages build (base /aptkit/, #rag-query),║
║     same fixture-only page, no dev server. Run it there.           ║
║   → page still blank → money-shot screenshot (slide 2): answer +   ║
║     eval panel side by side. Say "here's a run from earlier" and   ║
║     deliver the money-shot line over the screenshot.               ║
║                                                                    ║
║ BEAT 3 (CLI) — Ollama isn't responding / model not pulled:         ║
║   → DON'T debug on stage. Cut beat 3 entirely. You already showed  ║
║     real retrieval + the real loop in beats 1–2. Say: "that same   ║
║     thing runs against a local Gemma model on my laptop — happy    ║
║     to show it after." Move to the close.                          ║
║                                                                    ║
║ Rule: never freeze, never apologize twice, keep the clock moving.  ║
╚══════════════════════════════════════════════════════════════════╝
```

## Tighten it

Cut beats from the bottom up. **First cut: beat 3 (the CLI).** Beats
1 and 2 already prove real retrieval, real loop, real eval — the CLI
is the bonus. **Second cut: beat 2** down to a single sentence
("every agent runs on this same traced, eval-gated loop") while you
stay on the RAG page. The floor you must never cut: **beat 1 through
the money shot** — the room has to see the eval score land next to the
cited answer. That is the demo. Everything else is supporting evidence.

## One-page run sheet — THE DEMO

```
  ┌──────────────────────────────────────────────────────────────┐
  │ THE DEMO          1:00–6:00          ★ MONEY SHOT ~3:00        │
  │                                                                │
  │ BEAT 1 — RAG page (#rag-query), pick 2nd fixture, Run:         │
  │  • "Asking a question across personal notes; the agent        │
  │     decides whether to search."                               │
  │  • "Watch the retrieval panel — it ranked the chunks; the     │
  │     one it needs lights up as relevant."                      │
  │  • "The answer cites its source — real citation."             │
  │  • ★ "And next to the answer, the eval: precision one, recall │
  │     one. It MEASURED that it got the right source. Live, in   │
  │     your browser, no backend."                                 │
  │  • OWN IT: "browser uses a deterministic stub embedder so it  │
  │     can't flake; real pipeline uses local Ollama embeddings." │
  │                                                                │
  │ BEAT 2 — any AgentReplayShell page, Run fixture:               │
  │  • "Real agent loop, not a hardcoded string — here's the      │
  │     event trace: step → tool call → usage. Every agent emits  │
  │     it, every one is eval-gated."                             │
  │                                                                │
  │ BEAT 3 (cut first) — terminal: npm run ask -w …rag-query:      │
  │  • "Same agent against a real local model — Gemma on Ollama,  │
  │     real embeddings, no cloud."                               │
  │                                                                │
  │ NAIL: money-shot line — "the answer is cited, and the score   │
  │       says the retrieval was correct. Most demos ask you to   │
  │       trust it; this one measures it."                        │
  │ IF IT BREAKS: static Pages #rag-query → screenshot; CLU fails  │
  │       → cut beat 3, mention it, move on.                      │
  │ TIGHTEN: cut beat 3, then beat 2; never cut beat 1 money shot. │
  └──────────────────────────────────────────────────────────────┘
```
