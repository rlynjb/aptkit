# The Problem Brief

The brief is the part a "walk me through the system" answer never reaches: *who hurts, how you know, why now.* Lead with the map of where the pain lives, then keep evidence and inference in separate columns so a reviewer can't catch you smuggling a wish in as a fact.

## Where the pain lives

Here is the recurring loop that every AI app you've built has paid into — drawn as the cycle it actually is.

```
  THE RE-WIRING LOOP — one cycle per app

  ┌─ APP N ────────────────────────────────────────────────────┐
  │  pick a cloud model SDK   →   hand-wire embed + vector      │
  │  (GPT-4 for AdvntrCue)        store + retrieve + agent loop │
  └───────────────┬─────────────────────────────┬──────────────┘
                  │ ships                        │ locked to that
                  ▼                              ▼ vendor's SDK
  ┌─ APP N+1 ──────────────────────────────────────────────────┐
  │  pick a cloud model SDK   →   hand-wire embed + vector      │  ← INFERENCE:
  │  (different vendor)            store + retrieve + agent loop │     the loop
  └─────────────────────────────────────────────────────────────┘     repeats
            ▲                                                            unchanged
            └── nothing from APP N carried over. plumbing rebuilt.
```

The pain isn't "RAG is hard." You've shipped RAG — AdvntrCue did it on Next.js + pgvector + GPT-4 with tool-calling and session memory. The pain is that **none of that plumbing was reusable across apps, and all of it was welded to one cloud vendor.** The next app starts the welding over.

## Who feels it — and who doesn't

Be precise here, because the whole brief's honesty hinges on it.

```
  BENEFICIARIES vs EXCLUSIONS

  ┌─ FEELS THE PAIN / BENEFITS ─────────────────────────────────┐
  │  · You — the engineer re-wiring the same plumbing per app   │
  │  · Your apps — buffr TODAY; future apps by reuse            │
  │  · Your portfolio — the frontend→AI pivot needs an artifact │
  └─────────────────────────────────────────────────────────────┘
  ┌─ INTENTIONALLY OUTSIDE SCOPE ───────────────────────────────┐
  │  · External / 3rd-party developers — NOT a product for them │
  │  · Multi-tenant SaaS customers — NOT a hosted service       │
  │  · A team — this is solo personal tooling                   │
  └─────────────────────────────────────────────────────────────┘
```

The "user" is you and your own apps. State that plainly. A reviewer who hears "thousands of developers need this" and then finds a private monorepo with one consumer stops believing everything else you say.

## Evidence vs inference — kept apart

This is the load-bearing distinction in the whole brief. The repo proves some things and merely suggests others. Here's the split, with nothing crossing the line.

```
  EVIDENCE (in the repo, you can open it)  │  INFERENCE (labelled, not proven)
  ─────────────────────────────────────────┼──────────────────────────────────
  AdvntrCue's bespoke cloud-locked stack    │  The next app would repeat the
  existed and was hand-wired                │  re-wiring → unproven until app N+1
  ─────────────────────────────────────────┼──────────────────────────────────
  aptkit substrate works: 16-pkg bundle     │  The substrate SAVES net time
  @rlynjb/aptkit-core@0.4.1 builds, evals    │  across apps → not yet measured;
  pass, runtime never imports a vendor SDK  │  building it cost time up front
  ─────────────────────────────────────────┼──────────────────────────────────
  Reuse is REAL across two repos: buffr's   │  Reuse generalizes to a THIRD app
  PgVectorStore implements the same         │  → only one consumer exists, so
  VectorStore contract from aptkit          │  the pattern is shown once, not N
  ─────────────────────────────────────────┼──────────────────────────────────
  Local-first works: Gemma2:9b over Ollama  │  A local 9B model is GOOD ENOUGH
  at localhost:11434 runs the agent loop    │  for real use → see metrics file;
  with zero cloud calls                     │  measured on a small corpus only
  ─────────────────────────────────────────┼──────────────────────────────────
  Zero external users                       │  External demand exists → NONE.
  (private repo, one consumer)              │  By design. Do not infer a market.
```

The strong move is to volunteer the right-hand column before a reviewer drags it out of you.

