# Reflexion / Self-Critique Loop

**Industry term:** reflexion / self-critique (the agent evaluates its own output and retries). *Industry standard.*

## Zoom out, then zoom in

A loop where the agent grades its own draft and revises. aptkit has one thing in this family — `rubric-improvement` — but it's pointed at an *external* subject, not the agent's own output. That distinction is the whole lesson here.

```
  Zoom out — the closest aptkit gets

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  rubric-improvement: an agentic IMPROVEMENT loop over a       │ ← we are here
  │  scored subject — reflexion-shaped, but aimed outward         │
  └───────────────────────────────┬──────────────────────────────┘
                                   │ runAgentLoop (maxTurns 6, maxToolCalls 3)
  ┌─ Runtime layer ─────────────────▼───────────────────────────┐
  │  the agent loop skeleton                                      │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: textbook reflexion has the agent critique *its own answer*. aptkit's `rubric-improvement` (`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts`) scores a *subject* against a rubric, finds the weakest dimension, and proposes a next action. It's a critique loop, but the thing being critiqued is external. aptkit has no loop where an agent re-critiques and revises its *own* output.

## The structure pass

**Layers.** A base pattern (ReAct produces a draft) and a critic layer on top (grade, then revise-or-return).

**Axis: failure containment — what kind of error does self-critique catch?** It catches format and obvious errors well; it catches subtle reasoning errors poorly, because the critic shares the producer's blind spots.

**The seam.** The critic step. It either approves (return) or rejects (revise and loop). The cap on retries is load-bearing — without it, a stubborn critic loops forever.

## How it works

**Use case in aptkit:** `rubric-improvement`. It's the only agent with a "judge then act" shape. The mechanics below cover both the textbook reflexion loop and how aptkit's external-subject version differs.

### Move 1 — the mental model

It's a code reviewer pass on your own PR before you request review — except the reviewer is the same model that wrote the code. Useful for catching typos and obvious bugs; weak at catching the design flaw you couldn't see when you wrote it.

```
  ┌──────────────────────────────────────────────┐
  │  base pattern (ReAct) produces a draft answer  │
  └────────────────────┬───────────────────────────┘
                       ▼
  ┌──────────────────────────────────────────────┐
  │  Critic step: "is this correct / complete?"    │
  └────────────────────┬───────────────────────────┘
              ┌─────────┴─────────┐
              ▼ good              ▼ flawed
          return            revise + loop
                            (cap the retries)
```

### Move 2 — the walkthrough

**aptkit's external-subject critique.** `rubric-improvement` scores a subject against a `RubricDefinition`, then emits a judgment plus a next action:

```ts
// rubric-improvement-agent.ts:66 — the improvement loop
const { parsed } = await runAgentLoop({
  capabilityId: RUBRIC_IMPROVEMENT_CAPABILITY_ID,
  system,                          // "score the subject, find the weakest dimension"
  userPrompt: buildRubricImprovementUserPrompt(input),
  maxTurns: 6, maxToolCalls: 3,
  parseResult: (text) => parseImprovementResult(text, validate),
  recoveryPrompt: (completedToolCalls) => [ /* re-emit valid JSON */ ],
});
```

The critique is of the *subject*, not the agent's prior answer. There's no "the agent revises its own output and re-grades" cycle — it grades once and recommends. That's a single-pass judge, not iterative reflexion.

**The recovery turn is NOT reflexion.** `runAgentLoop`'s recovery path (`run-agent-loop.ts:204`) re-runs the model when the output doesn't *parse*. That's a format-validity retry, not a quality self-critique — it doesn't ask "is this answer good," it asks "is this valid JSON." Don't conflate the two in an interview.

**The hard limit if aptkit added true reflexion.** A model critiquing its own output shares the blind spots that produced it. Self-critique catches format and obvious errors; it catches subtle-reasoning failures poorly. And it costs 2-5x tokens for one extra reliability step. For a weak local model like Gemma, the critic is as likely to approve a wrong answer as catch it — which is partly why aptkit leans on *structural* validators (`validate.ts`) instead of model self-critique.

### Move 3 — the principle

Self-critique is a reliability step you pay 2-5x tokens for, and it only helps where the model can actually see its own error. aptkit's choice — structural validators plus a parse-recovery turn, not model self-critique — is the right call for a weak local model whose self-critique would be unreliable.

## Primary diagram

```
  Reflexion (textbook) vs aptkit's rubric-improvement

  textbook reflexion:   draft ─► self-critique ─► revise ─► re-grade ─┐
                          ▲                                           │
                          └────────── loop (capped) ──────────────────┘

  aptkit rubric-improvement:  subject ─► grade once ─► next action
                              (external subject, single pass; the
                               recovery turn is parse-validity, not critique)
```

## Elaborate

Reflexion (Shinn et al., 2023) added a verbal self-reflection step that let an agent learn from failed attempts within a task. It works best when failures are *checkable* — a test fails, a format is wrong — and worst when the failure is a subtle reasoning error the same model can't detect. For high-stakes outputs, the production fix is a *different* model family as the critic (covered in `03-multi-agent-orchestration/05-debate-verifier-critic.md`), which breaks the shared-blind-spot problem.

## Interview defense

**Q: Does aptkit do self-critique?**

Not on the agent's own output. `rubric-improvement` is a critique loop, but it grades an external subject, not its own answer. And the loop's recovery turn is a parse-validity retry, not a quality self-critique. For a weak local model, structural validators plus a parse-recovery turn beat unreliable model self-critique.

```
  rubric-improvement: grade SUBJECT (external)  ≠  reflexion on SELF
  recovery turn: "is this valid JSON?"          ≠  "is this answer good?"
```

*Anchor: name the shared-blind-spot limit — a model critiquing itself shares the errors that produced the output.*

## See also

- [03-react.md](03-react.md) — the base pattern reflexion sits on.
- [../03-multi-agent-orchestration/05-debate-verifier-critic.md](../03-multi-agent-orchestration/05-debate-verifier-critic.md) — the multi-agent fix for shared blind spots.
- Prompt-level self-critique mechanics: `.aipe/study-prompt-engineering/`.
