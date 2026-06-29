# Chapter 02 — The Demo   (1:00–6:00, 5 min)

## Opening hook

This is the chapter that wins or loses the room. You have five minutes, and
the rule that matters most: **the money shot lands at ~2:30 — inside the first
third — not at minute five.** A demo that buries its best moment past the
halfway mark is the most common loss you'll see. You front-load the "oh," then
spend the rest of the budget earning depth you've already paid for.

You have an unusually safe centerpiece. The money shot runs in the browser
with no backend: a deterministic keyword-hash embedder, an in-memory vector
store, and recorded model responses (`apps/studio/src/agent-runners.ts`,
`runRagQueryFixtureReplay`). It cannot hit a flaky network on stage, and it
produces the same correct, scored result every time. So the choreography is
simple: get to the score fast, let it sit, then show the room two more beats
that prove the toolkit is real.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 1:00 ──────────────────── 6:00 ─────────────────────── 10:00 │
  │     THE DEMO — you own 1:00 to 6:00 (5 min)                 │
  │     ★ money shot at ~2:30                                   │
  └──────────────────────────────────────────────────────────┘
```

In these five minutes: land the scored cited answer by 2:30 (beat 1), replay a
real agent trace (beat 2), and — if Ollama is up — show the same stack live in
the terminal (beat 3).

## The chapter-opening diagram — the click-path

This is the exact path through the running app. Three beats, front-loaded so
the strongest moment is the earliest.

```
  THE CLICK-PATH — three beats, money shot first

  BEAT 1  (1:00–2:45)  ★ money shot ~2:30
  ┌─ #rag-query ──────────────────────────────────────────────┐
  │ pick "Two-part question..." → [Run fixture]                │
  │   → Answer panel fills: grounded text + [work.md][coffee.md]│
  │   → Retrieved chunks: relevant rows turn GREEN, scores show │
  │   → Eval: Passing · Precision@1: 1.00 · Recall@3: 1.00  ★   │
  └────────────────────────────────────────────────────────────┘
                              │  "this is a real agent loop, recorded"
                              ▼
  BEAT 2  (2:45–4:15)
  ┌─ an analytics agent page (AgentReplayShell) ──────────────┐
  │ Run a fixture → step / tool_call / model_usage trace plays │
  │   → same CapabilityEvent trace, from a real recorded run   │
  └────────────────────────────────────────────────────────────┘
                              │  "and it runs locally, no cloud"
                              ▼
  BEAT 3  (4:15–5:30)  [skip if Ollama is down]
  ┌─ terminal ────────────────────────────────────────────────┐
  │ npm run ask -w @aptkit/agent-rag-query -- "..."            │
  │   → Gemma (local) + real embeddings answer, cited           │
  └────────────────────────────────────────────────────────────┘

  buffer 5:30–6:00 — breathing room before under-the-hood
```

The shape to hold: beat 1 is the wow and it's safe; beats 2 and 3 are
credibility — proof the scored result isn't a one-off mock but one instance of
a real agent loop that also runs against a live local model.

## The body — the beats in order

### Beat 1 — the money shot (1:00–2:45, the "oh" at ~2:30)

You're already on the RAG Query Agent page from the cold open. Pick the
two-part question fixture (`Two-part question answered from two different
notes`) — it's the strongest because the room watches *two* different notes get
retrieved and *two* citations land. Then click `Run fixture` and let it work.
The discipline here: **speak value while your hands click. Do not narrate the
clicks.**

```
  SHOW (on screen)                   SAY (out loud)
  ─────────────────────────────      ─────────────────────────────────────
  question selected: "What does      "Here's a personal-notes corpus — three
  the author do for work, and how    short notes. I ask one question that
  do they take their coffee?"        spans two of them."
  click [Run fixture]                "Watch three things happen at once."
  Answer panel fills with grounded   "It answers in plain language — and
  text ending in [work.md]           every claim carries the note it came
  [coffee.md]                        from. work-dot-md, coffee-dot-md."
  Retrieved chunks: work.md and      "Underneath, you can see exactly which
  coffee.md rows turn GREEN with     chunks it pulled — the relevant ones
  cosine scores; coffee.md is        light up green, scored by similarity."
  relevant, others dim
  Eval row: Passing ·                "And here's the part teams fight about
  Precision@1 1.00 · Recall@3 1.00   in code review — a retrieval-quality
                                     SCORE. Top result is correct: precision
                                     one-point-oh. Every relevant note
                                     retrieved: recall one-point-oh."   ← ★
  let it sit for a beat. Don't       (silence — let the room read the 1.00)
  click anything.
```

The money-shot line — say it clean, then stop talking for a second:

```
  ┃ "There's the whole argument settled in a number: a grounded,
  ┃  cited answer, scored one-point-oh on precision and recall —
  ┃  and there's no backend. This ran entirely in your browser."
```

Then the line that converts the wow into credibility before you move on:

```
  ┃ "That's a real retrieval pipeline — a real embedder, a real
  ┃  vector store, a real agent loop — just made deterministic so
  ┃  it can't lie to you on stage."
