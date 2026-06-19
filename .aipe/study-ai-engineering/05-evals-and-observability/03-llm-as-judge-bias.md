# LLM-as-judge bias — and the rubric contract that defends against it

**Industry names:** LLM-as-judge, model-graded eval, position/verbosity/self-preference bias · *Industry standard*

## Zoom out, then zoom in

When you cross the model-in-the-loop seam from `02`, you hand grading to an LLM —
and you inherit a grader that is *itself* a biased language model. AptKit's
answer is `RubricJudge`: not "trust the model," but "constrain the model with a
contract." Here's where it sits.

```
  Zoom out — where the judge (and its contract) live

  ┌─ Eval method ladder (@aptkit/evals) ────────────────────────────┐
  │  structural-diff · detection-scorer   (deterministic, see 02)    │
  ╞══════════════ model-in-the-loop seam ═══════════════════════════╡
  │  ★ RubricJudge.judge() ★   ←── THIS CONCEPT                      │ ← we are here
  │     system prompt (rubric) + validator (the CONTRACT)            │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  generateStructured() round-trip
  ┌─ Runtime / provider ───────────▼────────────────────────────────┐
  │  model.complete() → JSON judgment, re-validated against rubric   │
  └──────────────────────────────────────────────────────────────────┘

  used inside an agent loop by:
  packages/agents/rubric-improvement/src/rubric-improvement-agent.ts
```

Zoom in: you already distrust a flaky reviewer who rubber-stamps long PRs,
prefers their own style, and is swayed by whichever option you list first. An LLM
judge has *exactly* those failure modes, with names: **verbosity bias** (rewards
length), **self-preference bias** (rewards outputs that sound like its own), and
**position bias** (favors the first/last option in a comparison). You don't fix a
biased reviewer by asking nicely — you give them a rubric, force them to justify
each score against declared criteria, and clamp what scores they're allowed to
give. That structure *is* `RubricJudge`. This file is about how the contract
neutralizes each bias, and where it still doesn't.

## Structure pass

**Layers.** Two, and the split is the whole lesson. The *content* layer (the
system prompt built from the rubric — dimensions, scales, calibration examples,
the "score meaning not style" instruction) *steers* the model. The *contract*
layer (the validator — `createRubricJudgmentValidator`) *enforces* on the way
back out. Steering is best-effort; enforcement is structural. A judge with only
steering is a suggestion; the validator is what makes the rubric binding.

**Axis — trust: how much do you trust the judge's raw output, and where do you
clamp it?** Trace it across the two layers:

```
  One axis — "how much do we trust the judge's word?"

  system prompt (steering)  →  trust it to TRY: "score meaning, not style;
                               return per-dimension {score, reason}; one fix"
  validator (enforcement)   →  trust NOTHING: score out of the rubric's
                               declared range? REJECT. verdict not in the
                               allowed set? REJECT. missing a reason? REJECT.

  trust drops to zero at the validator — that's the point
```

**Seams.** The load-bearing seam is the **validator boundary** between the
model's raw JSON and the typed `RubricJudgment` the caller receives. Trust flips
hard across it: on the model side the output is an unverified claim; on the
caller side every score is provably within its rubric scale and every verdict is
provably in the allowed set, or the parse failed. Each bias is defeated (or not)
at this seam. Study it before the prompt details.

## How it works

You know how you'd structure a code review to make it fair: a checklist (not "is
this good?"), a required comment per checklist item (no silent thumbs-up), and a
fixed verdict vocabulary (approve / request-changes, not freeform). The rubric
judge is that, made machine-enforceable. Walk the contract one defense at a time.

### Move 1 — the mental model

The judge is a model call wrapped in a contract that constrains both what it's
asked and what it's allowed to return.

```
  RubricJudge — steer in, enforce out

  rubric ──► buildRubricJudgeSystemPrompt ──┐
             (dimensions+scales,             │  steering layer
              calibration anchors,           │
              "score meaning not style")     ▼
                                    model.complete() ──► raw JSON
                                                            │
  rubric ──► createRubricJudgmentValidator ──────────────► │  contract layer
             clamp score to scale range                     ▼
             verdict ∈ allowed set                  validate → REJECT or
             per-dimension {score, reason} required          typed RubricJudgment
```

The model is free to *propose* a judgment; the rubric decides what's *admissible*.
That two-sided design — steer the proposal, enforce the admissibility — is what
turns "an LLM's opinion" into "a score on a defined scale you can put in a
report."

### Move 2 — the step-by-step walkthrough

