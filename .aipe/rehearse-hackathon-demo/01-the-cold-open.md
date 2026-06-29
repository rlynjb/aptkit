# Chapter 01 — The Cold Open + One-Liner   (0:00–1:00, 1 min)

## Opening hook

You get sixty seconds before the room decides whether to keep watching. The
single most common way to waste them is a title slide and "hi, I'm Rein, today
I'm going to show you a project called AptKit that does..." — by the time you
reach the verb, three judges are reading their phones. Don't introduce
yourself. Don't explain what RAG is. Open on the thing already half-working and
say the one sentence that frames everything that follows.

You have a real advantage most demos don't: your money shot is two clicks away
and it can't crash. So the cold open's only job is to make the room *want* to
see the score land. Point at the screen, name the tension AI teams actually
feel — "is the answer grounded, and can I prove it?" — and promise to show it
proven, live, in the next ninety seconds.

## The time-budget bar

```
  ┌──────────────────────────────────────────────────────────┐
  │ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ─── 1:00 ─────────────────────────────────────── 10:00 │
  │     THE COLD OPEN — you own 0:00 to 1:00 (1 min)            │
  └──────────────────────────────────────────────────────────┘
```

In this minute you must: land the hook, say the one-liner, and have the RAG
Query Agent page already on screen so the demo starts in motion.

## The chapter-opening diagram — the room's attention curve

This is what you are managing in the first minute: a room's attention spikes
when something moves on screen and decays through any sentence that sounds like
setup. The cold open spends the spike, it doesn't waste it.

```
  ATTENTION over the first 90 seconds

  high │      ★ (you open ON the page, mid-motion)
       │     ╱ ╲                                  ╱── money shot (ch02)
       │    ╱   ╲___                          ___╱
  att. │   ╱        ╲___ one-liner lands ___╱
       │  ╱             ╲________________╱
  low  │ ╱   ← title slide + self-intro would live here, decaying
       └──────────────────────────────────────────────────────►
        0:00      0:20        0:40         1:00          time

  rule: never spend the opening spike on setup the room doesn't need yet
```

The takeaway from the curve: your first words ride the spike from the page
already being on screen. The one-liner lands while attention is still high,
and you hand straight to the demo before it can decay.

## The body — the two beats

### Beat 1 — the hook (0:00–0:25)

Open with Studio already on the RAG Query Agent page (route `#rag-query`),
question selected, nothing run yet. Your first sentence is about the *problem
the room recognizes*, not about you.

```
  SHOW (on screen)                 SAY (out loud)
  ───────────────────────────      ──────────────────────────────────
  Studio, RAG Query Agent page,    "Every team shipping an AI feature
  question loaded, the Eval        argues about the same thing: is the
  metric reading 'Pending'         answer actually grounded in the data,
                                   or is the model making it up — and can
                                   you prove it in a number?"
  hover the 'Precision@1'          "I built the proof. Watch this score."
  metric (still Pending)
```

### Beat 2 — the one-liner (0:25–0:55)

Now name what AptKit is in one sentence, in the "X is a Y that does Z for W"
shape. Keep it concrete — a toolkit, not a platform.

```
  ┃ "AptKit is a TypeScript toolkit that packages the reusable
  ┃  parts of an AI agent — the agent loop, the providers, the
  ┃  RAG pipeline — so you can build a grounded, evaluated agent
  ┃  without rebuilding the plumbing every time."
```

Then point the room straight at what they're about to see, so the demo opens
with momentum already built:

```
  ┃ "And the whole retrieval pipeline runs right here in the
  ┃  browser — no backend — so in about a minute you'll watch a
  ┃  real eval score land next to a cited answer."
```

That's the handoff. You stop talking about it and click `Run fixture`.

### The strong-vs-weak open

The contrast that decides this minute:

```
  WEAK open                          STRONG open
  ─────────────────────────────      ─────────────────────────────────
  "Hi, I'm Rein. So, AI is a big     Studio already on screen; first
  space right now, and one of the    words name the tension the room
  hard problems is retrieval. Let    feels: "is it grounded, can you
  me first explain what RAG is..."   prove it?" — then the one-liner.
  → 40 seconds gone, nothing moved   → page is live, room is leaning in
```

The weak open buries the project behind a definition the room already knows.
The strong open spends the attention spike on the screen and the stakes.

## The IF-IT-BREAKS box

```
╔══════════════════════════════════════════════════════════════════╗
║ IF IT BREAKS                                                       ║
║ The Studio page won't load when you go to open cold → don't        ║
║ open cold on a blank screen. Open cold on the SAY line instead:    ║
║ say the grounded/prove-it hook and the one-liner from memory       ║
║ while you switch to the GitHub Pages tab (base /aptkit/). The      ║
║ words carry the first 30 seconds with no screen at all. Never      ║
║ apologize twice; keep moving toward the score.                     ║
╚══════════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

If you're already behind before you start (the slot ran short, the prior
presenter ate your setup time), drop the second one-liner sentence — the
"runs in the browser, no backend" promise — and let the demo prove it instead
of pre-announcing it. **Floor: you must still say the core one-liner.** The
room needs to know what AptKit *is* before they watch it work, or the money
shot lands without a frame.

## The one-page run sheet

```
  ┌─ COLD OPEN — 0:00 to 1:00 ───────────────────────────────────────┐
  │ MONEY SHOT timing: not here — it lands in ch02 at ~2:30           │
  │                                                                   │
  │ SAY, in order:                                                    │
  │   1. hook: "every team argues about the same thing — is the       │
  │      answer grounded, and can you prove it in a number?"          │
  │   2. "I built the proof. Watch this score."                       │
  │   3. one-liner: "AptKit is a TypeScript toolkit that packages     │
  │      the reusable parts of an AI agent..."                        │
  │   4. handoff: "...the whole pipeline runs in the browser, no      │
  │      backend — in a minute you'll see a real score land."         │
  │                                                                   │
  │ NAIL THIS LINE:                                                   │
  │   "I built the proof. Watch this score."                          │
  │                                                                   │
  │ IF IT BREAKS: open on the SAY line, not the screen; switch to     │
  │   the Pages tab while you talk.                                   │
  │ TIGHTEN: drop the "no backend" promise; let the demo prove it.    │
  │   Floor: still say the core one-liner.                            │
  └───────────────────────────────────────────────────────────────────┘
```
