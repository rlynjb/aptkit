# Options and Opportunity Cost

A review room doesn't trust a chosen option until it hears the ones you *didn't* choose — with the cost of each named, including the cost of the one you took. This file lays out the three real forks, `do nothing` included, and pays the opportunity cost out loud on every branch.

## The fork that actually happened

Here is the decision, drawn as the tree it was — with the branch you took marked and the cost of every branch named on it.

```
  THE OPTIONS — what you could have done, what each cost

  ┌─ A. DO NOTHING ────────────────────────────────────────────┐
  │  Keep per-app bespoke RAG, like AdvntrCue. Re-wire the     │
  │  plumbing again for the next app. Stay cloud-locked.      │
  │     OPP COST: no reuse · no portfolio artifact ·          │
  │               repeated work every app · no depth-signal   │
  └───────────────────────────────┬────────────────────────────┘
                                  │ rejected — pays the pivot
                                  │ in repeated effort forever
  ┌─ B. ADOPT A FRAMEWORK / HOSTED AGENT ──────────────────────┐
  │  LangChain · LlamaIndex · a turnkey "Hermes"-style hosted │
  │  agent. Import the glue instead of owning it.            │
  │     OPP COST: vendor / framework lock-in · you learn the  │
  │               framework's API, NOT the substrate ·        │
  │               weaker pivot signal (glue, not depth) ·     │
  │               cloud bill + data leaves the machine        │
  └───────────────────────────────┬────────────────────────────┘
                                  │ rejected — buys speed,
                                  │ costs the learning + control
  ┌─ ★ C. BUILD aptkit ★ ──────────────────────────────────────┐
  │  Provider-neutral, local-first substrate built from       │
  │  contracts. Own the runtime, the provider seam, the RAG.  │
  │     OPP COST: more code you own · slower to first demo ·  │
  │               you maintain it                              │
  │     BOUGHT:   reuse · portfolio depth-signal · control ·  │
  │               local-first · no lock-in                     │
  └─────────────────────────────────────────────────────────────┘

  VERDICT: C — for learning + portfolio + control + local-first.
```

The discipline a reviewer is grading: every branch costs something, and you can name the cost of the one you *took* — "more code I own, slower to first demo" — not just the costs of the ones you rejected. A candidate who can only attack the alternatives reads as defensive; one who prices their own choice reads as honest.

## Option A — do nothing, in detail

`do nothing` is a real option, and naming its cost is what makes the chosen option earn its keep.

```
  DO NOTHING — the cost compounds per app

  app 1 (AdvntrCue) ─► hand-wire RAG ─► ship ─► throw plumbing away
  app 2             ─► hand-wire RAG ─► ship ─► throw plumbing away
  app 3             ─► hand-wire RAG ─► ship ─► throw plumbing away
       ▲                                              │
       └──────────── nothing carries over ────────────┘

  the cost isn't one big bill — it's the same medium bill,
  paid again every app, forever, with no artifact to show for it.
```

The honest part: `do nothing` is *cheapest for any single app.* If you only ever built one more AI app, building a substrate would be over-investment. The case for building rests entirely on the inference that there's an app N+1 — which is labelled inference, not proven. That's the genuine weakness of the chosen option, and you say it before a reviewer does.

```
┃ "Do nothing is cheapest for ONE app. Building the
┃  substrate only pays off if there's an app N+1 — and
┃  that's an inference, not a fact. I'm betting on the
┃  pivot, not on a proven pipeline of apps."
```

## Option B — adopt a framework, in detail

This is the option most reviewers expect you to have taken, so the cost has to be specific, not a vibe.

