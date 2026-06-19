# 10 — Self-critique and self-consistency

**Industry name(s):** self-critique / reflexion / self-consistency (majority
vote). **Type:** Industry standard. **Status in this repo: not yet exercised.**

## Zoom out, then zoom in

This is a technique AptKit does not implement, named honestly. The closest thing
in the repo is the recovery turn — but that's error recovery, not self-critique.
Look at where self-critique *would* sit.

```
  Zoom out — where self-critique would live (not present)

  ┌─ Agent layer ───────────────────────────────────────────────┐
  │  produce output → [ ★ critique own output → revise ★ ]  ← gap │
  │  recommendation / diagnostic emit once, no critique pass      │
  └───────────────────────────┬──────────────────────────────────┘
                             │  closest existing: recovery turn (error, not critique)
  ┌─ Runtime layer ──────────▼──────────────────────────────────┐
  │  recoveryPrompt re-prompts on PARSE failure, not quality      │
  └───────────────────────────────────────────────────────────────┘
```

Now zoom in. Two related patterns the repo skips: **self-critique** — ask the model
to evaluate its own output and revise — and **self-consistency** — run the same
prompt N times and vote on the answer. AptKit does neither. The recovery turn
(`run-agent-loop.ts:204`) re-prompts when the output won't *parse*, which is the
unhappy-path mechanism that's nearest in shape but serves a different purpose.

## Structure pass

**Layers (of the absent pattern).** Two: the *first-pass* output (what the agent
emits today) and the *critique-and-revise* layer (a second model pass that would
grade and fix the first — absent).

**Axis — held constant: "is the output checked by a model before returning?"**

```
  One question, traced against what exists:

  ┌─ recommendation today ────┐  → NO model self-check; validated by CODE only
  ┌─ recovery turn ───────────┐  → re-prompt on PARSE fail (mechanism, not critique)
  ┌─ self-critique (absent) ──┐  → would: model grades + revises its own output
  ┌─ self-consistency (absent)┐  → would: N runs, vote on the answer
```

**Seam — the would-be critique boundary.** If built, the load-bearing seam is
"first output → judged → revised output." The repo's existing seam at the same
spot is "first output → parsed → recovered-on-fail," which flips on *parseability*,
not *quality*. That's the distinction to hold: AptKit checks structure, not the
model's own assessment of correctness.

## How it works

#### Move 1 — the mental model

You already do a second read of your own PR before requesting review — you reread,
spot a bug, fix it. Self-critique is that second read, performed by the model.
Self-consistency is the opposite shape: instead of one careful read, you ask three
reviewers and go with the majority.

```
  Two patterns — critique (depth) vs consistency (breadth)

  self-critique:    output → "find the flaw in this" → revise → final
                     (1 extra pass, deeper)

  self-consistency: prompt ──► run 1 ─┐
                    prompt ──► run 2 ─┼─► vote ─► most-common answer
                    prompt ──► run 3 ─┘
                     (N passes, broader)
```

#### Move 2 — the walkthrough

**Self-critique — evaluate then revise.** The pattern: after the model produces an
output, a second prompt asks it to critique that output against criteria, then a
third step revises based on the critique. Useful for high-stakes generation where a
single pass is too risky to ship unreviewed. **What it would catch:** a
recommendation that's plausible but ignores a prerequisite the diagnosis flagged.
**The diminishing-returns trap:** the model critiquing its own output shares the
blind spots that produced it — a confidently wrong first pass produces a
confidently wrong critique. The fix is critique against an *external* rubric, which
is exactly what the rubric judge (05) is, used as a *separate* capability rather
than self-applied.

**Self-consistency — vote across N runs.** Run the same prompt several times
(usually with non-zero temperature for diversity), collect the answers, and take
the majority. Useful for low-trust classifiers where a single sample is noisy.
**Cost:** 2–5x the token budget for one extra increment of reliability. **When it's
worth it:** outputs hard to manually review, where a wrong answer is expensive and
N samples cheaply de-noise it.