#### Defense 1 — verbosity bias, beaten by per-dimension {score, reason}

A naive judge asked "rate this 1-5" rewards length: more words *look* like more
substance. The rubric contract refuses a bare number. Every dimension must come
back as `{score, reason}`, and the score must sit on a *declared scale* whose
levels describe *what the score means* — not how long the answer is.

```
  Verbosity defense — force justification against a meaning-scale

  naive:    judge → "4/5"          ← length sneaks in as quality
  rubric:   judge → { grounding: { score: 4, reason: "cites the
                       checkout-funnel metric and the W10 baseline" } }
                          │
                          └─ score MUST map to a scale LEVEL whose
                             description is about EVIDENCE, and the
                             reason must point at that evidence
```

Because each dimension's scale levels are spelled out in the system prompt
(`score = description`), and the model must write a `reason` that the validator
requires to be a non-empty string, a verbose-but-empty answer has nowhere to
hide: there's no evidence to cite, so the reason is hollow and the dimension that
measures grounding scores low. The boundary condition: the *quality* of bias
defense here depends on the rubric author writing dimensions about substance.
The contract enforces "you must justify per dimension"; it can't enforce "your
dimensions measure the right things." Garbage rubric, garbage judge.

#### Defense 2 — self-preference + style bias, beaten by the prompt instruction

LLM judges prefer outputs that sound like their own generation — and prefer
polished prose over plain correctness. The system prompt attacks this head-on
with two explicit instructions: score *meaning and evidence, not style* (unless
the rubric asks for style), and *never rewrite the subject — return one
highest-leverage fix*.

```
  Self-preference / style defense — explicit prompt clamps

  "Score meaning and evidence, not style preferences
   unless the rubric asks for style."   ← detaches score from polish
  "Never rewrite the subject. Return one
   highest-leverage fix, not a list."   ← stops the judge re-authoring
                                           the answer into its own voice
```

The "never rewrite" instruction is subtle and load-bearing: a judge that rewrites
the subject implicitly scores against *its own rewrite* (peak self-preference). By
forbidding the rewrite and demanding a single fix, the contract keeps the judge in
the grader's chair instead of the author's. The boundary condition: this is the
*steering* layer — it's an instruction, not an enforcement. A model can ignore it.
That's why it's paired with the structural defenses below; instruction alone isn't
trustworthy.

#### Defense 3 — scale drift, beaten by the validator clamp

Even told the scale is 1-5, a model will return 7, or 0.5, or "high". The
validator computes the min and max of each dimension's declared scale and
*rejects* any score outside that range. The judgment doesn't get clamped to the
nearest valid value — it fails validation, which (through `generateStructured`)
triggers a re-ask. An out-of-range score is treated as a malformed response, not
a creative one.

```
  Scale-clamp defense — reject, don't coerce

  rubric dimension "grounding" scale = [1,2,3,4,5]
        │ validator precomputes  min=1, max=5
        ▼
  model returns grounding.score = 7
        │
        ▼  7 < 1 || 7 > 5  →  { ok:false,
                                error:"dimensions.grounding.score must be
                                       between 1 and 5" }
        │
        └─ parse FAILS → re-ask. The judge cannot invent a scale.
```

This is the single most important structural defense: it makes the *scale* a
hard constraint rather than a polite request. Without it, "score 1-5" is a
suggestion and your aggregate scores are meaningless. The boundary condition: the
clamp only works because the scale is *declared in the rubric* — the validator
derives the range from `dimension.scale`, so a rubric with a sloppy scale gets a
sloppy clamp.

#### Defense 4 — verdict drift, beaten by the allowlist

The same logic for the categorical verdict: the model must return one of the
rubric's declared verdict strings. "mostly pass", "B+", "looks good" — all
rejected. The verdict is constrained to a closed set, so downstream code can
switch on it safely.

```
  Verdict-allowlist defense

  rubric verdicts = { "pass", "revise", "fail" }
        │ validator builds a Set
        ▼
  model returns verdict = "mostly pass"
        │
        ▼  !verdicts.has("mostly pass")  → REJECT
        │
        └─ the verdict vocabulary is closed; no freeform grades leak through
```

#### Defense 5 — scale anchoring, via calibration examples

The remaining problem: even a 1-5 scale means different things to different
graders (one judge's 3 is another's 5). The rubric carries optional
`calibrationExamples` — input/expected pairs the prompt injects to *anchor* the
scale, with the explicit instruction "use these only to anchor the scoring scale;
do not repeat them." This is how you reduce variance between runs: pin the scale
to concrete reference points.

