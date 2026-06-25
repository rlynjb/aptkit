# Hackathon Demo — aptkit (the run-of-show)

This is the book you read once front-to-back to rehearse, then run from the one-page sheets at the back of each chapter. It is built around one fact: you have **ten minutes and a buzzer**, and the room decides in the first ninety seconds whether to keep watching. Every chapter owns a slice of that clock, opens with a bar showing where it sits, and tells you exactly what to drop when you're running long.

I've watched a hundred of these. The demo that loses buries the wow in minute eight, or spends three minutes on a title slide and a problem statement nobody asked for, or crashes live and the presenter freezes and apologizes twice. The demo that wins opens cold on the thing already working and never lets the room look away. That second one is the demo we're building for aptkit — and you have an unfair advantage: your best surface, Studio's RAG page, **runs entirely in the browser with no backend**, so the thing that's supposed to wow them physically cannot crash on stage.

## The whole slot on one timeline

This is the shape of the ten minutes. Read it left to right; the demo owns the fat middle and the money shot lands early, inside the first third.

```
  APTKIT — THE TEN-MINUTE RUN-OF-SHOW

  0:00 ┌──────────────────────────────────────────────────────┐
       │ 01  COLD OPEN + ONE-LINER              0:00 – 1:00    │  1:00
  1:00 ├──────────────────────────────────────────────────────┤
       │ 02  THE DEMO  (centerpiece)            1:00 – 6:00    │  5:00
       │      ★ MONEY SHOT lands by ~3:00 ★                    │
       │        score appears next to a grounded, cited        │
       │        answer — no backend, no cloud                  │
  6:00 ├──────────────────────────────────────────────────────┤
       │ 03  UNDER THE HOOD                     6:00 – 8:00    │  2:00
       │      one diagram: two contracts + emulated tools     │
  8:00 ├──────────────────────────────────────────────────────┤
       │ 04  THE BUILD STORY                    8:00 – 8:45    │  0:45
  8:45 ├──────────────────────────────────────────────────────┤
       │ 05  THE CLOSE + THE ASK                8:45 – 9:30    │  0:45
  9:30 ├──────────────────────────────────────────────────────┤
       │      buffer / breathing room           9:30 – 10:00   │  0:30
 10:00 └──────────────────────────────────────────────────────┘

       06  THE Q&A  ← prep only; runs after the buzzer, never
                      counts against the ten minutes
```

The discipline this timeline enforces: **the demo has a floor, everything else has a ceiling.** If you're bleeding time, you cut under-the-hood, then the build story, then the close — in that order. You never cut the demo below the point where the room sees the score land next to a grounded answer. That moment is the whole presentation; protect it.

## The master demo diagram — what the app does in one screen

This is the picture of what they're about to watch, and it recurs in chapter 02. Hold it in your head: a question goes in, retrieval pulls chunks, a local model grounds an answer, and an eval scores whether the retrieval was actually right — all rendered live on one page.

```
  WHAT THE ROOM SEES — Studio's RAG Query workspace

  ┌─ UI: apps/studio (React 18 + Vite) ───────────────────────────┐
  │  [ pick a question ▼ ]                      [ Run fixture ]    │
  │                                                               │
  │  Eval: Passing   Precision@1: 1.00   Recall@3: 1.00   ← ★     │
  │  ────────────────────────────────────────────────────────    │
  │  Answer:  "The author works as a software engineer…           │
  │            [work.md] … flat white, oat milk … [coffee.md]"    │
  │  Retrieved chunks:  ▓ work.md (relevant)  ▓ coffee.md (rel.)  │
  │                     ░ stack.md                                │
  │  Trace:  step → tool_call(search) → tool_result → step        │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ all of this runs IN THE BROWSER
  ┌─ In-browser engine (no server) ▼──────────────────────────────┐
  │  keyword-hash embedder  →  InMemoryVectorStore (cosine)        │
  │  →  search_knowledge_base tool  →  recorded Gemma responses    │
  │  →  scorePrecisionAtK / scoreRecallAtK                         │
  └────────────────────────────────────────────────────────────────┘
        the same RagQueryAgent runs on a REAL local Gemma+Ollama
        via the CLI, and on live Supabase pgvector in buffr —
        the in-browser version just swaps in deterministic parts
        so it can't break on stage
```

The one thing to internalize from this diagram: the page is showing a real agent loop — real `RagQueryAgent`, real `InMemoryVectorStore`, real eval scorers — wired to deterministic stand-ins (a keyword-hash embedder and recorded model responses) so the demo is repeatable. You're not faking the agent; you're making it deterministic. That distinction is what you own honestly in the build story.

## The rehearsal order

Three passes. Do them in order; don't skip to running the sheets cold.

```
  FIRST PASS ───────► Read all seven chapters front-to-back. Then
                      run the demo once, end-to-end, with a timer
                      visible. Note where you ran long.

  SECOND PASS ──────► Run it again holding ONLY the one-page run
                      sheets at the back of each chapter. The book
                      taught you the beats; now prove you can run
                      them from the card.

  NIGHT BEFORE / ───► Read only the run sheets. Time the money shot
  MORNING OF          specifically — say the line, click Run, watch
                      the clock. It must land by 3:00. If it slips
                      past 3:30, your cold open is too long; cut it.
```

One rehearsal rule that matters more than the others: **rehearse the IF-IT-BREAKS path too.** Once, on purpose, pretend the dev server won't start and practice opening the static GitHub Pages build instead. The recovery only works if your hands already know it.

## Where this connects to the rest of the system

This book *presents* the project. It is not the only book about it.

```
  THIS BOOK (rehearse-hackathon-demo) ──► SHOW the work in 10 min
                                          a room watches a clock

  rehearse-interview-defense/ ──────────► DEFEND the work after
                                          "how does it actually
                                          work?" — the 8-chapter
                                          deep walk, same code

  study-system-design/ , study-ai-       ► UNDERSTAND the work —
  engineering/ (concept files)             the deepest follow-ups,
                                           one file per pattern
```

When a judge in Q&A pushes past demo depth — "how does the emulated tool-calling actually parse?", "how does pgvector scale?" — that's where the interview-defense book takes over. This book gets you through the ten minutes; that one gets you through the conversation after. Keep the defense book's chapter 02 (the architecture walk) and chapter 05 (the failure story) within reach for the Q&A.

## The seven files

| File | Beat | Clock | What it is |
|------|------|-------|------------|
| `00-overview.md` | — | whole slot | This run-of-show + the master demo diagram |
| `01-the-cold-open.md` | Cold open | 0:00–1:00 | Open on the thing working + the one-liner |
| `02-the-demo.md` | The demo | 1:00–6:00 | The click-path + the money shot by ~3:00 |
| `03-under-the-hood.md` | Under the hood | 6:00–8:00 | One diagram: two contracts + emulated tools |
| `04-the-build-story.md` | Build story | 8:00–8:45 | What shipped + the hard part cracked |
| `05-the-close.md` | The close | 8:45–9:30 | Vision (framed as future) + the ask + last line |
| `06-the-qa.md` | Q&A | post-buzzer | The questions judges always ask + answers |

Read on. Chapter 01 is the sixty seconds that decide whether the rest of this matters.