```
  Why AptKit skips both — the cost/value math today

  self-critique:    +1 model call per run, blind-spot risk → not worth it for
                    outputs already validated by code (02) and graded by evals (05)
  self-consistency: +Nx token cost; the structured outputs are deterministic-ish
                    and code-validated → voting adds little over a single validated pass
```

**What AptKit does instead.** Three substitutes cover most of what self-critique
would buy, at lower cost: code-side validation (02) rejects malformed output
deterministically; the rubric judge (05) provides external critique as a separate
graded capability; the recovery turn re-prompts on parse failure. The gap is
genuine *quality* self-revision on the happy path — but for code-validated
structured outputs, the value is low.

#### Move 3 — the principle

Self-critique and self-consistency buy reliability at a multiplied token cost, and
they're only worth it for high-stakes, hard-to-review outputs. For outputs already
gated by code-side validation and external eval, a single validated pass is the
right call — which is why AptKit skips both. The trap to remember if you ever add
self-critique: a model critiquing itself shares its own blind spots; critique
against an external rubric instead.

## Primary diagram

The two absent patterns vs the present recovery mechanism.

```
  Present vs absent — recovery is not self-critique

  PRESENT (run-agent-loop.ts):
    output → parseResult → null? → recoveryPrompt (1x) → parse again → [] 
                                      ▲
                                      └─ triggered by PARSE failure, not quality

  ABSENT (buildable):
    output → "critique this against criteria" → revise → final   (self-critique)
    prompt × N → collect → majority vote → final                 (self-consistency)
```

## Implementation in codebase

**Use cases.** None — this concept is not implemented. The honest anchor is the
recovery turn, shown to make the distinction crisp: it is the nearest-shaped
mechanism and it is *not* self-critique.

The recovery turn — re-prompt on parse failure, not on a quality self-assessment:

```
  packages/runtime/src/run-agent-loop.ts  (lines 192–217)

  if (options.parseResult) {
    parsed = options.parseResult(finalText);
    if (parsed === null && options.recoveryPrompt) {         ← triggered by PARSE fail
      const recoveryText = await runRecoveryTurn(options, options.recoveryPrompt(toolCalls));
      parsed = recoveryText === null ? null : options.parseResult(recoveryText);
    }
  }
  ...
  async function runRecoveryTurn(options, userPrompt): Promise<string | null> {
    const response = await options.model.complete({
      system: 'You are concluding a completed investigation. Output ONLY the structured answer...
               Never ask for more data.',
      messages: [{ role: 'user', content: userPrompt }], ...
    });
       │
       └─ this re-prompts because the output didn't PARSE. It never asks the model
          to judge whether its answer was CORRECT. That's the difference from
          self-critique — same shape, different trigger.
```

The external-critique substitute that already exists (the rubric judge, used as a
separate capability, NOT self-applied):

```
  packages/evals/src/rubric-judge.ts  (lines 89–104)

  judge(input, options = {}): Promise<StructuredGenerationResult<RubricJudgment>> {
    return generateStructured({ ..., validate: createRubricJudgmentValidator(this.rubric), ... });
  }
       │
       └─ this IS critique against an external rubric — the blind-spot-resistant
          form. AptKit has the building block; it just doesn't self-apply it as a
          post-generation revision loop.
```

## Project exercises

### EX-10.1 — Self-consistency vote for the intent classifier

- **What to build:** Run `classifyIntent` N=3 times (non-zero temperature) and
  return the majority `Intent`; fall back to the single-run result on a tie.
- **Why it earns its place:** The classifier is the lowest-stakes, cheapest place
  to feel self-consistency's cost/value tradeoff — 3x a 16-token call is nearly
  free, and intent noise is real.
- **Files to touch:** `packages/agents/query/src/intent.ts` (wrap `classifyIntent`),
  a new test under the query package.
