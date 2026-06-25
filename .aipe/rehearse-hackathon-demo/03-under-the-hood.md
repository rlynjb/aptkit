# Chapter 3 — Under the hood   (6:00–8:00, 2 minutes)

## Opening hook

You've shown the room the thing working and the score landing. Now they're wondering whether there's anything real underneath, or whether it's a pretty wrapper over an API call. Two minutes to answer that — and the trap here is going too deep. The presenter who pulls up four files and starts explaining the type system loses the room as surely as the one who shows nothing. Under-the-hood is one diagram and three sentences. You go exactly one level deep, earn the credibility, and stop before you lose them.

You have one genuinely non-obvious mechanism worth showing, and it's the line you planted in the cold open: you ran a local model you had to teach to call tools. Gemma — the local model — has no native tool-calling. So aptkit renders the tool definitions into the prompt as text, and parses the model's JSON reply back into a real tool call. That's the thing to show. It's impressive because it's not obvious it's even possible, and it's the seam that makes the whole "no cloud" claim true.

## The time-budget bar

You own two minutes here. One diagram, three sentences of depth, then hand off to the build story.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░ │
  │ 0:00              6:00 ──────── 8:00 ─────────────  10:00 │
  │        UNDER THE HOOD — you own 6:00 to 8:00 (2 min)     │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — two contracts + emulated tool-calling

This is the only diagram you draw in this chapter, and it shows two things at once: the two contracts that make everything swappable, and the emulated tool-calling that makes a tool-less local model behave like a tool-calling one.

```
  THE SEAM THAT MAKES "NO CLOUD" WORK

  ┌─ Agent (rag-query) ──────────────────────────────────────┐
  │  runs a bounded loop, asks the model what to do next      │
  └───────────────────────────────┬──────────────────────────┘
                                  │ talks to ONE contract, not an SDK
  ┌─ Contract #1: ModelProvider.complete() ──▼───────────────┐
  │  swap the model without touching the agent                │
  └───────────────────────────────┬──────────────────────────┘
                                  │ the Gemma adapter implements it…
  ┌─ Gemma provider (local, via Ollama) ─────▼───────────────┐
  │                                                          │
  │  Gemma has NO native tool-calling. So the adapter:       │
  │                                                          │
  │   1. renders the tool's JSON schema INTO the system      │
  │      prompt as text  ("respond with JSON to use a tool") │
  │                              │                            │
  │   2. Gemma replies:  {"tool":"search_knowledge_base",    │
  │                       "arguments":{"query":"…"}}          │
  │                              │                            │
  │   3. parseToolCall decodes that JSON → a real tool_use   │
  │      block the loop understands                          │
  │                              │                            │
  │   ↑ bad JSON?  append RETRY_NUDGE, ask once more;        │
  │     still bad → treat as plain text (graceful, no crash) │
  └───────────────────────────────┬──────────────────────────┘
                                  │ the tool itself is behind…
  ┌─ Contract #2: VectorStore ───────────────▼───────────────┐
  │  InMemoryVectorStore here · PgVectorStore in buffr        │
  │  swap the store the same way — one line, agent unchanged  │
  └──────────────────────────────────────────────────────────┘
```

The whole chapter is that diagram. Two contracts down the middle — one for the model, one for the store — and between them, the trick that earns the demo: teaching a model with no tool support to call tools by rendering schemas into text and parsing JSON back out.

## The body — three sentences, then stop

You do not walk every box. You say three sentences and point at the part that matters. Here's the SAY track, and it is the whole body of this chapter.

```
  SHOW (on screen / on the diagram)     SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  point at the two contracts            "The whole thing hangs on two
  in the middle of the diagram          contracts. The agent talks to one
                                        interface for the model and one for
                                        the vector store — so I can swap
                                        either without touching the agent."

  point at the Gemma adapter            "Here's the part I'm proudest of.
  and the JSON it emits                 The local model, Gemma, has no
                                        tool-calling. So I render the tool
                                        definitions into the prompt as text,
                                        the model replies with JSON, and I
                                        parse that JSON back into a real
                                        tool call. I taught a tool-less
                                        model to call tools."

  point at the RETRY_NUDGE line         "And when the JSON comes back
                                        malformed — which it does — it gets
                                        one nudge to fix it, then falls back
                                        to plain text instead of crashing."
```

