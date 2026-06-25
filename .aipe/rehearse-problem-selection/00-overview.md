# Problem Selection — aptkit

This is the brief you bring to the review room *before* anyone asks how the system works. It answers a harder question than "is the code good": **does this problem deserve the months you spent on it?** That's the question a skeptical reviewer actually has, and it's the one a "walk me through the architecture" answer skips right past. This book makes you defend the *investment*, not the implementation.

Read it verdict-first. The verdict is up top, the whole brief fits on this screen, and the five deep files behind it each take one slice and refuse to flinch on it.

## The verdict — up top, before the map

```
  THE CALL

  Problem:  Every AI app you build re-wires its own RAG/agent plumbing
            from scratch and locks itself to one cloud vendor.
  Chosen:   BUILD the reusable, local-first, provider-neutral substrate
            yourself (aptkit) — proven by ONE real consumer (buffr).
  Not:      adopt LangChain / a turnkey hosted agent  ·  do nothing
  Honest:   There are NO external users. The "user" is you and your apps.
            This is personal tooling + a portfolio artifact for the
            frontend→AI pivot. The brief is honest about that the whole way.
```

The one sentence you defend:

```
┃ "I build a different AI app every year and re-wire the
┃  same RAG-and-agent plumbing each time, locked to a
┃  different cloud each time — so I built the substrate
┃  once, local-first and vendor-neutral, and proved it
┃  by making a second app consume it unchanged."
```

## The whole brief, one screen

Here is the entire argument as a single map — the pain at the top, the fork that actually happened in the middle, the slice you cut, and the loop that tells you it worked.

```
  THE PROBLEM-SELECTION MAP

  ┌─ THE PAIN ─────────────────────────────────────────────────────────┐
  │  AdvntrCue: Next.js + pgvector + GPT-4, bespoke RAG, cloud-locked.  │
  │  EVIDENCE: that stack exists and was hand-wired.                   │
  │  INFERENCE: the next app repeats it. ← labelled, not asserted.     │
  └───────────────────────────────┬────────────────────────────────────┘
                                  │  who feels it? → you + your apps.
                                  │  no external users (by design).
  ┌─ THE FORK THAT HAPPENED ──────▼────────────────────────────────────┐
  │  A. do nothing  → keep per-app bespoke RAG like AdvntrCue          │
  │       opp cost: no reuse, no portfolio artifact, repeated work     │
  │  B. adopt framework / hosted agent (LangChain · "Hermes"-style)   │
  │       opp cost: lock-in, learn the API not the substrate,          │
  │                 weaker pivot signal, cloud bill + privacy          │
  │  ★ C. BUILD aptkit — provider-neutral local-first substrate ★     │
  │       opp cost: more code you own, slower to first demo            │
  │       VERDICT: C — for learning + portfolio + control + local      │
  └───────────────────────────────┬────────────────────────────────────┘
                                  │  validate the premise with the
                                  │  NARROWEST slice that can fail.
  ┌─ THE SLICE ───────────────────▼────────────────────────────────────┐
  │  de-risk spike → packages A–E (runtime/provider · retrieval ·      │
  │  agent · evals) → ONE consumer (buffr) on LIVE Supabase pgvector.  │
  │  Premise proven IFF: reusable + swappable + local, downstream.     │
  └───────────────────────────────┬────────────────────────────────────┘
                                  │  did it work? measure, don't vibe.
  ┌─ THE LOOP ────────────────────▼────────────────────────────────────┐
  │  precision@k / recall@k over a small REAL corpus                   │
  │  one-line VectorStore swap verified across TWO repos (InMem→Pg)    │
  │  clean-clone `npm i @rlynjb/aptkit-core` builds in buffr           │
  │  loop: live run → trace → score → promote to fixture → regression  │
  └─────────────────────────────────────────────────────────────────────┘
```

The shape to notice: the pain is half evidence and half labelled inference, the fork is three real options each with a named cost, the slice is one downstream consumer and not a wishlist, and the loop is measured outcomes — not "it feels reusable."

## The reading guide

The five files behind this one go deep on their slice, in the spec's 10-answer order. Read them front-to-back the first time; pull one when a reviewer pushes on it.

| File | The slice | The question it answers | Pull it when |
|------|-----------|-------------------------|--------------|
| `01-problem-brief.md` | pain · evidence · why now · who | "What problem, for whom, and how do you know?" | They ask "who actually needs this?" |
| `02-scope-cuts-and-non-goals.md` | smallest slice · cuts · constraints | "What's the smallest thing that proves it — and what did you refuse to build?" | They ask "isn't this over-scoped?" |
| `03-options-and-opportunity-cost.md` | do-nothing · framework · build | "What were the alternatives, and what did each cost?" | They ask "why not just use LangChain?" |
| `04-success-metrics-and-feedback-loop.md` | metrics · the loop | "How do you know it worked, not just that it ran?" | They ask "what does success look like?" |
| `05-skeptical-reviewer-questions.md` | the five objections | "Defend it under fire — strong answer + honest limit." | The morning of the review |

## Two register notes that run through every file

- **Evidence and inference are kept apart, always.** The repo proves the substrate *works* (16-package bundle, evals green, a second repo consuming the `VectorStore` contract unchanged). The repo does NOT prove anyone *external* needs it — there are zero external users, and every file says so out loud. Where the evidence is thin, the file lists the discovery question instead of asserting a fact.
- **The honest answer is the strong answer here.** This is personal tooling and a portfolio piece. Pretending it has a user base would collapse on the first follow-up. The defense isn't "people need this" — it's "*I* needed this, I knew the three ways to get it, and I can show the one that paid off."

```
▸ The skeptical reviewer's real question isn't "is the
  code good." It's "was this problem worth solving at
  all." This brief answers that one — verdict first,
  evidence and inference kept honest, no invented users.
```