```
┃ "The repo proves the substrate WORKS — bundle builds,
┃  evals pass, a second repo consumes the contract
┃  unchanged. It does NOT prove anyone external NEEDS it.
┃  There are no external users, and that's by design."
```

## What it actually costs today

Name the cost in the currency it's actually paid in — not in invented business dollars.

```
  THE REAL COST LEDGER

  ┌─ MEASURED (or directly observable) ────────────────────────┐
  │  · Your solo time, spent up front building the substrate   │
  │  · Slower to first demo than importing a framework         │
  └─────────────────────────────────────────────────────────────┘
  ┌─ NOT MEASURED — do not claim it ───────────────────────────┐
  │  · No business cost: no team, no users, no SLA, no churn   │
  │  · No per-token cloud bill (local-first → that's the point)│
  │  · AdvntrCue's ~$700K client savings was a DIFFERENT proj — │
  │    don't borrow it here; it's not aptkit's evidence        │
  └─────────────────────────────────────────────────────────────┘
```

The cost is your repeated effort and the portfolio opportunity cost of *not* having a reusable, demonstrable artifact for the pivot. It is not a dollar figure, and pretending it is would be the easiest claim to puncture.

## Why now

Two things changed, and both are real — one career, one technical.

```
  WHY NOW — two clocks running

  ┌─ CAREER CLOCK ─────────────────────────────────────────────┐
  │  The frontend→AI pivot is the LIVE move (7+ yrs Vue/React  │
  │  → AI engineering). The pivot needs a portfolio artifact   │
  │  that proves substrate-depth, not just framework-glue.     │
  └─────────────────────────────────────────────────────────────┘
  ┌─ TECHNICAL CLOCK ──────────────────────────────────────────┐
  │  Local open-weights crossed the line: Gemma2:9b over       │
  │  Ollama now runs a full agent loop on a laptop with zero   │
  │  cloud. A year ago "local-first agent" wasn't feasible on  │
  │  this hardware. Now it is — so the local-first bet is now   │
  │  cashable, not aspirational.                                │
  └─────────────────────────────────────────────────────────────┘
```

The two clocks reinforce each other: the pivot wants depth-signal, and local open-weights are exactly where you get to *show* depth — you had to teach a model with no native tool-calling to call tools, which a cloud SDK would have hidden.

```
▸ "Why now" isn't a slogan. It's two clocks: the pivot
  is the live career move, and local open-weights just
  made a zero-cloud agent loop feasible on a laptop. Miss
  either and the timing argument is half-empty.
```

## The discovery questions — where evidence is thin

The brief refuses to assert what the repo can't prove. Where it's thin, here's what you'd have to learn before betting more.

```
  BEFORE INVESTING FURTHER, ANSWER:

  Q1  Does app N+1 actually reuse the substrate unchanged,
      or does it fork it? (Only buffr proves reuse today —
      n=1. A second consumer is the real test.)

  Q2  Is the net time saved positive across apps, or did
      building the substrate cost more than it returns?
      (Not measured. Needs a real before/after on app N+1.)

  Q3  Is the local 9B model good enough for a USE you'd
      ship, or only good enough for a demo? (See 04 — measured
      on a small corpus; not validated at app scale.)

  Q4  Does the portfolio artifact land the pivot — does it
      change interview outcomes? (Unmeasured; the only
      real-world signal that the portfolio bet paid off.)
```

These are not weaknesses to hide. Listing them is the senior move — it shows you know exactly which claims are proven and which are still bets.

## One-screen recap

```
  THE BRIEF IN ONE FRAME

  PAIN     re-wire RAG/agent plumbing per app + vendor lock-in
  WHO      you + your apps (buffr today) + your portfolio
  NOT      external devs · SaaS customers · a team
  EVIDENCE substrate WORKS (bundle, evals, 2-repo contract reuse)
  INFER    substrate SAVES time / generalizes / is "needed" — unproven
  COST     your solo time + slower first demo (NOT a business $ figure)
  WHY NOW  the pivot is live + local open-weights now run on a laptop
  THIN     n=1 consumer · net-time-saved unmeasured · no external demand
```

**The one thing to remember:** the problem is real and *you* feel it — but the user is you, the evidence is "it works" not "people need it," and the honest version of that is the strong version. Lead with the pain, keep the two columns apart, and list the discovery question wherever a fact would be a bluff.
