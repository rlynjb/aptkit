# Chapter 7 — The Counterfactuals

"What would you do differently?" is a gift, and most candidates fumble it. The fumble has two shapes: claiming you'd change nothing (reads as no self-reflection), or inventing regrets for decisions that were obviously right (reads as no conviction). The senior move is the third path — volunteer the two or three decisions you'd genuinely reconsider, and defend the ones you wouldn't with the same honesty. Knowing which decisions you'd flip AND which you'd keep, and why, is the whole point.

This chapter walks aptkit's four most reconsiderable decisions. For each: would you flip it, and what would have to be true for the flip to be right.

## The chapter-opening diagram — the counterfactuals matrix

Four decisions, each with the condition that would flip it and your honest verdict on how likely that flip is.

```
  COUNTERFACTUALS MATRIX — decision · what would flip it · likelihood

  ┌────────────────────┬───────────────────────────┬──────────────┐
  │ DECISION           │ WOULD FLIP IF…            │ FLIP ODDS    │
  ├────────────────────┼───────────────────────────┼──────────────┤
  │ local Gemma        │ reliability / latency      │ LIKELY       │
  │ default            │ matters more than          │ (the one I'd │
  │                    │ local-first repro          │  most revisit)│
  ├────────────────────┼───────────────────────────┼──────────────┤
  │ RAG from scratch   │ a hard production deadline │ SITUATIONAL  │
  │                    │ with no time to own the    │ (right then, │
  │                    │ substrate                  │  not now)    │
  ├────────────────────┼───────────────────────────┼──────────────┤
  │ in-memory store    │ ~never — it was sequencing,│ ALMOST NEVER │
  │ first              │ not debt; the swap was      │ (keep it)    │
  │                    │ additive                    │              │
  ├────────────────────┼───────────────────────────┼──────────────┤
  │ one bundle, 16     │ multiple independent        │ CONDITIONAL  │
  │ packages inlined   │ consumers wanting different │ (one         │
  │                    │ subsets                     │  consumer →  │
  │                    │                             │  keep)       │
  └────────────────────┴───────────────────────────┴──────────────┘
```

The shape to carry: one decision I'd likely flip (the model default), one situational (RAG-from-scratch under a deadline), one I'd keep almost no matter what (in-memory-first), one conditional on a fact that isn't true yet (the bundle). A real engineer has all four kinds — not four regrets, not zero.

## Decision 1 — local Gemma default (the one you'd most likely flip)

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "If you started this today, what would you change?"     │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Can you self-critique with conviction? Do you volunteer  │
│   a real reconsideration, or do you say "nothing, it's    │
│   great"? The volunteered counterfactual is the senior     │
│   tell.                                                   │
└─────────────────────────────────────────────────────────┘
```

> "The decision I'd most likely revisit is defaulting to local Gemma. It was right for what aptkit is — a toolkit you can clone and run with no cloud key — but the cost is the emulated tool-calling, which is a genuine reliability tax: every tool call is a JSON-parse-and-maybe-retry instead of a native structured call. If I were optimizing for reliability and latency over local-first reproducibility, I'd flip the default to a frontier model with native tool-calling and keep Gemma as the offline option. What makes this an easy thing to say is that the `ModelProvider` port makes it a config change — the adapters are already there. So the counterfactual isn't 'I'd rebuild it,' it's 'I'd change one default,' which is exactly the kind of cheap reversal a good boundary buys you."

```
  ▸ The senior-engineer move is to volunteer what you'd
    reconsider before being asked — and to show the boundary
    that makes the change cheap.
```

## Decision 2 — RAG from scratch (the situational one)

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Would you build the RAG pipeline from scratch again?"  │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Can you separate 'right for this context' from 'right    │
│   always'? A candidate who says "from-scratch is always   │
│   better" is as suspect as one who says "always use a      │
│   framework."                                             │
└─────────────────────────────────────────────────────────┘
```

> "For aptkit, yes — the whole point was owning the substrate, and building from contracts is what let memory reuse them for free. But that answer is context-dependent. If I were shipping a product on a hard deadline and retrieval was a means, not the thing I wanted to understand, I'd reach for a framework and accept the opaque control flow to hit the date. The decision wasn't 'from-scratch is better' — it was 'for a toolkit whose purpose is the substrate, from-scratch is right.' Change the purpose and I'd flip it. That's not a regret; it's a decision that's correct conditional on the goal."

This is the answer that shows judgment — the same decision goes the other way under a different constraint, and you can name the constraint.