- **Done when:** a deterministic `FixtureModelProvider` returning
  `[monitoring, diagnostic, monitoring]` yields `monitoring`, and a 3-way tie falls
  back cleanly.
- **Estimated effort:** half a day.

### EX-10.2 — Self-critique pass on recommendations against the rubric judge

- **What to build:** After the recommendation agent produces `Recommendation[]`,
  score each with `RubricJudge` against a recommendation-quality rubric; if any
  scores below a threshold, run one revision turn that re-injects the critique.
- **Why it earns its place:** Uses the *external* rubric (blind-spot-resistant),
  not naive self-critique — the production-correct version. Recommendations are the
  highest-stakes output (a human acts on them).
- **Files to touch:** `packages/agents/recommendation/src/recommendation-agent.ts`,
  a new rubric definition, `@aptkit/evals` import.
- **Done when:** a recommendation that fails a rubric dimension triggers exactly one
  revision turn, the cost (extra `model_usage` events) shows in the trace, and a
  passing set triggers none.
- **Estimated effort:** one to two days.

## Elaborate

The reason AptKit can skip self-critique without it being a hole: it already has
the two things self-critique is usually reached for. Code-side validation (02) is a
*deterministic* critic that never shares the model's blind spots — it rejects
malformed output every time. The rubric judge (05) is an *external-rubric* critic,
the production-grade form of critique that fights the shared-blind-spot problem the
naive version suffers. Self-critique-by-the-same-model on the happy path would add
cost and blind-spot risk for outputs that are already gated twice.

Self-consistency is a different story — it's genuinely absent and would help the
intent classifier most, where a single sample is noisy and the per-call cost is
trivial. That's the cheapest place to add it (EX-10.1). For the structured agents,
voting across N runs of a code-validated output adds little, because the validator
already removes the malformed samples voting would otherwise discard.

If you build self-critique, build the external-rubric version (EX-10.2). The
literature (Reflexion, and the self-critique sections of the Anthropic guide) is
consistent that self-critique against fixed criteria beats open-ended "find your
mistakes," precisely because of the blind-spot problem.

## Interview defense

**Q: Why doesn't this system use self-critique?**
Because it already has two better critics. Code-side validation is a deterministic
critic with no shared blind spots — it rejects malformed structured output every
time. The rubric judge is an external-rubric critic, the blind-spot-resistant form.
Naive self-critique by the same model on the happy path adds token cost and shares
the very blind spots that produced the output. For code-validated outputs, a single
validated pass is the right call.

```
  output → code validation (deterministic critic) → rubric judge (external critic)
           no shared blind spots                     blind-spot-resistant
                        ▲ both beat naive self-critique
```
Anchor: "validation at `recommendation-agent.ts:91`, external critique at
`rubric-judge.ts:89`; recovery turn (`run-agent-loop.ts:204`) is parse recovery,
not critique."

**Q: Where would self-consistency actually pay off here?**
The intent classifier. A single 16-token classification is noisy; running it 3x and
voting is nearly free and de-noises it. For the structured agents it pays little —
the validator already discards the malformed samples voting would filter.
Anchor: "`classifyIntent` at `intent.ts:12` — the cheap place to add a vote."

## Validate

- **Reconstruct:** State the difference between self-critique (depth) and
  self-consistency (breadth/vote).
- **Explain:** Why is the recovery turn (`run-agent-loop.ts:204`) NOT self-critique,
  given they look similar? What triggers each?
- **Apply:** You want to add self-consistency to the intent classifier. Sketch the
  change to `intent.ts:12` and the tie-break rule.
- **Defend:** Argue why self-critique against the rubric judge (external) is
  production-correct while self-critique by the same model (naive) is not.

## See also

- [02-structured-outputs.md](02-structured-outputs.md) — code-side validation as the deterministic critic.
- [05-eval-driven-iteration.md](05-eval-driven-iteration.md) — the rubric judge as external critique.
- [11-meta-prompting.md](11-meta-prompting.md) — the other model-evaluates-model pattern in this repo.