```
  Calibration-anchor defense — pin the scale to references

  rubric.calibrationExamples = [{ input: "<weak answer>",
                                  expected: "<scores ~2, here's why>" }, …]
        │ injected into the system prompt
        ▼
  judge now scores RELATIVE to anchors, not its private notion of "3"
        │
        └─ instruction: "anchor only; do not repeat" — anchors calibrate,
           they don't become output the judge parrots
```

#### The bias AptKit does NOT defend against — position bias

Honest gap. **Position bias** — favoring whichever option appears first/last — is
defeated by *randomizing or swapping order* across runs (the swap-and-agree trick
from `02`'s pairwise exercise). `RubricJudge` scores a *single* subject, so there's
no A/B order to randomize *within* the judge. But the moment you use it
comparatively — judge A, judge B, compare scores — order effects re-enter and
AptKit does nothing about them: no randomized presentation, no swap-and-agree.
Don't claim position-bias robustness you don't have. Case A builds the defense.

```
  Position bias — present but UNGUARDED

  single-subject judge:  no A/B order exists → bias N/A
  comparative use:       judge(A) vs judge(B) → order effects re-enter
                         AptKit: no swap, no randomization → UNDEFENDED
```

### Move 2.5 — the judge inside an agent loop

`RubricJudge` is a primitive; the **rubric-improvement agent** wires it into a
bounded agent loop (the same `runAgentLoop` from
[../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md)).
The agent can call tools to fetch recent judgments and pattern history, then
produces a structured improvement (judgment + weakest dimension + one next
action) validated by the *same rubric contract*.

```
  Judge as a primitive vs judge inside an agent loop

  primitive:  RubricJudge.judge(subject) ──► one judgment
  agent:      runAgentLoop( tools: get_recent_judgments, …,
                            maxTurns: 6, maxToolCalls: 3,
                            parseResult: validateRubricImprovementResult )
                 │  the loop gathers evidence, then emits a judgment
                 └─ validated by the SAME rubric contract → bias defenses
                    apply inside the loop too
```

The takeaway: the contract isn't bolted to one call site. Whether the judge runs
standalone or as the brain of an agent loop, the *same* validator clamps the
scores. The defense travels with the rubric, not the caller.

### Move 3 — the principle

An LLM judge's reliability comes from the *constraints you put around it*, not
from the model's good intentions. Steering (the prompt) is best-effort and a
model can ignore it; enforcement (the validator) is structural and a model
cannot. Every bias you actually beat is beaten by a constraint that *rejects* a
biased output, not one that *asks* for an unbiased one. If you can't point at the
line of code that rejects the bias, you haven't defended against it — you've
hoped.

## Primary diagram

The full judge with every bias and its defense marked at the layer it lives in.

```
  RubricJudge — biases and where each is defended

  ┌─ STEERING (system prompt, best-effort) ─────────────────────────┐
  │  dimensions + meaning-scales   → verbosity: must justify         │
  │  "score meaning, not style"    → self-preference / style         │
  │  "never rewrite; one fix"      → self-preference (no re-author)  │
  │  calibrationExamples           → scale anchoring (variance)      │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  model.complete() → raw JSON
  ┌─ ENFORCEMENT (validator, structural) ──▼────────────────────────┐
  │  score ∈ [scale.min, scale.max]  → scale drift: REJECT          │
  │  verdict ∈ allowed set           → verdict drift: REJECT        │
  │  per-dimension {score, reason}   → verbosity: REJECT if missing │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  pass → typed RubricJudgment
  ┌─ UNDEFENDED ──────────────────▼────────────────────────────────┐
  │  position bias — no order randomization (single subject; and    │
  │  comparative use is unguarded). Honest gap → Case A.            │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** `RubricJudge` scores any text subject against a declared rubric —
e.g. judging the quality of a generated answer or a coaching response. It is the
grading primitive behind the rubric-improvement agent
(`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts`), which uses
the same validator (`validateRubricImprovementResult`) so a judgment produced
inside the agent loop is held to the identical contract.

**The scale-clamp + verdict-allowlist enforcement**,
`packages/evals/src/rubric-judge.ts:175-203`:

```
  packages/evals/src/rubric-judge.ts  (lines 175-203)

  const scoreRanges = new Map(rubric.dimensions.map(d => [d.id, {
    min: Math.min(...d.scale.map(l => l.score)),    ← derive range from
    max: Math.max(...d.scale.map(l => l.score)),       the DECLARED scale
  }]));
  …
  for (const id of dimensionIds) {
    const score = value.dimensions[id];
    if (typeof score.score !== 'number')             ← verbosity defense:
      return { ok:false, error:`dimensions.${id}.score must be a number` };
    if (typeof score.reason !== 'string')            ← must JUSTIFY
      return { ok:false, error:`dimensions.${id}.reason must be a string` };
    const range = scoreRanges.get(id);
    if (range && (score.score < range.min || score.score > range.max))
      return { ok:false,                             ← scale-clamp defense:
        error:`dimensions.${id}.score must be between ${range.min} and ${range.max}` };
  }
  if (typeof value.verdict !== 'string' || !verdicts.has(value.verdict))
    return { ok:false, error:'judgment.verdict is not allowed by the rubric' };
       │                                             ← verdict-allowlist defense
       └─ every defense here REJECTS, never coerces. A rejected judgment
          fails validation → generateStructured re-asks. Bias = malformed.
```

**The steering instructions + calibration anchor**,
`packages/evals/src/rubric-judge.ts:125-148`:

```
  packages/evals/src/rubric-judge.ts  (lines 125-148)

  const examples = rubric.calibrationExamples?.length
    ? `\nCalibration examples. Use these only to anchor the scoring scale;
       do not repeat them.\n…`                       ← scale-anchoring defense
    : '';
  …
  'Score the subject against the rubric. Score meaning and evidence,
   not style preferences unless the rubric asks for style.',   ← style defense
  'Never rewrite the subject. Return one highest-leverage fix, not a list.',
       │                                             ← self-preference defense
       └─ these are STEERING — they shape the proposal but can't enforce it.
          They're paired with the validator above, which can.
```

**The judge inside the agent loop**,
`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:66-90`: the
agent runs `runAgentLoop` with `maxTurns: 6, maxToolCalls: 3` and
`parseResult: (text) => parseImprovementResult(text, validate)`, where `validate`
is `validateRubricImprovementResult(this.rubric)` — the same rubric contract,
enforced on the loop's final answer.

## Elaborate

LLM-as-judge entered practice with MT-Bench and the Chatbot Arena work (Zheng et
al., 2023), which also catalogued the bias trio: position, verbosity, and
self-preference. The field's standard mitigations are: a *rubric* (score against
criteria, not vibes), *reference-guided* grading (anchor with examples —
AptKit's `calibrationExamples`), *forced rationale* (justify each score — AptKit's
required `reason`), and *order swapping* for pairwise (the one AptKit lacks).
AptKit's distinctive move is making the rubric a *validated contract* rather than
prose guidance: the scale and verdict aren't suggestions in the prompt, they're
ranges and sets the validator enforces. That's the difference between "we asked
the model to use a 1-5 scale" and "a score outside 1-5 is structurally a parse
failure."

The deeper point connects to `02`'s seam: the moment you grade with a model, your
grader is fallible in the same ways the thing it grades is. The defense is to
shrink the surface where the model's judgment is *trusted* — clamp the range,
close the verdict set, force a reason — so the only thing left to trust is the
relative ordering within a tightly constrained space.

Adjacent: the seam this lives above ([02-eval-methods.md](02-eval-methods.md)); the
agent loop it runs inside
([../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md));
the observability that traces a judge call
([04-llm-observability.md](04-llm-observability.md)); eval-driven prompt iteration
that uses judge scores as the signal
([../../study-prompt-engineering/05-eval-driven-iteration.md](../../study-prompt-engineering/05-eval-driven-iteration.md)).

## Project exercises

*Provenance: Phase 5 — Evals and observability (C5.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. Case A — the contract exists; position-bias
defense does not.*

### Exercise — position-bias defense via swap-and-agree

- **Exercise ID:** `[C5.5]` Phase 5, llm-as-judge-bias concept, Case A (extend)
- **What to build:** A comparative wrapper around `RubricJudge` that, given two
  subjects, judges them in *both* orders (A-then-B and B-then-A) and only declares
  a winner if the higher-scoring subject is the same in both orderings; otherwise
  returns `tie` with a `positionSensitive: true` flag. This is the order-swap
  mitigation AptKit lacks.
- **Why it earns its place:** Position bias is the one bias in the standard trio
  AptKit does not defend against. Building swap-and-agree shows you know the bias
  exists, know the canonical fix, and can detect when a judge's preference is an
  artifact of ordering rather than quality.
- **Files to touch:** `packages/evals/src/rubric-judge.ts` (add
  `compareWithRubric`), `packages/evals/src/index.ts`,
  `packages/evals/test/rubric-judge.test.ts` (fixture provider returning
  order-dependent scores to prove the `tie` path).
- **Done when:** A test where the fixture judge prefers whichever subject is
  listed first yields `tie` / `positionSensitive: true`, and an order-stable
  fixture yields a stable winner.
- **Estimated effort:** `1-4hr`

### Exercise — calibration-drift detection

- **Exercise ID:** `[C5.6]` Phase 5, llm-as-judge-bias concept
- **What to build:** A test harness that runs the judge over its own
  `calibrationExamples` and asserts the returned score lands within tolerance of
  each example's `expected` score — a self-check that the judge is actually
  calibrated to its anchors.
- **Why it earns its place:** Calibration examples are injected but never
  verified to *work*. Closing that loop turns the anchors from a hope into a
  checked invariant and surfaces a miscalibrated rubric before it scores real
  outputs.
- **Files to touch:** `packages/evals/src/rubric-judge.ts` (a
  `assertCalibrated(rubric, model)` helper), `packages/evals/test/rubric-judge.test.ts`.
- **Done when:** A rubric whose fixture judge scores its anchors correctly passes;
  one whose judge scores an anchor outside tolerance fails with the offending
  dimension named.
- **Estimated effort:** `1-4hr`

## Interview defense

**Q: Your LLM judge gives higher scores to longer answers. How do you stop that?**

```
  naive: "rate 1-5"  → length leaks in as quality
  rubric: per dimension → { score, reason }   ← must justify
          score ∈ declared meaning-scale       ← validator clamps
          "score meaning, not style"           ← prompt detaches polish
```

"Verbosity bias. I beat it structurally, not by asking. The rubric forces a
`{score, reason}` per dimension and the validator rejects a missing reason
(`rubric-judge.ts:193`), so a long-but-empty answer has no evidence to cite and
the grounding dimension scores low. The score must land on a *meaning-scale* the
validator clamps to (`:196`), and the prompt says score evidence not style
(`:147`). Length has nowhere to turn into points."
*Anchor: every bias defense is a rejection in the validator, not a polite request.*

**Q: Does your judge have position bias?**

```
  single subject  → no A/B order → bias N/A
  comparative use → judge(A) vs judge(B) → order re-enters → UNGUARDED
  fix not present: swap-and-agree / order randomization
```

"`RubricJudge` scores one subject, so there's no order to bias *within* a call.
But the moment you use it comparatively — score A, score B, compare — position
effects re-enter, and AptKit does nothing about them: no swap, no randomization.
The standard fix is swap-and-agree — judge both orders and only trust a verdict
that survives the swap. That's an honest gap I'd close before relying on
comparative scores."
*Anchor: name the gap precisely — single-subject is safe, comparative isn't.*

## Validate

- **Reconstruct:** From memory, list the four *structural* defenses the validator
  enforces (number score, required reason, scale clamp, verdict allowlist) and the
  two *steering* defenses in the prompt (score-meaning-not-style, never-rewrite).
  Check against `packages/evals/src/rubric-judge.ts:185-203` and `:147-148`.
- **Explain:** Why does the validator *reject* an out-of-range score
  (`rubric-judge.ts:196`) instead of clamping it to the nearest valid value?
  (Clamping would silently fabricate a score the model didn't mean; rejection
  treats it as a malformed response and re-asks, keeping the score honest.)
- **Apply:** A rubric author writes a `grounding` dimension whose scale levels all
  say "well-written." The judge now rewards polish. Did the contract fail?
  (No — the contract enforces "justify per dimension on the declared scale"; it
  cannot enforce that the *dimension measures the right thing*. Garbage rubric,
  garbage judge. The defense is upstream, in rubric authoring.) See the scale
  construction at `rubric-judge.ts:108-115`.
- **Defend:** Why is the steering layer ("score meaning, not style") not enough on
  its own? (It's a prompt instruction a model can ignore; only the validator
  *structurally* prevents an inadmissible score. Steering shapes the proposal,
  enforcement guarantees the result — you need both, and only enforcement is
  trustworthy.) Contrast `rubric-judge.ts:147` (steering) with `:196` (enforcement).

## See also

- [02-eval-methods.md](02-eval-methods.md) — the seam this judge sits above
- [01-eval-set-types.md](01-eval-set-types.md) — the sets a judge scores
- [04-llm-observability.md](04-llm-observability.md) — tracing a judge call
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the loop the rubric-improvement agent runs the judge inside
- [../../study-prompt-engineering/05-eval-driven-iteration.md](../../study-prompt-engineering/05-eval-driven-iteration.md) — using judge scores to iterate prompts