## Decision 3 — in-memory store first (the one you'd keep)

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "The in-memory store — wouldn't you just start with     │
│    pgvector if you did it again?"                         │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Will you cave and 'agree' that the simpler thing was a   │
│   mistake just because they implied it? Or will you hold   │
│   a correct decision under mild pressure?                 │
└─────────────────────────────────────────────────────────┘
```

This is the one where they're testing whether you'll fold. Don't.

> "No — I'd keep it, and I'd keep it almost regardless of the scenario. Starting in-memory wasn't debt; it was sequencing. It let me validate the `VectorStore` contract with zero infrastructure and instant deterministic tests, and because pgvector implements the same contract, moving to durable storage was additive — buffr's `PgVectorStore` swap, no agent change. If I'd started on pgvector I'd have paid the infrastructure cost before I knew the contract shape was right. The only world where I start on pgvector is if I already knew the contract from a prior build — and even then, in-memory keeps the test suite fast. So this is the decision I'd flip least."

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "Yeah, you're probably right,│ "No — I'd keep it. It was    │
│ I should've just used         │ sequencing, not debt. The    │
│ pgvector from the start, the  │ in-memory store validated the│
│ in-memory thing was kind of a │ contract with zero infra and │
│ shortcut."                    │ instant tests, and the swap  │
│                              │ to pgvector was additive     │
│                              │ behind the same contract. I  │
│                              │ wouldn't pay infra cost before│
│                              │ knowing the contract shape."  │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ It caves to an implied        │ Holds a correct decision     │
│ criticism. The interviewer    │ under pressure WITH the      │
│ was testing whether you'd      │ reasoning. Conviction backed │
│ fold, and you did. Now they    │ by a real argument is the    │
│ trust your other answers less.│ thing they were testing for. │
└──────────────────────────────┴──────────────────────────────┘
```

The trap in this question is the word "just." It implies the simpler path was obviously correct and you over-engineered. The strong answer reframes: it wasn't a shortcut, it was the right first rung, and the proof is the additive swap.

## Decision 4 — one bundle (the conditional one)

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Would you bundle into one package again, or publish     │
│    them separately?"                                      │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Do you tie the decision to a real fact about the world   │
│   (number of consumers), or do you have a dogmatic         │
│   preference?                                             │
└─────────────────────────────────────────────────────────┘
```

> "Conditional on the number of consumers. Today there's one — buffr — so one bundle is right: one install, one version, no matrix to reconcile, and the `bundledDependencies` approach inlines all 16 packages into a single tarball. The moment there's a second independent consumer that wants a different subset, the bundle's cost — you take all 16 even if you want three — stops being free, and I'd publish the packages separately with their own versions. So I wouldn't flip it today, but I'd flip it the day a second consumer with different needs showed up. The decision is tied to a fact, not a preference."

## When you don't know — a counterfactual you genuinely haven't considered

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                        ║
║                                                           ║
║   They ask a counterfactual you haven't thought about:    ║
║   "Would you have used a different trace format — say,     ║
║   OpenTelemetry spans instead of your own CapabilityEvent  ║
║   union — so it plugs into standard observability tools?"  ║
║                                                           ║
║   You designed CapabilityEvent as a domain-specific        ║
║   discriminated union and you have NOT evaluated it        ║
║   against OpenTelemetry. You don't have a rehearsed take.  ║
║                                                           ║
║   Say:                                                    ║
║   "Honestly, I haven't evaluated that tradeoff. I built    ║
║    CapabilityEvent as a domain-specific union because I    ║
║    wanted the agent's step / tool-call / usage events to   ║
║    be first-class and easy to replay in Studio, and that   ║
║    served the goal. I can see the argument for OTel —      ║
║    standard tooling, existing backends — and the cost      ║
║    would be losing the domain-specific shape that makes    ║
║    replay clean. But I haven't actually weighed those, so  ║
║    I won't pretend I have a settled answer. It's a good     ║
║    thing to think about."                                 ║
║                                                           ║
║   What this signals: you can reason about a tradeoff in    ║
║   real time without pretending you'd already decided it.   ║
║   "I haven't weighed that" followed by an honest sketch    ║
║   of both sides beats a fabricated counterfactual.        ║
║                                                           ║
║   Do NOT say:                                             ║
║   "Yeah I definitely should've used OpenTelemetry, that    ║
║    was a mistake." — inventing a regret to seem reflective.║
║   It's a fake counterfactual and the next question         ║
║   ("why?") exposes that you hadn't thought about it.      ║
╚═══════════════════════════════════════════════════════════╝
```

## What you'd change

The meta-lesson of this chapter is the discipline itself: have your counterfactuals ranked before you walk in. Not a generic "I'd improve testing" — the specific four above, each tied to the condition that flips it. The single thing you'd change about how you PRESENT the project is to lead the architecture discussion with one volunteered counterfactual (the model default), because volunteering it before being asked is the move that makes everything else you say more credible. The candidate who says "here's the one I'd reconsider" before the interviewer probes has already won the judgment question.

## One-page summary

**Core claim:** Volunteer the decisions you'd reconsider AND defend the ones you'd keep, each tied to the condition that would flip it. Four kinds of decision — likely flip, situational, almost-never, conditional — not four regrets and not zero.

**Decisions covered (4 reconsiderable):**
1. *Local Gemma default* → likely flip if reliability/latency beats local-first; cheap because the port makes it a config change.
2. *RAG from scratch* → situational; right for a substrate toolkit, would use a framework under a hard product deadline.
3. *In-memory store first* → keep almost always; sequencing not debt; additive swap proved it; don't fold when they say "just."
4. *One bundle* → conditional on consumer count; one consumer keeps the bundle, a second independent one flips to separate packages.
5. *(Unrehearsed) trace format vs OpenTelemetry* → haven't weighed it; sketch both sides honestly rather than fake a regret.

**Pull quote:** The senior move is to volunteer what you'd reconsider before being asked — and to show the boundary that makes the change cheap.

**What you'd change:** Lead the architecture talk with one volunteered counterfactual. Volunteering it first makes every other answer more credible.
