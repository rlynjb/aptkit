# 10 — Self-critique and self-consistency

**Industry name:** self-critique / self-consistency / reflexion — *Industry standard*

## Zoom out, then zoom in

Two reliability techniques that cost 2–5x tokens for one extra step of trust:
*self-critique* (ask the model to evaluate its own output, then revise) and
*self-consistency* (run the same prompt N times, vote on the answer). They earn
their cost on high-stakes outputs you can't cheaply review by hand. The honest
truth I've learned: a model critiquing its own output has the same blind spots
that produced the output, so self-critique has real diminishing returns — and in
this repo, **neither is wired into any agent.** What the repo *does* have is the
adjacent, stronger pattern: an *independent* judge (a different model) scoring
output.

```
  Zoom out — self-critique vs the judge that exists

  ┌─ Self-critique / self-consistency (NOT in repo) ──────────┐
  │  generate → SAME model critiques → revise                 │ ← we are here
  │  OR generate N times → vote                                │   (not yet exercised)
  └───────────────────────────┬────────────────────────────────┘
  ┌─ What IS shipped: independent judge ─▼─────────────────────┐
  │  evals/rubric-judge.ts — a DIFFERENT model (Claude)        │
  │     scores another model's output against a rubric         │
  │  generateStructured retry — a weak form of self-correction │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the rubric judge is the cross-model cousin of self-critique, and it's
better precisely *because* the judge isn't the author — it doesn't share the
author's blind spots. The retry loop in `generateStructured` is the one place a
model is given a chance to "fix itself," but only against a schema, not a quality
judgment.

## The structure pass

**Layers:** the generator (produces output) → the critic (evaluates) → the
reviser/voter (acts on the critique).

**Axis — is the critic the *same* model as the author?** This axis is the whole
lesson:

```
  Axis: "does the critic share the author's blind spots?"

  ┌─ Self-critique (same model) ─┐  seam  ┌─ Independent judge (diff model) ─┐
  │ author critiques itself      │ ══╪══► │ Claude judges Gemma's output     │
  │ → SAME blind spots ⚠         │ flips  │ → DIFFERENT blind spots ✓        │
  │ → diminishing returns        │        │ → rubric-judge.ts (SHIPPED)      │
  └──────────────────────────────┘        └───────────────────────────────────┘
```

**Seam:** the critic/author identity boundary. When the critic is the author
(self-critique), the seam is weak — the model that missed an error is unlikely to
catch it on review. When the critic is a different model (the rubric judge), the
seam is load-bearing — the judge sees what the author missed. **This is why the
repo invested in the judge and not in self-critique.**

## How it works

### Move 1 — the mental model

You already know the value of a second reviewer on a PR: the author is blind to
their own mistakes, so a *different* person catches them. Self-critique is asking
the author to review their own PR — better than nothing, but it misses what they
already missed. Self-consistency is rolling the dice N times and taking the
majority — it averages out the unlucky single roll. An independent judge is the
real second reviewer.

```
  Pattern — three reliability strategies

  self-critique:   gen ──► critique(SAME model) ──► revise     (weak: shared blind spots)
  self-consistency: gen×N ──► vote ──► answer                  (costly: N× tokens)
  independent judge: gen ──► judge(DIFFERENT model) ──► score  (strong: SHIPPED here)
```

### Move 2 — walking what exists and what doesn't

**What's shipped — the independent judge.** `RubricJudge.judge`
(`rubric-judge.ts:89`) takes a *subject* (some other model's output) and scores
it against a rubric using `generateStructured`. The judging instruction
(`:146`): *"Score meaning and evidence, not style preferences"* and *"Return one
highest-leverage fix, not a list."* This is critique done by a separate model —
the strong form. **Why it beats self-critique:** Claude judging Gemma doesn't
inherit Gemma's failure modes.

**What's shipped — the schema retry (weak self-correction).** `generateStructured`
(`structured-generation.ts:62`) gives the model a second attempt with a stricter
nudge on parse/validation failure. This is *self-correction*, but only against an
objective contract (valid JSON), not a subjective quality judgment. The model
isn't asked "is this good?" — it's told "that wasn't valid, try again." That
narrow scope is exactly why it works: there's no shared-blind-spot problem when
the failure is mechanically checkable.

**What's NOT shipped — self-critique and self-consistency.** No agent in this
repo runs a "critique your own answer and revise" turn, and none runs the same
prompt N times to vote. The recommendation agent — which the spec flags as a
high-stakes candidate (edits/actions a human acts on) — currently relies on the
prompt's hard rules and the validator, not a critique pass. This is `not yet
exercised`. **Where it would go:** a high-stakes generation chain
(recommendations) is the textbook place — generate, have an independent judge
score it (the rubric judge already exists), and gate or revise on a low score.

### Move 2.5 — current state vs future state

```
  Comparison — reliability passes: shipped vs gap

  NOW (shipped)                        │  GAP (not yet exercised)
  ───────────────────────────────────  │  ──────────────────────────────────
  rubric-judge: independent judge      │  no self-critique turn in any agent
    (Claude scores Gemma) — eval-time  │  no self-consistency (N-sample vote)
  generateStructured: schema retry     │  no inline critique→revise loop
    (objective self-correction only)   │  judge runs at EVAL time, not
                                       │    inline as a runtime gate
