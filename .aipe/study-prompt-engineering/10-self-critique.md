# 10 — Self-critique and self-consistency

**Subtitle:** self-critique / self-consistency — spend tokens to buy
reliability (Industry standard)

## Zoom out, then zoom in

Two reliability patterns that trade tokens for confidence. Self-critique:
ask the model to evaluate its own output and revise. Self-consistency: run
the same prompt N times and vote. Both cost 2–5x the token budget for one
extra step of reliability. aptkit has the *judge half* of self-critique
built — but as a separate eval model, not an in-loop self-review. The in-loop
revise step is a curriculum target.

```
  Zoom out — the critique machinery exists, but as an external judge

  ┌─ Generation ────────────────────────────────────────────────┐
  │  agent loop → output (one pass, no in-loop self-review)      │
  └───────────────────────────┬──────────────────────────────────┘
                              │ output → artifact
  ┌─ ★ Critique (external, eval-time) ★ ─────────────────────────┐
  │  ★ RubricJudge: Claude critiques Gemma's output ★            │ ← we are here
  │     scores + ONE highest-leverage fix                        │
  │  in-loop "revise based on the critique" → NOT YET EXERCISED  │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: self-critique is a two-step prompt — generate, then grade your
own work and fix it. Self-consistency is sampling the same question multiple
times and taking the majority answer. The honest aptkit status: it has the
critique *prompt* (the rubric judge produces a verdict and a fix), but the
loop doesn't yet feed that fix back for a revision, and there's no
N-sample voting. The pieces are there; the self-improving loop is the build
target.

## Structure pass

**Layers.** Generation (produces output) → critique (grades it) → revision
(applies the fix — the missing rung).

**Axis — does the critique feed back into the output?** Trace it:

```
  Axis: "is the critique's fix applied to produce a better answer?"

  RubricJudge produces a "fix"   → YES, it emits one              ✓
  the agent loop consumes it     → NO  (eval-time only)           ✗
  N-sample self-consistency vote → NO  (single pass)              ✗
  the structured-gen RETRY       → a cousin: re-prompt on FAILURE ◐
```

**Seam.** The load-bearing boundary is between *critique* and *revision*.
aptkit builds right up to it — the judge emits a `fix` string — but the loop
back from fix to a revised generation is not wired. That open seam is exactly
where the curriculum exercise lands.

## How it works

You know how a good code review ends with one actionable comment, and the
author then revises and re-submits? Self-critique is that loop run by the
model on itself. aptkit has the reviewer; it's missing the
revise-and-resubmit. Let's walk what exists and what's the build.

### Step 1 — the critique exists, and it's disciplined

The rubric judge is a critique engine. Its prompt is built to produce *one*
actionable fix, not a vague vibe:

```ts
// packages/evals/src/rubric-judge.ts:147
'Score the subject against the rubric. Score meaning and evidence, not style ...',
'Never rewrite the subject. Return one highest-leverage fix, not a list.',
```

```ts
// packages/evals/src/rubric-judge.ts:46
export type RubricJudgment = {
  dimensions: Record<string, RubricDimensionScore>;
  verdict: string;
  fix: string;          // ← the actionable critique, exactly one
  reasoning?: string;
};
```

"One highest-leverage fix, not a list" is the production discipline — a
critique that returns ten fixes is noise; one prioritized fix is something a
revision step can act on. This is self-critique's first half done well.

### Step 2 — the missing rung: feeding the fix back

What's `not yet exercised`: a loop that takes `judgment.fix`, appends it to
the prompt, and regenerates. The closest existing mechanism is the
structured-generation retry — but it re-prompts on a *parse/validation
failure*, not on a *quality critique*:

```ts
// packages/runtime/src/structured-generation.ts:64
const messages = attempt === 1 ? baseMessages
  : appendStrictSuffix(baseMessages, strictSuffix);  // ← retry on FAILURE, not critique
```

```
  Pattern — what's built vs the self-critique loop

  BUILT (failure-retry):
    generate → parse fails → re-prompt "ONLY valid JSON" → regenerate

  SELF-CRITIQUE LOOP (not yet exercised):
    generate → JUDGE scores + fix → append fix → regenerate → re-judge
                                                   └─ until verdict=pass
```

The skeleton parts that would make it a real self-critique loop, named by
what breaks without each:

- **The critique step.** Already built (the judge). Without it there's
  nothing to revise toward.
- **The fix-feedback.** Missing. Without it the critique is observation, not
  improvement.
- **The termination bound.** Critical and missing. Without a hard cap, a
  model that can't satisfy its own critique loops forever (the same
  bounded-loop discipline as `maxTurns` in `run-agent-loop.ts:87`).
- **A different critic.** The blind-spot guard (step 4) — without it the
  critique shares the generator's blind spots.

### Step 3 — self-consistency: also not built

Self-consistency — sample the same prompt N times, vote on the answer — has
no implementation here. Every capability runs a single pass. The pattern:

```
  Self-consistency (not yet exercised in aptkit)

  prompt ──┬─► sample 1 → answer A
           ├─► sample 2 → answer A
           ├─► sample 3 → answer B
           └─► sample 4 → answer A
                          └─► majority vote → A   (3x token cost)