```
  ADOPT A FRAMEWORK — what you import vs what you give up

  ┌─ YOU IMPORT (the upside) ──────────────────────────────────┐
  │  connectors · chunking strategies · agent loops ·          │
  │  integrations — all out of the box, fast to first demo     │
  └─────────────────────────────────────────────────────────────┘
  ┌─ YOU GIVE UP (the opportunity cost) ───────────────────────┐
  │  · lock-in: a version bump or a hidden internal can break  │
  │    you, and the fix isn't yours to make                    │
  │  · you learn the FRAMEWORK'S API, not how a provider seam  │
  │    or a tool-emulation loop actually works                 │
  │  · weaker pivot signal: "I wired LangChain" reads as glue; │
  │    "I built the substrate" reads as depth                  │
  │  · cloud-default: most turnkey agents assume a hosted      │
  │    model — a bill, and data leaving the machine            │
  └─────────────────────────────────────────────────────────────┘
```

The honest counter-case: for a *one-off app*, B is the right call. You'd reach for the framework. The reason B loses *here* is that the goal isn't shipping one app fast — it's owning a reusable substrate and producing a portfolio artifact that proves substrate-depth for an AI-engineering pivot. Different goal, different winner.

```
▸ For an app, the framework wins — I'd use it. For a
  reusable substrate meant to prove depth, owning the
  contract IS the product. The goal picks the option,
  and my goal is the pivot, not the demo.
```

## Option C — build aptkit, and why the cost was worth it

The chosen option, with its cost paid in full and its payoff named — not as a slogan, as a thing the repo can show.

```
  BUILD aptkit — the cost, and what it bought

  COST PAID                          │  WHAT IT BOUGHT (provable)
  ───────────────────────────────────┼─────────────────────────────────
  more code you own + maintain        │  ModelProvider.complete() seam →
                                      │  swap + fixture + fallback at once
  ───────────────────────────────────┼─────────────────────────────────
  slower to first demo than           │  RAG from contracts → in-memory
  `import langchain`                  │  tests, no Postgres, no lock-in
  ───────────────────────────────────┼─────────────────────────────────
  you teach a model to do what a      │  Gemma tool-emulation → the
  cloud SDK gives free                │  depth-signal a framework hides
  ───────────────────────────────────┼─────────────────────────────────
  you build the eval harness          │  precision@k/recall@k + rubric-
  yourself                            │  judge → measured, not vibed
```

The verdict rests on four words and they're all about *your* goals, not the market: **learning** (open-weights forced you to understand the parts a cloud SDK hides), **portfolio** (a substrate is a stronger pivot artifact than framework-glue), **control** (no version bump breaks you), and **local-first** (zero cloud, data stays on the laptop, now feasible on a 9B model).

```
┃ "I chose to build for four reasons that are all about
┃  the goal, not the market: learning, portfolio, control,
┃  local-first. The cost is real — more code, slower demo.
┃  I paid it on purpose, because the alternative buys speed
┃  with the exact depth-signal the pivot needs."
```

## The discovery question the options leave open

The options analysis has one unproven hinge, and you name it.

```
  THE OPEN QUESTION BEHIND THE VERDICT

  The whole case for C over A rests on:
    "there is an app N+1 that reuses the substrate"

  PROVEN today:   buffr consumes the VectorStore contract → n=1
  NOT proven:     a THIRD app reuses it → the inference that
                  makes building beat do-nothing is still a bet

  → discovery: build app N+2 and measure whether it reuses
    the substrate unchanged, or forks it. That's the test that
    turns the verdict from a bet into a fact.
```

## One-screen recap

```
  OPTIONS IN ONE FRAME

  A  do nothing      → cheapest for ONE app; no reuse, no
                       artifact, repeated work forever
  B  framework/hosted→ fast demo; lock-in, learn the API not
                       the substrate, weaker signal, cloud bill
  ★C build aptkit    → more code + slower demo; buys reuse,
                       control, local-first, the depth-signal
  VERDICT  C — for learning + portfolio + control + local-first
  HINGE    "there's an app N+1" — proven at n=1 (buffr), not
           generalized; that's the bet under the verdict
```

**The one thing to remember:** name the cost of the branch you *took*, not just the ones you rejected — "more code I own, slower to first demo." And say the honest hinge out loud: `do nothing` wins for a single app, so the whole case for building rests on the inference that there's an app N+1, proven once (buffr) and not yet generalized.
