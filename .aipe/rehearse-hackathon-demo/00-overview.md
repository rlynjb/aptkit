# Hackathon Demo — Run-of-Show (AptKit + Studio)

You have ten minutes and a room that decides in the first ninety
seconds whether this is real. This book is the script. Read it
front-to-back once, run the demo end-to-end with a timer, then
present holding only the one-page run sheets at the bottom of each
chapter.

The thing you are showing: **AptKit** — a TypeScript toolkit that
packages reusable AI-agent parts (a bounded agent loop, swappable
model and vector-store contracts, a from-scratch RAG pipeline,
evals) — plus **Studio**, the in-browser preview UI. The single
moment the room reacts is in Studio: a retrieval-augmented-generation
query (RAG) running entirely in the browser, with the **eval score
landing right next to a correct, cited answer**. No backend. It
can't break live.

## The whole slot on one timeline

Here is the entire ten minutes as one picture — every chapter, its
budget, and where the money shot fires.

```
  THE TEN-MINUTE RUN-OF-SHOW

  0:00 ┌───────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER              0:00–1:00   │  1:00
  1:00 ├───────────────────────────────────────────────────┤
       │ 02  THE DEMO  (centerpiece)            1:00–6:00   │  5:00
       │       ★ MONEY SHOT — eval Passing + cited           │
       │         answer side by side  ──────────  ~3:00      │
  6:00 ├───────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD (two ports + tools) 6:00–8:00   │  2:00
  8:00 ├───────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY                    8:00–8:45   │  0:45
  8:45 ├───────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                8:45–9:30   │  0:45
  9:30 ├───────────────────────────────────────────────────┤
       │     buffer / breathing room            9:30–10:00  │  0:30
 10:00 └───────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only; runs after the clock,
                       never eats the ten minutes
```

Two rules govern that budget. The demo has a **floor** — never cut
it below the point where the room sees the eval score land next to
the answer. Everything else has a **ceiling** — when you run long,
you cut from under-the-hood, then the build story, then the close,
in that order. You plan to finish at 9:30 with thirty seconds of air,
not to ride the buzzer.

## The master demo diagram — what the app does in one screen

Before the chapters, hold this picture. It is what Studio shows on
the RAG Query Agent page, and it recurs in chapter 02. A question
goes in; the retrieval pipeline lights up the chunks it pulled; the
model returns a grounded answer with citations; and the eval scores
the retrieval live.

```
  STUDIO — RAG Query Agent page (one screen)

  ┌─ question ────────────────────────────────────────────────┐
  │ "What does the author do for work, and how do they         │
  │  take their coffee?"                                        │
  └───────────────────────────┬────────────────────────────────┘
                              │  agent decides to search
                              ▼
  ┌─ retrieved chunks ───────────────┐   ┌─ eval (live) ───────┐
  │ work.md    0.812   ◄ relevant ✓  │   │ Eval     Passing ✓  │
  │ coffee.md  0.774   ◄ relevant ✓  │   │ Precision@1   1.00  │
  │ stack.md   0.231                 │   │ Recall@3      1.00  │
  └───────────────────────────┬──────┘   └─────────────────────┘
                              │  grounded + cited                 ★
                              ▼                              MONEY SHOT
  ┌─ answer ───────────────────────────────────────────────────┐
  │ "…software engineer focused on AI agents and RAG [work.md]. │
  │  …flat white, oat milk, no sugar [coffee.md]."              │
  └───────────────────────────────────────────────────────────┘
                              │
                              ▼   trace panel: step → tool_call → usage
```

The reader returns to this picture whenever they need to re-anchor
on the shape of the run.

## How to rehearse this book

Three passes, in order:

```
  REHEARSAL ORDER

  Pass 1  (read + run once)
    Read 01→06 in order. Run the demo end-to-end in Studio
    with a phone timer. Find out where you actually are at 3:00.

  Pass 2  (run sheets only)
    Close the book. Run it again holding only the one-page run
    sheets. The SAY lines should come without reading the prose.

  Night-before / morning-of
    Read only the run sheets. Time exactly one thing: the money
    shot landing by 3:00. If that lands on time, the demo lands.
```

## Where this sits in the study system

This book **shows** the project. Two siblings cover the rest:

  → `.aipe/rehearse-interview-defense/` — answers the "how does it
    actually work" questions a judge or interviewer asks *after*
    the clock. When someone drills into the agent loop or the
    provider abstraction, that book is the depth.
  → `.aipe/study-system-design/`, `.aipe/study-ai-engineering/`,
    and the other `study-*` folders — the deepest follow-ups
    (the contracts, the retrieval pipeline, the eval seam).

You present from this book. You defend from those.
