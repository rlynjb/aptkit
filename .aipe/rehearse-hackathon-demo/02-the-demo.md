# Chapter 2 — The demo   (1:00–6:00, 5 minutes)

## Opening hook

This is the chapter that wins or loses the slot. You own five minutes — half the clock — and inside it there's exactly one moment the whole presentation is built around: the **money shot**, the score appearing next to a correct, grounded answer with no backend behind it. That moment lands by 3:00, inside the first third, and everything before it is setup for it and everything after is you cashing the credibility it bought.

The thing working in your favor: your demo surface can't crash. Studio's RAG Query workspace runs the entire agent loop in the browser — a keyword-hash embedder, an in-memory vector store, recorded model responses, and the real eval scorers. There's no server to die, no API key to expire, no wifi to drop. The most common hackathon demo death — "it worked this morning, I swear" — is structurally off the table for you. So your job in this chapter isn't to survive the demo; it's to *choreograph* it so the room feels the money shot instead of watching you click around.

## The time-budget bar

You own the fat middle of the slot. The money shot lands inside the first third, by ~3:00 — never later.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00      1:00 ──────────── 6:00 ─────────────────  10:00 │
  │           THE DEMO — you own 1:00 to 6:00 (5 min)        │
  │                ★ money shot by ~3:00 ★                    │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the click-path

The demo is a fixed click-path, not an exploration. Here is the exact sequence of screens, with the money shot marked. Walk it the same way every rehearsal so your hands know it cold and your mouth is free to talk value.

```
  THE CLICK-PATH — Studio RAG Query workspace, 1:00 → 5:30

  [1:00] ┌─ pick the question ──────────────────────────────┐
         │ select ▼  "Two-part question answered from two   │
         │            different notes (grounded + cited)"    │
         │ Q: "What does the author do for work, and how    │
         │     do they take their coffee?"                  │
         └───────────────────────┬──────────────────────────┘
                                 │ click [ Run fixture ]
  [2:30] ┌─ retrieval lights up ─▼──────────────────────────┐
         │ Retrieved chunks:                                │
         │   ▓ work.md   0.7xx   (highlighted = relevant)   │
         │   ▓ coffee.md 0.6xx   (highlighted = relevant)   │
         │   ░ stack.md  0.3xx   (not relevant, not lit)    │
         └───────────────────────┬──────────────────────────┘
                                 │ eyes up to the metrics row
  [3:00] ┌─ ★ THE MONEY SHOT ★ ──▼──────────────────────────┐
         │  Eval: Passing   Precision@1: 1.00   Recall@3:   │
         │  1.00   ← the score lands next to…               │
         │  Answer: "…software engineer… [work.md] … flat   │
         │  white, oat milk … [coffee.md]"  ← grounded+cited│
         └───────────────────────┬──────────────────────────┘
                                 │ point at the trace panel
  [4:00] ┌─ the trace proves it ─▼──────────────────────────┐
         │ step → tool_call(search_knowledge_base)          │
         │      → tool_result(chunks) → step → answer        │
         └───────────────────────┬──────────────────────────┘
                                 │ second beat: switch workspace
  [4:30] ┌─ AgentReplayShell ────▼──────────────────────────┐
         │ a different agent's recorded trace replays turn   │
         │ by turn — same engine, same trace shape           │
         └──────────────────────────────────────────────────┘
```

Everything in this chapter is walking that path. The two things that carry the room are the chunks lighting up (retrieval visibly working) and the score landing on the metrics row (retrieval visibly *correct*). Those are 2:30 and 3:00.

## The body — the beats in order

### Beat 1 — frame the question (1:00–1:40)

