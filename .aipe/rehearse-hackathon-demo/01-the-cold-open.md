# Chapter 1 — The cold open   (0:00–1:00, 1 minute)

## Opening hook

Sixty seconds. That's all the cold open gets, and it's the most expensive minute you have, because it's the one where the room is still deciding whether to look up from their phones. The single most common way to waste it is to spend it on yourself — "Hi, I'm Rein, I've been working on a project called aptkit, it's a TypeScript toolkit, let me give you some background…" By the time you reach a sentence that matters, the room has filed you under "another tooling project" and stopped listening.

Don't do that. Open on the thing already working. The first frame the room sees should be Studio sitting there with a grounded, cited, *scored* answer on screen — the destination, shown up front, before you've explained anything. Then you say one sentence that names what they're looking at. You earn the next nine minutes in this one, and you earn them by showing, not by introducing.

## The time-budget bar

You own the first minute. Inside it you must get the room looking at the screen and land one sentence they could repeat.

```
  ┌──────────────────────────────────────────────────────────┐
  │ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░ │
  │ 0:00 ─── 1:00 ──────────────────────────────────── 10:00  │
  │        COLD OPEN — you own 0:00 to 1:00 (1 min)           │
  └──────────────────────────────────────────────────────────┘
```

## The chapter-opening diagram — the attention curve

The reason the cold open is built this way is the shape of a room's attention over ten minutes. It is highest in the first fifteen seconds and it decays unless you spend something to hold it. Here's the curve, and where your beats have to land on it.

```
  ROOM ATTENTION OVER THE SLOT — spend the opening, bank the rest

  attention
    high │█
         │█▓
         │█▓▓                    ★ money shot re-spikes it
         │█▓▓░                  ╱│
         │█▓▓░░░              ╱  │
         │█▓▓░░░░░░       ╱╲╱    │
    low  │█▓▓░░░░░░░░░░╱        ░░░░░░░░░░░░░░░
         └┬───┬───────┬─────────┬──────────────► time
          0  0:15    1:00      3:00           10:00
          │   │        │         │
          │   │        │         └─ demo keeps it up here
          │   │        └─ one-liner banks attention into the demo
          │   └─ THE THING WORKING on screen, no title slide
          └─ the 15s that decide everything — open IN MOTION
```

The takeaway from that curve: you cannot earn attention back as cheaply as you can lose it at second one. So the cold open spends the screen — the working result — to bank attention that the demo and the money shot then re-spike. Open flat with a title slide and you start the whole talk climbing out of a hole.

## The body — the two beats in order

The cold open is two beats and nothing else: the hook (the thing working, on screen) and the one-liner (the sentence they repeat). No agenda slide, no "a little about me," no problem statement that runs sixty seconds on its own.

### Beat 1 — the hook (0:00–0:25): open on the result

Before you say a word, Studio is already on screen showing a completed run — the default question answered, the chunks lit up, the score reading 1.00. You did the run during setup so the room's first frame is the destination.

```
  SHOW (on screen)                      SAY (out of your mouth)
  ──────────────────────────────        ──────────────────────────────────
  Studio's RAG page, already            "This is a question — 'what does the
  showing a finished run: the           author do for work, and how do they
  answer with [work.md] and             take their coffee' — answered by a
  [coffee.md] citations, the            language model running with no cloud
  chunks highlighted, the metrics       behind it. And the number up top is
  row reading Precision@1: 1.00         my system checking whether the answer
                                        was actually grounded in the right
                                        notes — live."
```

Notice what the SAY track does and doesn't do. It does not say "here you can see the Studio interface, and on the left we have the answer panel." That narrates the screen; the room can see the screen. It speaks the *value*: a real answer, no cloud, and a number that says the answer is trustworthy. The screen does the showing; your mouth does the meaning.

### Beat 2 — the one-liner (0:25–1:00): name it in one sentence

Now, with the working thing on screen, you drop the one sentence that tells them what category to put this in. The shape is "X is a Y that does Z for W." Yours:

```
  ┃ "aptkit is a local-first agent toolkit that runs a whole
  ┃  RAG agent on your laptop with no cloud — and shows you,
  ┃  visually, whether the answer was actually grounded."
```

Then one breath of context — your second sentence, no more — that says why this is your project to be showing:

```
  ┃ "I've shipped RAG before on the cloud with GPT-4. This time
  ┃  I built the whole thing from the contracts up and ran a
  ┃  local model I had to teach to call tools."
```

That's it. That second line is doing quiet work: it tells the judges this isn't your first RAG system, and it plants "a local model I had to teach to call tools" — the hook you'll pay off in under-the-hood. Don't explain it now. Drop it and move to the demo.

#### Strong vs weak — the open

This is the failure mode worth teaching against, because nearly everyone defaults to the weak version.

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK OPEN                    │ STRONG OPEN                  │
├──────────────────────────────┼──────────────────────────────┤
│ Title slide: "aptkit — an    │ Studio on screen, a grounded │
│ agent toolkit." You: "Hi,    │ scored answer already there. │
│ I'm Rein. So, agents are     │ You: "This answer came from  │
│ really hot right now, and    │ a model on a laptop, no      │
│ I wanted to explore building │ cloud — and that number is   │
│ a toolkit for them. Let me   │ my system proving it's        │
│ walk you through the         │ grounded." Then the one-liner.│
│ architecture first…"         │                              │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ Forty seconds before         │ The room sees the payoff at  │
│ anything happens. The room   │ second one. The one-liner    │
│ has heard "agents are hot"   │ lands AFTER they care, so it │
│ a dozen times today. You're  │ sticks. You've spent the     │
│ climbing out of a hole.      │ screen to bank attention.    │
└──────────────────────────────┴──────────────────────────────┘
```

## The IF-IT-BREAKS box

The cold open shows a result on screen, so it has a failure mode: the page isn't showing a finished run when you start talking. Here's the recovery — and the reason it's nearly free is that this page is deterministic.

```
╔══════════════════════════════════════════════════════════════╗
║ IF IT BREAKS — the opening frame isn't there                 ║
║                                                              ║
║  The page is blank / shows "No fixture run yet" when you      ║
║  start →  Keep talking, hit Run fixture once as you say the   ║
║  hook. It's deterministic and in-browser; it completes in     ║
║  well under a second. Say: "let me run it live for you" and   ║
║  let the result land ON the one-liner — that's an even        ║
║  stronger open than a pre-loaded screen.                      ║
║                                                              ║
║  The whole dev server is dead → open the static GitHub Pages  ║
║  build (the STATIC_DEMO fixture-only deploy) on your phone or ║
║  a backup tab and run the same fixture there. Same page,      ║
║  same result, no local server needed.                        ║
║                                                              ║
║  Never open with an apology. No "sorry, let me get this up."  ║
║  The room reads confidence off your first ten seconds.        ║
╚══════════════════════════════════════════════════════════════╝
```

## The "tighten it" treatment

If a previous presenter ran long and the organizer is waving you to start, drop the second sentence of the one-liner — the AdvntrCue/growth-arc line. Keep the hook and the core one-liner. The floor you must not cut below: **the room sees a working, scored answer on screen, and hears one sentence naming what aptkit is.** Below that you haven't opened, you've just started talking.

## One-page run sheet — COLD OPEN

```
  COLD OPEN          0:00 – 1:00          (no money shot here)

  BEFORE YOU SPEAK
    • Studio's RAG page is up, default fixture already RUN —
      grounded answer + citations + Precision@1: 1.00 on screen

  SAY, IN ORDER
    1. "This is a question answered by a model running with no
        cloud — and that number up top is my system checking the
        answer was actually grounded. Live."
    2. THE ONE-LINER (nail it):
       "aptkit is a local-first agent toolkit that runs a whole
        RAG agent on your laptop with no cloud — and shows you,
        visually, whether the answer was actually grounded."
    3. "I've shipped cloud RAG before. This time I built it from
        the contracts up and ran a local model I taught to call
        tools."  ← plants the under-the-hood hook

  IF IT BREAKS
    Blank page → hit Run live on the hook line (it's instant).
    Server dead → open the static GitHub Pages build.
    Never apologize.

  TIGHTEN IT
    Drop sentence 3 (the growth-arc line). Floor: working scored
    answer on screen + one sentence naming aptkit.
```

Next: the demo. This is the chapter that wins or loses the slot — five minutes, and the money shot has to land by 3:00.
