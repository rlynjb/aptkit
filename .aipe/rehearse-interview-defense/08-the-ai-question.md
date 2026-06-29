# Chapter 8 — The AI Question

"Did you use AI to build this?" In 2026 this is table stakes, and every
interviewer asking it already knows the answer is yes — for you and for every
other candidate in the loop. The question isn't really about whether you used
AI. It's whether you understand what you shipped well enough to *own* it. The
worst possible answer is defensive or evasive. The best is grounded:
matter-of-fact about the AI's role, matter-of-fact about your role, ending in
a real reflection on what the tools taught you.

This chapter is the one place where the honesty posture that ran quietly
through every other chapter becomes the explicit topic. You built aptkit with
heavy AI assistance — Claude wrote a lot of this code. Saying that plainly,
and then demonstrating that you can explain any line of it, is a far stronger
position than pretending you typed every character. Let's make you fluent in
owning it.

## The chapter-opening diagram — what AI did, what you did

The split that matters isn't "AI code vs my code" line by line — it's the
*decisions*. Here's the honest division by decision-mode, the three modes
from the overview made concrete for this codebase.

```
WHAT AI DID / WHAT I DID — split by decision, not by line

  ┌─ DELIBERATE (my decision, AI executed) ─────────────────┐
  │  • the library/deployment split (aptkit ↔ buffr)        │
  │  • RAG from scratch, not a framework                    │
  │  • local Gemma as the forcing-function default          │
  │  • retrieval as TWO contracts, not one class            │
  │  ► I decided the shape. AI wrote a lot of the code.      │
  └──────────────────────────────────────────────────────────┘
  ┌─ EVALUATED-AND-ACCEPTED (AI suggested, I weighed it) ───┐
  │  • forced-synthesis turn pattern in the agent loop      │
  │  • bundledDependencies packaging approach               │
  │  • minTopK floor on search_knowledge_base               │
  │  ► AI proposed; I understood the tradeoff and kept it.   │
  └──────────────────────────────────────────────────────────┘
  ┌─ DEFAULTED-TO (AI's default, I didn't deeply evaluate) ─┐
  │  • HNSW index params in buffr (took pgvector defaults)  │
  │  • the specific chunking strategy / chunk size          │
  │  • some eval scorer details                             │
  │  ► I own these as defaults I'd revisit, not as my work.  │
  └──────────────────────────────────────────────────────────┘

  the move: own all three modes openly. the third is the riskiest
  and the strongest senior signal when owned WELL.
```

That three-way split is the whole chapter. The trick is that the *defaulted-to*
box — the riskiest to admit — is the one that earns the most credibility when
you name it without flinching. Let's build the answers.

### Question 1 — "Did you use AI to build this?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Did you use AI to build this project?"           │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Not whether you used AI — they assume you did.    │
│   Whether you're DEFENSIVE about it, and whether    │
│   you can distinguish what you decided from what    │
│   the tool generated. Composure is the probe.       │
└─────────────────────────────────────────────────────┘
```

> "Yes, heavily — Claude wrote a lot of this code. I'm matter-of-fact about
> that because the interesting part isn't who typed the characters, it's who
> made the decisions. The architecture decisions were mine: the library-
> versus-deployment split, building RAG from scratch instead of a framework,
> defaulting to a local Gemma as a forcing function, making retrieval two
> contracts. I decided the shape; the AI executed a lot of it.
>
> There's a middle band where the AI suggested something and I evaluated it —
> the forced-synthesis turn in the agent loop is a good example. And there's
> an honest third band: things I took as the tool's default and didn't deeply
> evaluate, like the HNSW index parameters and the exact chunking strategy. I
> can tell you which decisions fall in which bucket, and I think that map is
> more useful than pretending I hand-wrote everything."

That answer is calm, specific, and structured around the three modes. It
preempts the follow-up ("which parts did you actually decide?") by answering
it inside the first answer. No defensiveness, no overclaiming.

```
┃ The interesting part isn't who typed the characters.
┃ It's who made the decisions — and I can map every one.
```

### Question 2 — "Can you explain this section line by line?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Pick a file. Can you walk me through this code    │
│    line by line and tell me why it's there?"        │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   The real test behind the AI question: do you      │
│   understand the code AI wrote, or did you ship it  │
│   unread? This is where evasive candidates collapse.│
└─────────────────────────────────────────────────────┘
```

