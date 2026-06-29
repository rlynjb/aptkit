# Chapter 1 — The Cold Open   (0:00–1:00, 60 seconds)

## Opening hook

The first sixty seconds decide whether the room leans in or checks
their phones. You do not get them back. So you spend zero of them on
a title slide, zero on "hi, I'm Rein, I've been a frontend engineer
for seven years," and zero on "so, RAG stands for retrieval-augmented
generation." The room came to see something work. Show them something
working, then tell them what it is.

Your advantage here is unusual: your money shot lives in Studio and
runs in the browser with no backend. That means you can open *on the
running app* with zero risk — no server to boot, no API key to load,
no wifi dependency. Most demos can't open cold on the product because
the product might not come up. Yours can. Use that.

## The time-budget bar

You own the first minute. By 1:00 the room must know what AptKit is
in one sentence and have already seen the RAG Query page on screen.

```
  ┌──────────────────────────────────────────────────────┐
  │ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ── 1:00 ──────────────────────────────────── 10:00 │
  │     COLD OPEN — you own 0:00 to 1:00 (60 sec)          │
  └──────────────────────────────────────────────────────┘
```

## The attention curve — where the hook has to land

This is the room's attention over the first minute. It starts high
(novelty), drops fast if you stall, and only recovers if you put
something concrete on screen before it bottoms out. Your job is to
catch it before the dip.

```
  ROOM ATTENTION — first 60 seconds

  high │●                                  ●  ← recovers: app on screen
       │ ●                               ●     + one-liner lands
       │  ●                            ●
       │   ●     ← danger zone       ●
       │    ●  (title slide,       ●
       │     ●  self-intro)      ●
   low │      ●●●●●●●●●●●●●●●●●
       └────────────────────────────────────────────► time
        0:00      0:20       0:40            1:00

   the dip is where you lose them; open ON the app to skip it
```

## The body — two beats, in order

Two beats only: the hook (app on screen, one motion) and the
one-liner. Nothing else fits in sixty seconds.

### Beat 1 — the hook (0:00–0:35)

Studio is already open on the **RAG Query Agent** page (`#rag-query`)
before you say a word. The question is already in the box. You click
**Run fixture** as your opening move and let the answer and the eval
scores populate while you talk.

```
  SHOW (on screen)                   SAY (out loud)
  ─────────────────────────────      ──────────────────────────────
  Studio open on RAG Query           "Watch this. I'm going to ask
  page; question pre-loaded:          my notes a question — what I do
  "What does the author do for        for work, and how I take my
  work, and how do they take          coffee — and the answer comes
  their coffee?"                       back grounded, with citations."

  click Run fixture; answer +        "…and right next to the answer,
  Precision@1 / Recall@3 panels       a score that says the retrieval
  populate, chunks light up           was actually correct. No backend.
                                       This is running in your browser."
```

Don't narrate the click. You are not saying "now I'm clicking the run
button." You're saying what it *means* while your hand does the
clicking. That separation is the whole discipline.

### Beat 2 — the one-liner (0:35–1:00)

Now name it. One sentence, the classic "X is a Y that does Z for W"
shape, said while the answer sits on screen behind you.

```
┃ "AptKit is a TypeScript toolkit that packages the reusable parts
┃  of an AI agent — the loop, the model and vector-store contracts,
┃  the RAG pipeline — so you can build a grounded, cited agent
┃  without rewriting all of it every time."
```

Then the bridge into the demo:

```
┃ "Let me show you the whole thing running, end to end."
```

That's the minute. App working, then the sentence. Never the reverse.

## Strong vs weak — the cold open

The contrast every losing demo gets wrong:

```
  WEAK open                          STRONG open
  ─────────────────────────────      ──────────────────────────────
  "Hi, I'm Rein. I'm a frontend      App already on screen. Click Run.
  engineer pivoting to AI. Today     "Watch this — my notes, answered
  I want to talk about a problem      with citations, scored correct,
  with retrieval systems…"            no backend."

  title slide → problem slide →      thing working → one-liner →
  architecture → finally the demo     then everything else
  at minute four

  room is gone by 0:40               room is leaning in by 0:30
```

## IF IT BREAKS

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ Studio is blank or the page didn't load → you have two fallbacks,  ║
║ in order:                                                          ║
║  1. Open the static GitHub Pages build (base /aptkit/, route       ║
║     #rag-query) — it's the same page, fixture-only, no dev server. ║
║  2. Still blank → switch to the money-shot screenshot (slide 1).   ║
║ Say: "here's a run from a minute ago" and keep the energy up.      ║
║ Do not apologize twice. Say it once, move.                         ║
╚══════════════════════════════════════════════════════════════════╝
```

## Tighten it

If you're already behind before you start (the slot got cut to five
minutes), **drop the one-liner's full sentence** and compress to:
"AptKit — grounded, cited answers from a local agent. Watch." The
floor you must not cut: the app has to be on screen and *running*
before you stop talking. The hook is the one beat that never gets cut.

## One-page run sheet — COLD OPEN

```
  ┌──────────────────────────────────────────────────────────────┐
  │ COLD OPEN              0:00–1:00          (no money shot yet)  │
  │                                                                │
  │ BEFORE YOU SPEAK: Studio open on #rag-query, question loaded   │
  │                                                                │
  │ SAY, in order:                                                 │
  │  • "Watch this. I'll ask my notes what I do for work and how   │
  │     I take my coffee — grounded, with citations."              │
  │     → click Run fixture                                        │
  │  • "And next to the answer, a score that says the retrieval    │
  │     was correct. No backend. Running in your browser."         │
  │  • ONE-LINER: "AptKit is a TypeScript toolkit that packages    │
  │     the reusable parts of an AI agent so you build a grounded, │
  │     cited agent without rewriting it every time."             │
  │  • "Let me show you the whole thing running, end to end."      │
  │                                                                │
  │ NAIL THIS LINE: the one-liner, verbatim                        │
  │ IF IT BREAKS: static Pages build #rag-query → else screenshot  │
  │ TIGHTEN: drop full one-liner → "AptKit — grounded, cited       │
  │          answers from a local agent. Watch." (never cut hook)  │
  └──────────────────────────────────────────────────────────────┘
```