```

That `precision@1 = 1.00 / recall@3 = 1.00` sitting next to a correct cited
answer **is the money shot.** It's computed live by `scorePrecisionAtK` /
`scoreRecallAtK` from `@aptkit/evals` against the chunks the agent actually
retrieved — not a hardcoded label. Name that, because a judge who builds AI
will clock the difference.

### Beat 2 — replay a real agent trace (2:45–4:15)

Now prove the loop is general, not bespoke to one page. Go Home, open one of
the analytics agents (recommendation or anomaly-monitoring — they use the
shared `AgentReplayShell`), and run a fixture. The point isn't the analytics
output; it's the **trace**.

```
  SHOW (on screen)                   SAY (out loud)
  ─────────────────────────────      ─────────────────────────────────────
  Home → open Recommendation         "That scored RAG agent isn't a special
  agent → Run fixture                case. It's one instance of a bounded
                                     agent loop the whole toolkit shares."
  the trace panel plays:             "This is a different agent replaying a
  step → tool_call_start →           real recorded run — same trace format:
  tool_call_end → model_usage        every step, every tool call, every
                                     token of model usage, captured."
  point at a tool_call_end           "When something goes wrong in an agent,
                                     this trace is how you debug it — and how
                                     the evals catch a regression before it
                                     ships."
```

```
  ┃ "Same loop, same trace, different agent — the score you just
  ┃  saw is one capability built on plumbing every agent reuses."
```

### Beat 3 — the local model, live (4:15–5:30) — skip if Ollama is down

If — and only if — Ollama is running with `gemma2:9b` and
`nomic-embed-text:v1.5` pulled, drop to the terminal and run the same stack for
real. This is the beat that proves "in-browser deterministic" was a *choice*,
not a limitation: the identical agent answers a live question against a real
local model with real embeddings.

```
  SHOW (on screen)                   SAY (out loud)
  ─────────────────────────────      ─────────────────────────────────────
  terminal:                          "What you saw in the browser was a
  npm run ask -w                     recording. Here's the same agent against
  @aptkit/agent-rag-query --         a real local model — Gemma, running on
  "What do I use for embeddings?"    this laptop, no cloud, no API key."
  "Indexing 3 documents..." then     "Real embeddings, real retrieval, and
  a grounded, cited answer prints    Gemma reasoning over the chunks — cited
                                     the same way."
```

```
  ┃ "Browser version's a recording so it can't break on stage —
  ┃  but the model is real, and it's running right here, offline."
```

This beat is the first thing to cut. It depends on a live local model, which
is exactly the kind of thing that fails on conference wifi and a cold laptop.
Treat it as a bonus, never a dependency.

### The strong-vs-weak demo move

The failure mode this demo most invites — and the move that beats it:

```
  WEAK demo move                     STRONG demo move
  ─────────────────────────────      ─────────────────────────────────────
  "Now I'm clicking Run. Okay, it's  Hands click Run; mouth says "watch
  loading. Now you can see the       three things happen at once" then names
  answer here, and these are the     the VALUE — grounded, cited, scored —
  chunks, and this number here is    while the screen fills. The score gets
  the precision..." (narrating       a beat of silence to land, not a label
  the cursor)                        read aloud.
  → the room watches a cursor        → the room reacts to a result
```

Narrating your own clicks is the single most common way a strong demo goes
flat. The SHOW track is for your hands; the SAY track is for value. Keep them
separate.

## The IF-IT-BREAKS box

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ Dev server won't start / page is dead → switch to the GitHub      ║
║ Pages STATIC_DEMO build (base /aptkit/), route #rag-query. It's    ║
║ the same page, fixture-only, already deployed. Say: "let me run    ║
║ the deployed build" and click Run fixture there — the score lands  ║
║ identically.                                                       ║
║                                                                    ║
║ Pages build is ALSO blank → drop to the saved screenshots of the   ║
║ passing scored result. Say: "here's the result from a run a few    ║
║ minutes ago" and walk the answer → green chunks → 1.00 score from  ║
║ the image. Keep the energy up; never apologize twice.              ║
║                                                                    ║
║ Beat 3 (Ollama) fails → just skip it. It's a bonus, not the spine. ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Running long? Cut beat 3 (the live `ask` CLI) entirely — it's a bonus and the
riskiest beat. If you're still long, compress beat 2 to a single sentence over
one fixture run ("same loop, different agent, same trace"). **Floor: beat 1
must run to completion and the room must see precision@1 = 1.00 land next to
the cited answer.** That's the demo. Everything else is reinforcement.

## The one-page run sheet

```
  ┌─ THE DEMO — 1:00 to 6:00 ────────────────────────────────────────┐
  │ ★ MONEY SHOT at ~2:30: precision@1 1.00 + recall@3 1.00 next to  │
  │   a grounded, cited answer — in-browser, no backend.             │
  │                                                                   │
  │ BEAT 1 (1:00–2:45) #rag-query, pick "Two-part question", Run:    │
  │   • "ask one question spanning two notes — watch three things"   │
  │   • answer is grounded + cited [work.md][coffee.md]              │
  │   • relevant chunks light up green, scored                       │
  │   • Eval Passing, Precision@1 1.00, Recall@3 1.00  ← let it sit  │
  │ BEAT 2 (2:45–4:15) open Recommendation agent, Run fixture:       │
  │   • "same loop, different agent" — point at the step/tool trace  │
  │ BEAT 3 (4:15–5:30) [Ollama up only] terminal: npm run ask:       │
  │   • "browser was a recording; the model is real and offline"     │
  │                                                                   │
  │ NAIL THIS LINE:                                                   │
  │   "There's the whole argument settled in a number — grounded,     │
  │    cited, scored one-point-oh, and no backend."                  │
  │                                                                   │
  │ DON'T narrate clicks. Hands click; mouth speaks value.            │
  │ IF IT BREAKS: → Pages build #rag-query → screenshots. Skip beat3.│
  │ TIGHTEN: cut beat 3, then compress beat 2. Floor: beat 1 + 1.00. │
  └───────────────────────────────────────────────────────────────────┘
```