The defense here isn't a speech — it's *being able to do it*. Pick the file
you understand cold and offer it. The `matchesFilter` function is perfect:
it's six lines, it's the heart of your war story, and you fixed it yourself.

> "Sure — let me pick `matchesFilter` in the search tool, because I actually
> debugged that one. It takes a hit and a filter object and returns whether
> the hit passes. The body is one line: for every key-value pair in the
> filter, the hit passes if *either* the chunk's metadata doesn't have that
> key at all, *or* it has it with a matching value. The `!(key in hit.meta)`
> is the load-bearing part — that's the clause I added. Before my fix it was a
> strict exact-match, so a hallucinated filter key like `textContains` that no
> chunk has would fail every hit and zero the results. The comment right above
> it says exactly that: a weak model's hallucinated filter can't silently wipe
> every result. I can keep going through the over-fetch logic if you want — it
> fetches 4x when filtering so the post-filter still returns a full top-k."

That's the demonstration. You didn't *say* "I understand the AI's code" — you
*proved* it on a file you can defend to the character. Always pick the file
you debugged, never a file you only read.

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "Uh, this part... I think    │ "Let me pick matchesFilter — │
│  this handles the filtering, │  I debugged that one. It      │
│  it loops through and checks │  passes a hit if every filter │
│  the metadata... I'd have to  │  key is either absent from    │
│  read it more carefully to    │  the chunk's meta OR matches. │
│  tell you exactly why each    │  The absent-key clause is the │
│  line is there."             │  line I added to fix the      │
│                              │  hallucinated-filter bug."    │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ "I'd have to read it more     │ Picks a file they OWN, walks  │
│ carefully" on your own code   │ the load-bearing line, ties   │
│ confirms the interviewer's    │ it to a real bug they fixed.  │
│ worst fear: you shipped AI    │ Proves understanding instead  │
│ code unread. Game over on     │ of asserting it. The AI       │
│ that file.                   │ question is now answered.     │
└──────────────────────────────┴──────────────────────────────┘
```

### Question 3 — "What did AI get wrong?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Where did the AI steer you wrong, or where did   │
│    you have to override it?"                        │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you treat AI output critically, or accept it    │
│   wholesale? Naming where you OVERRODE the tool is   │
│   the strongest possible proof you're driving.       │
└─────────────────────────────────────────────────────┘
```

> "The clearest place is the `matchesFilter` bug itself — in a sense the AI-
> generated exact-match filter logic *was* the wrong call for a system using a
> weak local model that hallucinates arguments. The original logic was
> technically reasonable; it just didn't account for a model inventing filter
> keys. I had to understand the failure from the trace and override it with
> the absent-key-tolerant version. That's the pattern with AI code generally:
> it writes locally-correct code that doesn't account for the *specific*
> failure modes of *my* system. The judgment call — 'a weak model will
> hallucinate filters, so this needs to be tolerant' — is the part I bring.
>
> Honestly, the broader thing AI gets wrong is it'll happily generate the
> defaulted-to decisions and present them with the same confidence as the
> deliberate ones. The HNSW defaults, the chunk size — it'll pick something
> reasonable and move on. Part of my job is knowing which of its confident
> choices I actually evaluated and which I just accepted."

That answer is gold because it ties "what AI got wrong" directly to your war
story (the filter) and to your honest decision-map (defaulted-to choices). It
shows you treat AI as a strong but fallible collaborator, and that the
*judgment* — not the typing — is your contribution.

```
"Did you use AI?" → "yes, heavily"
      │
      ├─► IF THEY ASK "so what's actually YOUR work?"
      │     The decisions and the judgment. The architecture
      │     was mine; I can map every choice to deliberate /
      │     evaluated / defaulted. → the three-mode split.
      │
      ├─► IF THEY ASK "explain a file line by line"
      │     Pick matchesFilter or runAgentLoop — files I
      │     debugged. Walk the load-bearing line. PROVE it.
      │
      ├─► IF THEY ASK "what did AI get wrong?"
      │     The exact-match filter for a hallucinating model;
      │     and it presents defaulted choices as confidently
      │     as deliberate ones. I bring the judgment.
      │
      └─► IF THEY ASK "did you fine-tune anything?"
            No — deliberately. Fine-tuning is eval-gated and I
            didn't have the eval bar to justify it. → recovery box.
```