That's three sentences of depth. The single line that lands this chapter:

```
  ┃ "Gemma can't call tools. So I taught it to — render the
  ┃  schema into the prompt, parse the JSON it sends back. That
  ┃  one trick is why the whole thing runs with no cloud."
```

Then you stop. The instinct will be to keep going — to explain `minTopK`, the loop budgets, the trace events. Don't. Every extra sentence past "I taught it to call tools" trades credibility for confusion. If a judge wants the parsing internals, they'll ask in Q&A, and chapter 06 has the answer ready.

#### Strong vs weak — how deep to go

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK (too deep)              │ STRONG (one level, then stop)│
├──────────────────────────────┼──────────────────────────────┤
│ "So in the Gemma provider    │ "Gemma has no tool-calling,  │
│ there's a buildSystemText     │ so I render the tool schema  │
│ function that takes the tool  │ into the prompt and parse    │
│ definitions and serializes    │ the JSON it replies with     │
│ them, and then parseToolCall  │ back into a real tool call.  │
│ runs a regex to extract the   │ One trick — that's why it    │
│ JSON, and if maxToolCall-     │ runs with no cloud."         │
│ Attempts isn't exceeded…"     │ [stops, takes a breath]      │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ You've lost the non-coders   │ One non-obvious idea, stated │
│ in the room and the coders   │ cleanly. Earns "huh, that's  │
│ are now nitpicking your       │ clever" from the engineers   │
│ regex. Depth past the point   │ and "I get it" from everyone │
│ of the idea costs you.        │ else. Leaves room for Q&A.   │
└──────────────────────────────┴──────────────────────────────┘
```

## The IF-IT-BREAKS box

This chapter is a diagram, not a live screen — so the failure mode isn't a crash, it's a question you can't field or a slide that won't load. Recovery:

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — under the hood                                ║
║                                                              ║
║  Your diagram slide won't load → draw it. Three boxes:        ║
║  "model contract → Gemma adapter → store contract," and       ║
║  the one arrow that matters: "schema into prompt → JSON out   ║
║  → parsed into a tool call." You know this cold; the marker   ║
║  works without a projector.                                   ║
║                                                              ║
║  A judge derails you into deep internals mid-explanation →    ║
║  "Great question — let me park that for after, I want to       ║
║  keep us on time" and finish your three sentences. You        ║
║  control the clock, not the heckler.                          ║
╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

This is the first chapter to cut when you're running long — it has a ceiling, and the demo has the floor. If you're past 8:00 coming out of the demo, drop the two-contracts sentence entirely and say only the tool-calling line: "Gemma can't call tools, so I taught it to — that's why it runs with no cloud." The floor: **the room hears that you taught a local model to call tools.** That one sentence is the credibility this chapter exists to earn; everything else is supporting it.

## One-page run sheet — UNDER THE HOOD

```
  UNDER THE HOOD     6:00 – 8:00          (no money shot)

  ONE DIAGRAM
    two contracts (model + store) down the middle; between them,
    the Gemma adapter: schema → prompt, JSON → parsed tool call

  SAY, IN ORDER (three sentences, then STOP)
    1. "Two contracts — one for the model, one for the store.
        Swap either without touching the agent."
    2. THE LINE: "Gemma has no tool-calling, so I taught it to —
        render the schema into the prompt, parse the JSON back
        into a real tool call. That's why it runs with no cloud."
    3. "Bad JSON gets one nudge, then falls back to text — no
        crash."
    → then STOP. Don't explain minTopK, budgets, trace events.

  IF IT BREAKS
    Slide dead → draw 3 boxes + the schema-in/JSON-out arrow.
    Judge derails → "let me park that for after, keep us on time."

  TIGHTEN IT
    Cut the contracts sentence. Floor: "I taught a local model
    to call tools — that's why it runs with no cloud."
```

Next: the build story — proof it's real, in forty-five seconds.
