# Chapter 5 — The close   (8:45–9:30, 45 seconds)

## Opening hook

Forty-five seconds to end on a beat instead of trailing off into "yeah, so, that's it, any questions?" — which is how most demos die in their last ten seconds, throwing away everything the previous nine minutes built. The close has three moves and they're fast: where it goes next (framed clearly as future, never demoed as if it exists), what you want from the room, and the one sentence you want them repeating to each other on the way out. Land that last line clean and stop talking. The silence after a good last line is yours; don't fill it.

You finish at 9:30, with thirty seconds of buffer before the buzzer. That buffer is on purpose — it means you never get cut off mid-sentence, and it leaves the room a beat to react before Q&A. Finishing early reads as control; finishing late reads as panic.

## The time-budget bar

Forty-five seconds. Vision, ask, last line — then stop, with buffer to spare.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓░░░░░░░░░░░░ │
  │ 0:00                       8:45 ─ 9:30 ───────────  10:00 │
  │        THE CLOSE — you own 8:45 to 9:30 (45 sec)         │
  │              then 0:30 buffer before the buzzer          │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the three moves out

The close is three beats, each shorter than the last, ending on the line. Here's the shape.

```
  THE CLOSE — three moves, then silence

  [8:45] ┌─ VISION (future, clearly framed) ────────────────┐
         │  "where this goes next" — NOT demoed, NOT claimed │
         │  • more agents wiring in persistent memory        │
         │  • the provider fallback chain running in buffr   │
         │  • a hosted deploy so it's not just local         │
         └───────────────────────┬──────────────────────────┘
                                 │ ~15 sec
  [9:05] ┌─ THE ASK ─────────────▼──────────────────────────┐
         │  what you want from THIS room:                    │
         │  feedback · a conversation · a look at the repo   │
         └───────────────────────┬──────────────────────────┘
                                 │ ~10 sec
  [9:20] ┌─ THE LAST LINE ───────▼──────────────────────────┐
         │  the one sentence they repeat to each other       │
         │  → then STOP. Don't fill the silence.             │
         └──────────────────────────────────────────────────┘
                                 │
  [9:30] ─────────────── 0:30 buffer ─────────────── [10:00]
```

Each box is shorter than the one above it. You're decelerating into a clean stop, not racing the buzzer.

## The body — three moves

### Move 1 — the vision (8:45–9:05): framed as future, never faked

The discipline here is the no-vaporware rule: everything in this move is clearly "next," not "now." You don't show it, you don't imply it exists. You name the direction.

```
  SHOW (nothing new on screen)          SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  the Studio result still up            "Where this goes next — and to be
  from the demo                         clear, this part isn't built yet:
                                        I want to wire persistent memory
                                        into more of the agents, run the
                                        provider fallback chain live in the
                                        production repo so it can fail over
                                        between models, and put up a hosted
                                        deploy so it's not only local."
```

The phrase "isn't built yet" is doing real work. It tells the judges you know the difference between what you shipped and what you're dreaming, which is exactly the judgment they're scoring you on. Vaporware framed as shipped is the fastest way to lose a sharp judge's trust.

### Move 2 — the ask (9:05–9:20): name what you want

Be specific about what you want from *this* room. Vague asks ("thanks for watching") get nothing.

```
  ┃ "What I'm after today is the conversation — if you've built
  ┃  agents and hit the same walls, I want to hear how you
  ┃  solved them. And the repo's open; I'd love a sharp pair of
  ┃  eyes on the contracts."
```

### Move 3 — the last line (9:20–9:30): the one they repeat

This is the sentence you want a judge saying to another judge afterward. It compresses the whole talk to one idea: a real agent, local, that proves its own answers.

```
  ┃ "Most RAG demos show you an answer and ask you to trust it.
  ┃  This one runs on a laptop with no cloud — and shows you the
  ┃  score that proves the answer was grounded."
```

Then stop. Don't add "so, yeah" or "any questions?" Let the line sit. The organizer will open Q&A; your job ended on the period.

#### Strong vs weak — the ending

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK CLOSE                   │ STRONG CLOSE                 │
├──────────────────────────────┼──────────────────────────────┤
│ "And there's a lot more I    │ "Where it goes next isn't    │
│ want to do — memory, maybe    │ built yet: memory, a live    │
│ a hosted version, lots of    │ fallback chain, a hosted     │
│ ideas. Um, yeah. I think     │ deploy. What I want today is │
│ that's basically it. Any     │ the conversation and eyes on │
│ questions?"                  │ the repo. [last line] —      │
│                              │ then stops, holds the silence.│
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ Trails off. "Maybe," "lots   │ Future is clearly future.    │
│ of ideas," "basically it"    │ The ask is specific. The     │
│ all leak uncertainty. The    │ last line compresses the     │
│ talk deflates in its final   │ whole talk and the silence   │
│ seconds. Nothing to repeat.  │ after it is earned, not       │
│                              │ awkward.                     │
└──────────────────────────────┴──────────────────────────────┘
```

## The IF-IT-BREAKS box

No live screen here, but the close has its own failure mode: the buzzer goes early or you've lost the thread. Recovery:

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the close                                     ║
║                                                              ║
║  The buzzer is about to go and you're not at the last line →  ║
║  skip vision and ask entirely, jump straight to the last      ║
║  line: "This runs on a laptop with no cloud — and shows you   ║
║  the score that proves the answer was grounded." Land it,      ║
║  stop. The last line alone is a complete close.               ║
║                                                              ║
║  You blank on the vision items → don't improvise vaporware.   ║
║  Say "there's a clear next step around persistent memory"     ║
║  and move to the ask. One honest item beats three vague ones. ║
╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

Cut Move 1 (the vision) and Move 2 (the ask), and go straight to the last line. The floor: **the room hears the last line, clean, and you stop on it.** The vision and the ask are nice; the last line is the thing they carry out of the room. If you have ten seconds left, spend all ten on the last line and the silence after it.

## One-page run sheet — THE CLOSE

```
  THE CLOSE          8:45 – 9:30          then 0:30 buffer

  SAY, IN ORDER (decelerating)
    1. VISION (future, ~15s): "not built yet — persistent memory
       in more agents, a live fallback chain in the prod repo, a
       hosted deploy."  ← say "not built yet"
    2. ASK (~10s): "I want the conversation — if you've hit the
       same agent walls, tell me. Repo's open, want eyes on it."
    3. THE LAST LINE (~10s, nail it):
       "Most RAG demos show an answer and ask you to trust it.
        This one runs on a laptop with no cloud — and shows you
        the score that proves the answer was grounded."
       → STOP. Hold the silence. Don't say "any questions?"

  IF IT BREAKS / BUZZER EARLY
    Skip vision + ask, jump to the last line, stop.

  TIGHTEN IT
    Cut vision + ask. Floor: the last line, clean, then silence.
```

Next: the Q&A — prep only, runs after the buzzer.