```
╔════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                     ║
║                                                         ║
║   They push into ML depth you deliberately don't have:  ║
║   "Why didn't you fine-tune Gemma for tool-calling      ║
║   instead of emulating it? Walk me through how you'd    ║
║   set up the fine-tuning run."                          ║
║                                                         ║
║   You have NOT done fine-tuning — it's a deliberate gap, ║
║   not an accidental one. You chose emulation over fine-  ║
║   tuning on purpose. Own the choice AND the gap.         ║
║                                                         ║
║   Say:                                                  ║
║   "I didn't fine-tune, and that was deliberate. Fine-   ║
║    tuning is something I'd want to gate behind a real    ║
║    eval bar — I'd need to prove emulated tool-calling    ║
║    was the actual bottleneck before spending the data    ║
║    and compute to fine-tune, and my evals weren't at     ║
║    that bar. Emulation got me working tool-calls on a    ║
║    model that has none, which was enough for what I was  ║
║    building. As for setting up the run itself — the      ║
║    data prep, the training loop — I haven't done a fine- ║
║    tuning run, so I'd be learning that, not telling you  ║
║    from experience. The DECISION not to fine-tune I can  ║
║    defend; the mechanics I'd be picking up."            ║
║                                                         ║
║   What this signals: you made fine-tuning a deliberate,  ║
║   eval-gated NON-decision (senior — you don't fine-tune  ║
║   on vibes), and you cleanly separate "I can defend the  ║
║   decision" from "I haven't done the mechanics."         ║
║                                                         ║
║   Do NOT say:                                            ║
║   "Fine-tuning would've been better but I didn't have    ║
║    time" — that frames a deliberate, defensible choice   ║
║   as a corner you cut, and invites a dig into mechanics   ║
║   you haven't practiced.                                ║
╚════════════════════════════════════════════════════════╝
```

### The closing reflection — what the tools taught you

End the AI question on a real reflection. Not a platitude — a specific thing
the build taught you about working with these tools. Here's yours:

> "What building aptkit with heavy AI assistance actually taught me is that
> the bottleneck moved. The typing isn't the work anymore — the AI does that
> fast. The work is judgment: knowing which of the tool's confident choices to
> evaluate and which to accept, knowing that locally-correct code can be
> globally wrong for *my* system's failure modes, and being able to debug the
> thing the AI built when it breaks in a way the AI didn't anticipate. The
> `matchesFilter` bug is the whole lesson in one function — the AI wrote
> reasonable code, my system had a failure mode the code didn't expect, and
> closing that gap required understanding the system end to end. That's the
> skill that didn't get automated away. If anything it got more valuable."

That reflection is the strongest possible close to the AI question. It's
specific (the filter bug), it's honest (AI did the typing), and it names the
durable skill (judgment + debugging) without sounding defensive or
self-congratulatory.

```
        ▸ The typing got automated. The judgment didn't. Owning
          what you shipped means owning the decisions, not the
          keystrokes.
```

## What you'd change

If I were doing the AI-assisted build over, I'd keep a running decision log
that tags each significant choice as deliberate, evaluated, or defaulted-to *as
I make it* — because reconstructing that map after the fact is harder than it
should be, and the map is exactly what makes the AI question easy to answer.
The honest meta-point: the thing I'd improve isn't the code AI wrote, it's my
own record of which decisions I actually owned versus accepted. That record is
the difference between sounding like you built the system and sounding like
you supervised it.

## One-page summary — Chapter 8

```
CORE CLAIM
  Own AI assistance plainly. The probe is composure + whether you
  can map decisions to deliberate / evaluated / defaulted-to.

QUESTIONS COVERED
  Q: Did you use AI? A: Yes, heavily — Claude wrote a lot. The work
     was the DECISIONS; I can map each to one of three modes.
  Q: Explain a file line by line? A: PROVE it — pick matchesFilter
     (debugged it). Walk the absent-key clause I added. Don't assert.
  Q: What did AI get wrong? A: exact-match filter for a hallucinating
     model; it presents defaulted choices as confidently as deliberate.
  Q: Why not fine-tune? A: deliberate, eval-gated non-decision.
     Defend the decision; honest the mechanics are unpracticed. (box)

PULL QUOTES
  ▸ The interesting part isn't who typed the characters.
  ▸ The typing got automated; the judgment didn't.

WHAT YOU'D CHANGE
  Keep a live decision log tagging each choice deliberate/evaluated/
  defaulted-to as I make it — the map is what makes this question easy.
```
