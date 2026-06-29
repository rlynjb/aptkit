# Chapter 8 — The AI Question

In 2026, a senior interviewer will ask some version of "did you use AI to build this?" — and they already know the answer is yes, because everyone does. The question isn't a trap about whether you used AI. It's a test of whether you understand what you shipped well enough to own it. The candidates who fail this question are the ones who get defensive, evasive, or — worse — can't explain a section the AI wrote. The candidates who nail it are matter-of-fact about the tool's role, matter-of-fact about their own, and end with something the tools actually taught them.

This chapter teaches the calibrated-honest answer. The frame that makes it work: every decision in the codebase falls into one of three modes, and being able to sort your decisions into them is the whole skill.

## The chapter-opening diagram — what AI did, what you did

The split that organizes the entire answer. Sort every part of the project into one of three modes.

```
  THREE MODES OF DECISION — sort every choice into one

  ┌─ DELIBERATE (your call, you'd defend it cold) ────────────────┐
  │  • the two-seam architecture (model port + retrieval ports)   │
  │  • RAG from scratch to own the substrate                      │
  │  • local-first / zero-key as the design goal                  │
  │  • in-memory-first then additive swap to pgvector             │
  │  → AI helped TYPE these. The decisions were mine.             │
  └────────────────────────────────────────────────────────────────┘

  ┌─ EVALUATED-AND-ACCEPTED (AI proposed, you judged, you kept) ──┐
  │  • emulated tool-calling shape for Gemma (prompt + parse)     │
  │  • the bundledDependencies packaging approach                 │
  │  • precision@k / recall@k as the eval metrics                 │
  │  → AI suggested an approach; I evaluated it against the       │
  │    alternative and accepted it for named reasons.            │
  └────────────────────────────────────────────────────────────────┘

  ┌─ DEFAULTED-TO (AI's default, I didn't deeply evaluate) ───────┐
  │  • HNSW parameters (pgvector defaults)                        │
  │  • nomic-embed-text as the embedding model (not benchmarked)  │
  │  → the riskiest to own — and the most senior-positive when    │
  │    owned honestly. I name these as defaults, not as choices.  │
  └────────────────────────────────────────────────────────────────┘
```

The shape to carry: the strong answer doesn't claim everything was deliberate. It sorts honestly — and the third box, the defaulted-to one, is where owning it well earns the most credibility, because it's where weak candidates pretend.

## Question 1 — did you use AI to build this?

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Did you use AI to build this?"                         │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   NOT whether you used it. They assume you did. They're   │
│   testing your posture: defensive, evasive, or grounded?  │
│   And they're setting up the real question — "can you     │
│   explain what the AI wrote?"                             │
└─────────────────────────────────────────────────────────┘
```

> "Yes, heavily — Claude Code wrote a lot of the actual typing. The way I think about it: the architecture decisions were mine. The two-seam design, RAG from scratch to own the substrate, local-first as the goal, in-memory-first then swap — those are decisions I made and would defend cold; AI just helped me implement them faster. Then there's a layer where AI proposed an approach and I evaluated it — the emulated tool-calling shape for Gemma, for instance: the AI suggested rendering tools into the prompt and parsing JSON back, I looked at it, it matched the only real option for a model with no native tool support, and I accepted it. And then there's a layer I'm honest about: some things I took on the tool's defaults without deeply evaluating — the HNSW parameters, the specific embedding model. I can tell you which decisions fall in which bucket, and I think that's the real answer to your question."

```
  ▸ The strong answer to "did you use AI" isn't denial or
    apology. It's sorting your decisions into deliberate,
    evaluated-and-accepted, and defaulted-to — out loud.
```

## Question 2 — can you explain this section line by line?

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Pull up the trickiest part. Explain it line by line."  │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   The real test behind the AI question. Do you understand │
│   what shipped, or did you accept code you can't read?    │
│   This is where 'I used AI' candidates separate into two  │
│   groups — and there's no faking it in real time.         │
└─────────────────────────────────────────────────────────┘
```

The defense isn't a script — it's that you genuinely can. Pick the part you debugged, because you understand it deepest:

> "Take `matchesFilter` in the search tool — I know this one cold because I debugged it. It takes a hit and a filter object and returns whether the hit passes. The naive version does an exact match on every filter key, and that's the version that bit me: a model hallucinates a filter key the chunk doesn't have, exact-match fails, every result gets zeroed silently. The fix is one line of logic — a filter key only excludes a hit if the hit HAS that key with a different value. So `Object.entries(filter).every(...)` checks: for each key, either the hit doesn't have it (pass) or it has it and matches (pass); only a present-but-different key excludes. A hallucinated key the hit doesn't have can't wipe the result. AI typed the iteration, but the LOGIC is mine — it came out of reading the trace and understanding the failure."

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "Uh, this part... the AI     │ "matchesFilter — I know this │
│ generated this, it filters   │ cold because I debugged it.  │
│ the results based on the     │ A filter key only excludes a │
│ metadata. I'd have to look   │ hit if the hit HAS the key   │
│ at exactly how it works."    │ with a different value, so a │
│                              │ hallucinated key can't zero  │
│                              │ results. AI typed the loop;  │
│                              │ the logic came out of reading│
│                              │ the trace."                   │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ "I'd have to look at how it  │ Explains the logic AND why it│
│ works" on your OWN code is   │ exists, ties it to a real    │
│ the answer that ends the     │ debugging session, and draws │
│ interview. It confirms you   │ the line cleanly: AI typed,  │
│ shipped code you can't read. │ you reasoned. That's         │
│                              │ ownership, demonstrated.     │
└──────────────────────────────┴──────────────────────────────┘
```

The lesson: when they say "explain a section," pick the section you debugged, not the one that looks most impressive. The one you debugged is the one you understand to the line.

## Question 3 — what did the AI get wrong?

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "What did the AI get wrong, or where did you have to    │
│    push back on it?"                                      │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Whether you're a critical operator of the tool or a     │
│   passive accepter. The candidate who can name where they │
│   overrode the AI is the one actually steering.           │
└─────────────────────────────────────────────────────────┘
```

