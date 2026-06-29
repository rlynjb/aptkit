# Hackathon Demo — AptKit + Studio (run-of-show)

You have ten minutes and a room that decides in the first ninety seconds
whether this is real. This book is the script. Read it front-to-back once
with a timer, then hold the run sheets while you present. The whole thing is
built around one hard rule: **finish early, with breathing room.** Going long
is how a hackathon demo loses — the buzzer cuts you off before the close, or
the judges stop listening at minute eleven.

The demo is the centerpiece. Everything else has a ceiling; the demo has a
floor. The single moment the room goes "oh" — the **money shot** — is the
eval score (precision@1 = 1.00) landing right next to a correct, cited answer,
with NO backend, **and it lands at ~2:30, inside the first third.**

## The whole slot on one timeline

Here is the entire ten minutes as one picture — every chapter, its budget,
and where the money shot fires.

```
  THE TEN-MINUTE RUN-OF-SHOW — AptKit + Studio

  0:00 ┌──────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER                  0:00–1:00  │ 1:00
  1:00 ├──────────────────────────────────────────────────────┤
       │ 02  THE DEMO (centerpiece)                 1:00–6:00  │ 5:00
       │      ★ MONEY SHOT — scored cited answer  ~2:30        │
       │      beat 2: replay a real agent trace               │
       │      beat 3: the local `ask` CLI (Gemma)             │
  6:00 ├──────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD — two contracts diagram 6:00–8:00  │ 2:00
  8:00 ├──────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY — 16 pkgs, the hard part 8:00–8:45│ 0:45
  8:45 ├──────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                    8:45–9:30  │ 0:45
  9:30 ├──────────────────────────────────────────────────────┤
       │     buffer / breathing room                9:30–10:00 │ 0:30
 10:00 └──────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only; runs after the clock
```

If your real slot is shorter, scale every budget down proportionally — but
keep the demo's share largest and keep the money shot inside the first third.
Cut from under-the-hood, build story, and close first; never cut the demo
below the point where the room sees the score land.

## The master demo diagram — what the app does

This is the one-screen picture of what you are showing. You will return to it
in chapter 02; pin it in your head now.

```
  AptKit Studio — RAG Query Agent (in-browser, deterministic, no backend)

  ┌─ Browser (apps/studio) ───────────────────────────────────────────┐
  │                                                                    │
  │   you pick a question  ──►  [ Run fixture ]                        │
  │                                  │                                 │
  │            ┌─────────────────────▼─────────────────────┐          │
  │            │ REAL retrieval pipeline (no network):      │          │
  │            │   fake keyword-hash embedder (64-dim)      │          │
  │            │   + InMemoryVectorStore (cosine scan)      │          │
  │            │   + recorded Gemma responses replay loop   │          │
  │            └─────────────────────┬─────────────────────┘          │
  │                                  │                                 │
  │   ┌──────────────┐   ┌───────────▼──────────┐   ┌──────────────┐  │
  │   │ Answer        │   │ Retrieved chunks      │  │ Eval         │  │
  │   │ (grounded +   │   │ relevant ones light   │  │ Precision@1  │  │
  │   │  cited [doc]) │   │ up green; scores shown│  │  = 1.00  ★   │  │
  │   └──────────────┘   └───────────────────────┘   └──────────────┘ │
  │                                                   + live trace      │
  └────────────────────────────────────────────────────────────────────┘

  ★ the money shot = that 1.00 sitting next to a correct cited answer
```

The point this picture makes for the room: a retrieval-quality *score* — the
thing AI teams argue about in code review — is rendered live, next to the
answer, in a page that cannot break on stage because it has no backend to
fail.

## Suggested rehearsal order

```
  FIRST PASS   read all 7 files in order; run the demo once
               end-to-end with a timer. Note where you run long.

  SECOND PASS  run it again holding ONLY the one-page run sheets
               at the bottom of each chapter. Time the money shot —
               it must land by 2:30.

  NIGHT BEFORE read only the run sheets. Rehearse the cold open and
  / MORNING OF the money-shot line out loud until they're muscle memory.
               Open the STATIC_DEMO Pages build once so you know the
               backup works.
```

## What to have open before you start

- Studio dev server running: `npm run dev -w @aptkit/studio`, RAG Query Agent
  page (route `#rag-query`). Money shot lives here.
- A second tab on the GitHub Pages build (base `/aptkit/`) as the live backup.
- A terminal with `npm run ask -w @aptkit/agent-rag-query` ready, IF Ollama is
  up. If it isn't, you skip that beat — it's the first thing to cut.
- Screenshots of a passing scored result saved locally (last-resort backup).

## How this book connects to the rest

This book *presents* AptKit. When a judge wants the "how does it actually work"
depth after the clock, chapter 06 (Q&A) handles the standard probes, and the
interview-defense book in `.aipe/rehearse-interview-defense/` (if generated)
carries the deep follow-ups. The study guides under `.aipe/study-*` are the
substrate behind both. For this room, on this clock: pace and the demo win.