```

This would fit a low-trust classifier — run the intent classifier 3x and
vote — but at 3x the cost, which is why it's a deliberate choice, not a
default.

### Step 4 — the diminishing-returns trap

The honest caveat that keeps this from being a silver bullet: a model
critiquing its *own* output has the same blind spots that produced the
output. If the generator misread the question, the self-critic likely
misreads it too. That's precisely why aptkit's critique is a *different*
model — Claude judging Gemma — rather than Gemma judging itself. Crossing the
model boundary is what gives the critique independent blind spots. A
true self-critique loop on a single model buys less than it looks like it
should.

### Step 5 — when the extra cost is worth it

```
  Comparison — is 2-5x token cost worth it?

  high-stakes output (edits to a user's data) → YES, critique before commit
  low-trust classifier                        → MAYBE, self-consistency vote
  content hard to manually review at scale    → YES, automated critique gate
  cheap routine classification                → NO, single pass + eval suite
```

For aptkit, the natural place is the recommendation or diagnostic agent — the
outputs a human acts on — where a critique-then-revise pass before surfacing
the answer would catch a weak recommendation. That's the build target the
curriculum points at.

### The principle

**Self-critique and self-consistency buy reliability with tokens, but a model
critiquing itself shares its own blind spots — so cross a model boundary for
the critique, and always bound the revise loop.** aptkit has the critique
half (a disciplined judge that emits one fix) and crosses the model boundary
(Claude judges Gemma), which is the *right* design. The missing rung is
feeding the fix back into a bounded revision loop — the highest-leverage
unbuilt reliability feature here.

## Primary diagram

The built critique, the missing revision loop, the blind-spot guard.

```
  Self-critique in aptkit — built, missing, and the guard

  ┌─ Generation ────────────────────────────────────────────────┐
  │  Gemma agent → output                                        │
  └────────────────────────────┬──────────────────────────────────┘
                              │ output
  ┌─ Critique (BUILT, cross-model) ▼──────────────────────────────┐
  │  RubricJudge = Claude → { verdict, fix, reasoning }           │
  │  "one highest-leverage fix, not a list"                       │
  └────────────────────────────┬──────────────────────────────────┘
            fix ╎ NOT YET EXERCISED ╎ append fix, regenerate, re-judge
                ▼                    (bounded by a hard cap)
  ┌─ Revision ─────────────────────────────────────────────────┐
  │  (the missing rung — curriculum build target)                │
  └──────────────────────────────────────────────────────────────┘
   blind-spot guard: the critic is a DIFFERENT model than the generator
```

## Elaborate

Self-consistency (Wang et al.) and self-refine / self-critique (Madaan et
al.) are the canonical sources. The production reality both communities
converged on matches aptkit's instinct: self-critique with the *same* model
has limited headroom because the blind spots correlate, so a stronger or
different critic model is the reliable version. aptkit's Claude-judges-Gemma
setup is that pattern used at eval time; promoting it into the serving loop
is the natural extension.

The connection to evals (concept 5) is tight — the rubric judge is the same
machinery whether it runs as an offline eval or an inline critique. The
connection to bounded loops (study-agent-architecture, `runAgentLoop`'s
`maxTurns`) is the termination guard: any revise loop needs the same hard cap
the agent loop already has, or it spins.

## Interview defense

**Q: What's the catch with self-critique?**

A model critiquing its own output has the same blind spots that produced the
output — if it misread the prompt, it misreads it again when reviewing. So
self-critique on a single model has limited headroom. The reliable version
crosses a model boundary: a different (often stronger) model critiques. And
any revise-loop needs a hard termination bound, or a model that can't satisfy
its own critique spins forever.

```
  same-model self-critique → correlated blind spots → low headroom
  cross-model critique (Claude→Gemma) → independent blind spots → real gain
```

Anchor: "aptkit's `RubricJudge` is Claude critiquing Gemma — cross-model on
purpose — and it emits 'one highest-leverage fix.' The missing rung is
feeding that fix back into a bounded revision loop."

**Q: When is the 2–5x token cost of self-consistency worth it?**

High-stakes outputs a human acts on, low-trust classifiers where a vote
beats a single sample, and content too voluminous to review by hand. Not for
cheap routine work — there a single pass plus an offline eval suite is
cheaper and catches regressions. aptkit doesn't implement voting yet; the
single-pass-plus-eval path is its current bet.

Anchor: "Worth it for high-stakes or low-trust; aptkit currently does
single-pass + the replay eval suite instead of N-sample voting."

## See also

- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — the rubric
  judge as an offline eval
- [09-chain-of-thought.md](09-chain-of-thought.md) — reasoning as the input
  a critique evaluates
- [02-structured-outputs.md](02-structured-outputs.md) — the failure-retry
  that's a cousin of critique-retry
- study-agent-architecture — the bounded-loop discipline a revise loop needs