```

The takeaway: the strong primitive (independent judge) already exists and runs at
eval time. Promoting it to a *runtime* gate on a high-stakes chain is a
composition of existing parts — wire `RubricJudge` into the recommendation
agent's output path — not new infrastructure. That's the cheap path to
reliability here, and it sidesteps the diminishing-returns problem of true
self-critique by using a different model as the critic.

### Move 3 — the principle

**The value of a critique is proportional to how different the critic's blind
spots are from the author's.** Self-critique is cheap but shares blind spots;
self-consistency averages out variance at N× cost; an independent judge is the
strongest because it doesn't inherit the author's failure modes. This repo bet on
the judge — correctly — and the open move is to run it inline on the outputs that
are too expensive to get wrong.

## Primary diagram

```
  Self-critique landscape — what this repo has and lacks

  GENERATE (any agent, e.g. recommendation)
        │
        ├─► schema retry (structured-generation.ts:62)   [SHIPPED]
        │     objective: "not valid JSON, try again"
        │     no shared-blind-spot problem (mechanical check)
        │
        ├─► independent judge (rubric-judge.ts:89)        [SHIPPED, eval-time]
        │     Claude scores Gemma's output, calibrated rubric
        │     strong: different model, different blind spots
        │
        ├─► self-critique turn (same model revises)       [not yet exercised]
        │     weak: shared blind spots, diminishing returns
        │
        └─► self-consistency (N samples → vote)           [not yet exercised]
              costly: N× tokens, averages variance
```

## Elaborate

The techniques: *self-consistency* (Wang et al.) samples multiple reasoning paths
and takes the majority answer — it helps most when the task has a single
verifiable answer and the model's errors are uncorrelated across samples.
*Reflexion / self-critique* (Shinn et al., Madaan et al.) has the model critique
and revise — the documented caveat is exactly the shared-blind-spot problem: gains
are real but bounded, and they collapse when the model's critique is as wrong as
its answer. The production reconciliation, which this repo half-implements, is to
make the critic a *different* model (LLM-as-judge, concept 05) so the critique
adds genuinely new information. The cost discipline: every one of these multiplies
your token spend (concept 04), so reserve them for outputs where a wrong answer is
expensive and hard to catch by hand.

## Interview defense

**Q: When is self-critique worth the cost, and what's its weakness?** Worth it on
high-stakes outputs too expensive to review by hand — but its weakness is that
the model critiquing itself shares the blind spots that produced the error, so
returns diminish. The stronger move is an *independent* judge (a different model),
which this repo ships as the rubric judge; self-critique itself is not yet wired.

```
  same-model critique → shared blind spots (weak)
  different-model judge → new information (strong) ← rubric-judge.ts
```
*Anchor: `RubricJudge.judge` (`rubric-judge.ts:89`); schema retry as objective
self-correction (`structured-generation.ts:62`).*

**Q: The part people forget?** That **self-critique and an independent judge are
not the same technique**. People say "add a critique step" and reach for the same
model, getting little. The leverage is in the critic being *different* — and the
cheap path here is promoting the existing rubric judge from eval-time to a
runtime gate on the recommendation chain.

## See also

- `05-eval-driven-iteration.md` — the rubric judge as an eval-time scorer.
- `02-structured-outputs.md` — the schema retry as objective self-correction.
- `04-token-budgeting.md` — every reliability pass multiplies token cost.
- `06-single-purpose-chains.md` — the recommendation chain is the high-stakes candidate.
