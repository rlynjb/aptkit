# Chapter 4 — The build story   (8:00–8:45, 45 seconds)

## Opening hook

Forty-five seconds. This is the chapter that separates a working build from a pitch deck — the proof that what they just watched is real, that you shipped it, and that you hit a genuine wall and got over it. Judges have sat through demos that were three screenshots and a dream; this is where you show you're not that. But you have less than a minute, so you pick two things and only two: the one-line inventory of what actually shipped, and the one hard part you cracked. No feature tour. Two beats, then the close.

The temptation here is to list everything — sixteen packages, six agents, the evals, Studio, buffr. Resist it. A list is forgettable; a war story is not. Spend most of your forty-five seconds on the hard part, because the hard part is what proves you built this rather than assembled it.

## The time-budget bar

Forty-five seconds. One line of inventory, one war story.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░░░░ │
  │ 0:00                    8:00 ─ 8:45 ──────────────  10:00 │
  │      THE BUILD STORY — you own 8:00 to 8:45 (45 sec)     │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — what shipped + the wall

This is the picture of the build: what's real on the left, and the one hard part on the right that proves it's real.

```
  THE BUILD STORY — what shipped, and the wall you got over

  ┌─ WHAT ACTUALLY SHIPPED (real, runnable) ─────────────────┐
  │  • @rlynjb/aptkit-core@0.4.1 — one npm bundle, 16        │
  │    internal packages inside it                           │
  │  • six agents (rag-query, query, recommendation, …)      │
  │  • Studio — the page you just watched                    │
  │  • evals: precision@k / recall@k + a rubric judge        │
  │  • buffr: the SAME agents on live Supabase pgvector      │
  └──────────────────────────────────────────────────────────┘
                              │
                              │ the part that proves I built it:
                              ▼
  ┌─ THE WALL I GOT OVER ────────────────────────────────────┐
  │                                                          │
  │  Retrieval was silently returning ZERO results.          │
  │                                                          │
  │  Gemma hallucinated a filter — {textContains:"…"} —      │
  │  and the store's exact-match dropped every chunk that    │
  │  didn't have that key. No error. Just empty.             │
  │                                                          │
  │  Found it by reading the saved trace BACKWARD until the  │
  │  filter appeared. Fixed matchesFilter to ignore keys a   │
  │  chunk doesn't have. Wrote a regression test so it       │
  │  can't come back.                                        │
  └──────────────────────────────────────────────────────────┘
```

The left box is one breath. The right box is the story. That trace you showed in the demo — the one replaying turn by turn — is the same trace that let you find this bug. That's why you planted it earlier.

## The body — two beats

### Beat 1 — what shipped (8:00–8:15): one breath

Don't enumerate. Name the shape and the proof-of-real in one sentence.

```
  ┃ "This is real and it's shipped — one npm package with the
  ┃  whole toolkit inside, six agents, the Studio you just saw,
  ┃  and the same agents running on live Supabase Postgres in a
  ┃  second repo. The in-memory store and the production one are
  ┃  a one-line swap."
```

That last clause does double duty: it proves the architecture claim from under-the-hood and it shows you ran it for real, not just in a demo tab.

### Beat 2 — the hard part (8:15–8:45): the war story

This is where your forty-five seconds go. Tell it like a story, because it is one.

```
  SHOW (on the diagram / just to the room)   SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  point at "THE WALL"                   "The hardest bug: retrieval started
                                        returning nothing. No error — just
                                        empty results. Turned out Gemma was
                                        hallucinating a filter, asking the
                                        store for chunks 'where text contains
                                        X,' and the exact-match was throwing
                                        out every chunk that didn't have that
                                        field. Silent zero."

  point at the trace idea               "I found it by reading the saved
                                        trace backward until that made-up
                                        filter showed up. Then I fixed the
                                        match to ignore keys a chunk doesn't
                                        have, and wrote a regression test so
                                        it stays fixed."
```

The line that lands the chapter — own the rough edge in the same breath as the win:

```
  ┃ "A tool-less local model that hallucinates inputs — that's
  ┃  the real cost of going local, and reading the trace
  ┃  backward is how I caught it. This is a portfolio build, so
  ┃  the in-browser demo uses a deterministic stub embedder by
  ┃  design — but the bug, the fix, and the test are all real."
```

That candor is a feature, not a confession. You named the genuine downside of your own choice (local models hallucinate inputs), showed the discipline that caught it (read the trace backward, write the test), and pre-empted the "is the demo faked?" question by owning the stub embedder before anyone asks.

## The IF-IT-BREAKS box

This chapter has no live screen — but it has a recovery for the thing that actually breaks here: the clock.

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the build story                               ║
║                                                              ║
║  You're already past 8:45 when you reach this → cut Beat 1    ║
║  entirely. Open straight on the war story: "the hardest bug   ║
║  was retrieval silently returning nothing — Gemma             ║
║  hallucinated a filter, I caught it reading the trace          ║
║  backward, fixed it, tested it." That's the chapter. The       ║
║  inventory is skippable; the war story is not.                ║
║                                                              ║
║  A judge interrupts to ask "wait, how did you debug it?" →    ║
║  good — that IS the chapter. Answer it and you've delivered    ║
║  the build story as a conversation. Let them pull it.         ║
╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Cut Beat 1 — the inventory — and lead with the war story. The floor: **the room hears one genuine hard part you diagnosed and fixed.** A hackathon judge will forgive a missing feature list; they will not forget a presenter who casually describes debugging a silent-zero retrieval bug by reading a trace backward. That story is the proof; protect it over the inventory every time.

## One-page run sheet — THE BUILD STORY

```
  THE BUILD STORY    8:00 – 8:45          (no money shot)

  SAY, IN ORDER
    1. SHIPPED (one breath): "one npm package, the whole toolkit
       inside — six agents, Studio, and the same agents on live
       Supabase Postgres in a second repo. In-memory → production
       is a one-line swap."
    2. THE WAR STORY (the chapter): "hardest bug — retrieval
       returned nothing, no error. Gemma hallucinated a filter;
       exact-match dropped every chunk without that key. Found it
       reading the trace backward. Fixed the match, wrote a
       regression test."
    3. OWN THE EDGE: "local models hallucinate inputs — that's
       the real cost of going local. The in-browser demo uses a
       deterministic stub embedder by design; the bug, fix, and
       test are real."

  IF IT BREAKS / RUNNING LATE
    Cut Beat 1. Open on the war story. Floor: one real bug
    diagnosed + fixed + tested.

  TIGHTEN IT
    Drop the inventory. Floor: the trace-read-backward war story.
```

Next: the close — vision, ask, and the last line they repeat.