You've just said the one-liner. Now you set up what they're about to watch. The dropdown is already on the two-part question (it's the default). You don't explain the UI; you frame the hard thing the question asks for.

```
  SHOW (on screen)                      SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  the question dropdown,                "I'm asking it a two-part question:
  showing the two-part fixture          what does this person do for work,
  Q: "…work, and how do they            AND how do they take their coffee.
  take their coffee?"                   Those answers live in two different
                                        notes. So a good answer has to find
  the corpus is three notes:            both — and a model that just makes
  work.md, stack.md, coffee.md          something up will get caught."
```

The value you're speaking: this isn't a softball. A two-part question over a multi-note corpus is exactly where a language model wants to hallucinate or answer half of it. You're setting the bar so the money shot clears it visibly.

```
  ┃ "Two parts, two different notes. If it grounds both and
  ┃  cites both, that's a real retrieval — not a lucky guess."
```

### Beat 2 — run it, watch retrieval light up (1:40–2:50)

You click Run fixture. It completes in under a second. Don't fill the silence with "okay so now it's running" — let it land, then point at the chunks.

```
  SHOW (on screen)                      SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  click [ Run fixture ]                 "Watch the retrieval."

  Retrieved chunks panel fills:         "It pulled three chunks and the two
   ▓ work.md   (highlighted)            it needed — the work note and the
   ▓ coffee.md (highlighted)            coffee note — are the ones lit up.
   ░ stack.md  (not highlighted)        The stack note is there but it knew
                                        it wasn't relevant. That's retrieval
                                        deciding what actually matters."
```

The highlight is real: the workspace marks each chunk `relevant` when its docId is in the fixture's relevant set, and relevant chunks get a different style. You're not narrating a click — you're pointing at retrieval making a correct call you can *see*.

### Beat 3 — ★ THE MONEY SHOT ★ (by ~3:00): the score lands

This is the moment. Your eyes go up to the metrics row and you say the line that makes the room go "oh." The answer is grounded and cited in the Answer panel, and right above it the eval reads Precision@1: 1.00, Recall@3: 1.00, Eval: Passing.

```
  SHOW (on screen)                      SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  Answer panel:                         "And here's the part I care about
   "…software engineer… [work.md]       most. The answer is grounded — it
    … flat white, oat milk no           cites the work note and the coffee
    sugar … [coffee.md]"                note, the actual sources.

  Metrics row:                          "But I'm not asking you to trust
   Eval: Passing                        that by reading it. The system
   Precision@1: 1.00     ← ★            scored it: precision one, recall
   Recall@3:    1.00     ← ★            one. The top chunk was relevant and
                                        it found every note it needed.
                                        That's the answer telling you it's
                                        trustworthy — and there's no cloud,
                                        no server. This ran in the browser."
```

That's the money shot — **the score appearing next to a correct, grounded answer, with no backend.** Say it at ~3:00, not later. The line to nail, the one you want them repeating to each other:

```
  ┃ "The answer cites its sources — and the system scored the
  ┃  retrieval itself: precision one, recall one. It's not just
  ┃  answering. It's proving the answer was grounded."

  ┃ "And there's no cloud behind this. The whole agent ran in
  ┃  the browser tab in front of you."
```

Why this is the money shot and not the answer alone: a grounded answer is table stakes in 2026 — every RAG demo shows one. The thing that re-spikes the room's attention is the *score next to it* — the demo grading its own retrieval, live, with no backend. That's the non-obvious move, and it's the one that makes a judge write something down.

### Beat 4 — the trace proves it's a real loop (3:00–4:00)

Now you cash the credibility. The room just saw a score; a skeptic is wondering whether you hardcoded it. The trace panel answers them before they ask.

```
  SHOW (on screen)                      SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  the Trace panel, events in order:     "And this isn't a canned result.
   step                                 Here's the actual trace: the agent
   tool_call_start (search_knowledge…)  decided to call search, the search
   tool_call_end (chunks)               came back with chunks, and then it
   step (grounded answer)               answered. The model chose to search
                                        — I didn't stuff the notes into the
                                        prompt. It's a real agent loop, and
                                        every turn is right here."
```

You're landing the one idea that separates an agent from a RAG script: the model *called* retrieval as a tool, the loop ran it, fed it back, and the model grounded on the result. The trace is the receipt.

### Beat 5 — the second surface: replay a real trace (4:00–5:00)

One quick second beat to show this isn't a one-trick page. Switch to the AgentReplayShell — a different agent whose recorded trace replays turn by turn. Keep this short; it's a breadth proof, not a second demo.

```
  SHOW (on screen)                      SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  switch to a replay workspace          "Same engine, different agent. Every
  (e.g. the diagnostic / query          run produces a trace, and Studio
  workspace); a recorded trace          replays it turn by turn. So when one
  replays turn by turn                  of these agents does something I
                                        don't expect, I can watch exactly
  the same trace event shapes:          what it did. That trace is how I
  step / tool_call / tool_result        debugged the hardest bug in this
                                        whole build — more on that in a sec."
```

That last line plants the build-story hook. Don't explain the bug here; you're seeding chapter 04.

### Beat 6 — hand off to under-the-hood (5:00–5:30)

Close the demo by pointing forward, so the transition is clean and you're not trailing off.

```
  ┃ "So that's the agent: it retrieves, it grounds, it cites,
  ┃  and it scores its own retrieval — no cloud. Let me show you
  ┃  the one piece under the hood that made it possible."
```

## The IF-IT-BREAKS box

Your demo is in-browser and deterministic, so the live-crash failure mode is mostly off the table — but "mostly" isn't "never." Here's the recovery, pinned to the two things that actually could go wrong: the dev server won't start, or the page is in a weird state.

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the demo chapter                              ║
║                                                              ║
║  The page is deterministic and in-browser, so the run        ║
║  itself won't fail. The two real risks:                      ║
║                                                              ║
║  1. The dev server won't start (port, install, cold laptop)  ║
║     → Open the STATIC GitHub Pages build instead — the       ║
║       fixture-only STATIC_DEMO deploy runs this exact page    ║
║       with no server. Have the URL in a tab AND on your       ║
║       phone. Say: "I'll run it from the deployed build" and   ║
║       keep going. Same money shot, same score.               ║
║                                                              ║
║  2. The page is in a stuck/blank state mid-demo               ║
║     → You have SCREENSHOTS of the scored result (the metrics  ║
║       row reading 1.00 next to the grounded answer) as        ║
║       slide backup. Say: "here's that result from a run a     ║
║       minute ago" and narrate the money-shot line over the    ║
║       screenshot. The line carries it, not the live pixels.   ║
║                                                              ║
║  Never apologize twice. One "let me switch to the build,"     ║
║  then full energy. The score is the point; deliver it from    ║
║  whichever surface is up.                                     ║
╚══════════════════════════════════════════════════════════════╝
```

#### Strong vs weak — the demo move

The failure mode that kills good demos isn't crashing — it's narrating clicks instead of speaking value. Teach yourself against it.

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK DEMO MOVE               │ STRONG DEMO MOVE             │
├──────────────────────────────┼──────────────────────────────┤
│ "So now I'm going to click   │ [clicks Run silently]        │
│ Run, and you can see it's    │ "Watch the retrieval — the   │
│ loading, and now over here   │ two notes it needed are lit, │
│ on the left we have the      │ the irrelevant one isn't.    │
│ answer panel, and these are  │ And the score: precision     │
│ the chunks, and up here is   │ one, recall one. The answer  │
│ the metrics, and the         │ is proving itself grounded,  │
│ precision is showing 1.0…"   │ with no cloud behind it."    │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ Every word narrates the      │ The hands click; the mouth   │
│ screen the room can already  │ speaks meaning. The room's   │
│ see. The money shot          │ eyes follow your words to    │
│ ("precision 1.0") arrives    │ the money shot at the moment │
│ as a flat item in a list,    │ it lands. The score is        │
│ not as a moment. No one      │ delivered as the punchline,  │
│ writes anything down.        │ not as a UI label.           │
└──────────────────────────────┴──────────────────────────────┘
```

## The "tighten it" treatment

Running long going into the demo? Cut Beat 5 — the AgentReplayShell second surface. It's a breadth proof, not the centerpiece, and dropping it saves a full minute. If you're *really* tight, also compress Beat 4 (the trace) to a single sentence: "and the trace proves the model chose to search — it's a real loop." The floor you must not cut below: **Beats 1–3 — frame the question, run it, and land the score next to the grounded answer.** That is the demo. Everything else is supporting it. If the room sees the score land on a grounded answer, you've done the job even if you cut the last ninety seconds.

## One-page run sheet — THE DEMO

```
  THE DEMO           1:00 – 6:00          ★ MONEY SHOT by ~3:00 ★

  CLICK-PATH (default fixture, dropdown already on two-part Q)
    1. Frame: "two-part question, two different notes — a guesser
       gets caught"                                          [1:40]
    2. Click Run. "Watch the retrieval" — work.md + coffee.md
       light up, stack.md doesn't                            [2:50]
    3. ★ MONEY SHOT: eyes to metrics. "It cites its sources AND
       scored its own retrieval — precision one, recall one. No
       cloud. This ran in the browser."                      [3:00]
    4. Trace: "the model CHOSE to search — real loop, here's
       every turn"                                           [4:00]
    5. Switch to AgentReplayShell — "same engine, replays any
       trace. This is how I debugged the hard bug."          [5:00]
    6. Hand off: "let me show you the one piece that made it
       possible"                                             [5:30]

  THE LINE TO NAIL
    "It cites its sources AND scored the retrieval itself —
     precision one, recall one. No cloud. It ran in this tab."

  IF IT BREAKS
    Server dead → static GitHub Pages build (tab + phone).
    Page stuck → screenshot of the scored result; say the line
    over it. Never apologize twice.

  TIGHTEN IT
    Cut Beat 5, then compress Beat 4 to one sentence.
    Floor: frame → run → score lands on a grounded answer.
```

Next: under the hood — one diagram, three sentences deep, then stop.