> "The clearest case is the silent-failure pattern. The AI's instinct — and honestly my first instinct too — was to make `search_knowledge_base` filter results and return cleanly even when the filter matched nothing. That's the bug: empty results came back with no signal. The AI was happy to produce code that failed silently because silent success looks like working code. I had to push it the other way — make the filter hallucination-tolerant, and recognize that the deeper fix is empty results should WARN, not just return empty. That's a judgment the tool didn't have because it doesn't carry the scar of debugging a silent failure. That's the division of labor: it types fast, I carry the production instincts about what failure should look like."

```
  ▸ AI is happy to ship code that fails silently, because
    silent success looks like working code. The instinct
    that empty results should WARN is yours, not the tool's.
```

## When you don't know — a defaulted-to decision you can't justify

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                        ║
║                                                           ║
║   They drill a defaulted-to decision: "Why these specific ║
║   HNSW parameters? Why nomic and not a better embedder?   ║
║   Did the AI pick those, and did you check them?"          ║
║                                                           ║
║   These are the third-box decisions — AI defaults you     ║
║   didn't deeply evaluate. The temptation is to invent a   ║
║   justification. Don't.                                   ║
║                                                           ║
║   Say:                                                    ║
║   "Those are defaults I took and didn't independently     ║
║    validate. The HNSW parameters are pgvector's defaults; ║
║    nomic was picked because it runs locally and fit the   ║
║    zero-key goal, not because I benchmarked it against    ║
║    text-embedding-3. So I can't tell you they're optimal —║
║    I can tell you they were reasonable starting points    ║
║    that I haven't measured. If this were serving traffic  ║
║    with a recall requirement, validating them is the      ║
║    first thing I'd do, and I have the precision@k and     ║
║    recall@k scorers in the evals package to do it. I'd    ║
║    rather tell you it's a default than pretend it was a    ║
║    measured choice."                                      ║
║                                                           ║
║   What this signals: this is the HARDEST mode to own and  ║
║   the most senior-positive when owned. Naming a decision  ║
║   as 'a default I didn't validate' — and how you'd        ║
║   validate it — reads as someone who knows the difference ║
║   between a choice and a default. That distinction IS     ║
║   the maturity they're probing for.                       ║
║                                                           ║
║   Do NOT say:                                             ║
║   "I chose nomic because it's the best embedding model    ║
║    for this." — claiming a benchmark you never ran. The   ║
║   follow-up ("best by what metric?") exposes it instantly.║
╚═══════════════════════════════════════════════════════════╝
```

## The follow-up tree — the AI conversation

```
  "Did you use AI to build this?"
        │
        ▼
  "Yes — and here's how I sort the decisions into three modes."
        │
        ├─► IF THEY ASK "explain a section line by line"
        │     Pick the part you DEBUGGED (matchesFilter). You
        │     understand it to the line because you earned it.
        │
        ├─► IF THEY ASK "what did the AI get wrong"
        │     The silent-failure instinct. AI ships code that
        │     fails quietly; you carry the scar that says warn.
        │
        ├─► IF THEY ASK "what did this teach you"
        │     "That the bottleneck moved from typing to judgment.
        │      The hard part isn't writing the loop — it's knowing
        │      the loop needs a hard turn budget and a forced
        │      synthesis turn. AI does the first; the second is
        │      the thing worth getting good at."
        │
        └─► IF THEY DRILL a defaulted-to decision (HNSW, embedder)
              Name it as a default, not a choice. Say how you'd
              validate it. Don't fake a benchmark.
```

## What you'd change

About the AI-assisted build itself: you'd be more deliberate earlier about the third box — the defaulted-to decisions. The pattern in this codebase is that the architecture decisions got real thought and the parameter-level defaults got accepted on the tool's say-so, which is fine for a toolkit but would be a liability in production. The change is to treat "this is an AI default I haven't validated" as a tracked item, not a silent acceptance — the same way you'd track tech debt. The tools made it frictionless to accept defaults; the discipline is to know which ones you accepted and which ones you decided.

## One-page summary

**Core claim:** "Did you use AI" tests posture and understanding, not whether you used it. The strong answer sorts every decision into three modes — deliberate, evaluated-and-accepted, defaulted-to — and owns all three, especially the third.

**Questions covered:**
- *Did you use AI?* → Yes, heavily; here are the three modes; I can sort any decision into one.
- *Explain a section line by line* → Pick the part you debugged (`matchesFilter`); explain the logic AND why it exists; AI typed, you reasoned.
- *What did the AI get wrong?* → The silent-failure instinct; AI ships quiet failures, you carry the warn-on-empty scar.
- *Why these defaults (HNSW, nomic)?* → Name them as defaults you didn't validate; say how you'd measure; don't fake a benchmark.

**Pull quotes:**
- The strong answer isn't denial or apology — it's sorting your decisions out loud.
- AI is happy to ship code that fails silently. The instinct that empty results should warn is yours, not the tool's.

**What you'd change:** Track defaulted-to decisions like tech debt — know which you decided and which you accepted on the tool's say-so.
