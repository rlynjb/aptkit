# Reflexion / Self-Critique Loop

**Industry standard.** "Reflexion," "self-critique," "self-refine," "critic loop." Type label: reasoning pattern (a loop layered on a base pattern). **In this codebase: partially — the rubric-improvement agent is a self-*judging* loop, but no agent critiques and revises its own answer before returning it.** The recovery turn salvages bad output; it doesn't critique good output.

## Zoom out, then zoom in

Reflexion is: the agent produces a draft, evaluates its own output, and retries if it's flawed. aptkit's closest instance is the rubric-improvement agent — but it judges a *subject* against a rubric, it doesn't loop on its own answer. Worth seeing the distinction clearly, because it's an easy interview trap.

```
  Zoom out — the reflexion-shaped code in aptkit

  ┌─ Pattern family (SECTION A) ────────────────────────────┐
  │  ReAct → plan-execute → ★ reflexion ★ → ToT              │ ← partial here
  │  closest instance: rubric-improvement (judges a subject) │
  └───────────────────────────┬──────────────────────────────┘
                              │ and the runtime's
  ┌─ Loop layer ──────────────▼──────────────────────────────┐
  │  runRecoveryTurn (run-agent-loop.ts:204) — salvage, not   │
  │  self-critique                                            │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: what is being evaluated?** True reflexion evaluates *the agent's own answer* and loops to improve it. Trace that across aptkit's two candidates and both fall short of the canonical pattern in instructive ways:
- `rubric-improvement` evaluates an *external subject*, not its own output — it's an LLM-as-judge with a next-action, not a self-critique loop.
- `runRecoveryTurn` re-runs when parsing *failed*, not when the answer was *judged weak* — it's error recovery, not reflection.

The seam: reflexion loops on *quality*; aptkit's recovery loops on *parse-validity*. Different triggers, different patterns.

## How it works

### Move 1 — the mental model

Reflexion sits on top of a base pattern (usually ReAct): the base produces a draft, a critic step asks "is this correct/complete?", and on "flawed" it revises and loops — with a cap, because a model critiquing itself can loop forever.

```
  Reflexion — a critic loop on top of a base pattern

  ┌─ base (ReAct) produces a draft answer ──────────┐
  └────────────────────┬─────────────────────────────┘
                       ▼
  ┌─ critic: "correct? complete?" ──────────────────┐
  └─────────┬───────────────────────┬─────────────────┘
            ▼ good                  ▼ flawed
        return                  revise + loop (cap the retries)
```

### Move 2 — what aptkit actually has, and what it doesn't

**The rubric-improvement agent — a judge, not a self-critic.** It scores a subject against a rubric, finds the weakest dimension, and emits one next action. This is reflexion-*shaped* (score → identify weakness → act) but the subject is external.

```typescript
// packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:97-105
'Your job is to score the subject, identify the weakest dimension, and produce one focused next action.',
// ...output shape: { judgment, weakestDimension, nextAction, nextDrill }
```

It runs the standard loop (`maxTurns: 6, maxToolCalls: 3`, line 76-77) with tools to fetch judgment history and generate the next scenario. It's an **agentic improvement loop** over a learner's attempts — genuinely useful — but it doesn't critique and revise *its own* judgment. There's no "is my judgment wrong? re-judge" step.

**The recovery turn — salvage, not critique.** When `parseResult` returns null, the loop runs one recovery turn:

```typescript
// packages/runtime/src/run-agent-loop.ts:192-198
parsed = options.parseResult(finalText);
if (parsed === null && options.recoveryPrompt) {
  const recoveryText = await runRecoveryTurn(options, options.recoveryPrompt(toolCalls));
  parsed = recoveryText === null ? null : options.parseResult(recoveryText);
}
```

This fires on a *parse failure* (model returned prose, not JSON), reusing the evidence already gathered (`recommendation-agent.ts:103` builds the recovery prompt from completed tool calls). It's a one-shot retry for format, not a quality critique — and it caps at exactly one attempt, so no loop.

**What aptkit lacks: a self-critique-over-answer loop.** No agent does "draft the answer → ask a critic if it's grounded/complete → revise if not." The rag-query agent could: after grounding, a critic step could ask "is every claim cited?" and re-search on "no." aptkit doesn't — it trusts the first grounded answer.

**The hard limit that makes aptkit's restraint reasonable.** A model critiquing its own output shares the blind spots that produced it. Self-critique catches format and obvious-error failures well; subtle-reasoning failures poorly. The cost is 2-5x tokens for one reliability step. aptkit gets the format-failure coverage cheaply via the recovery turn (one shot, only on parse failure) without paying the full reflexion tax on every run.

### Move 3 — the principle

Reflexion buys reliability at a token multiplier, and only on the failure classes a model can see in itself. aptkit spends that budget surgically: a single recovery turn gated on parse-failure, not a critique loop on every answer. If subtle-reasoning errors became the dominant failure, the move is a critic from a *different* model family — not the same model grading itself.

## Primary diagram

```
  aptkit's two reflexion-adjacent loops vs true reflexion

  rubric-improvement (judges EXTERNAL subject):
    subject → score against rubric → weakestDimension → nextAction
    (no loop back over its own judgment)

  runRecoveryTurn (salvages on PARSE failure):
    finalText → parse → null? → ONE recovery turn → parse again
    (one shot, triggered by format not quality)

  TRUE reflexion (NOT in aptkit):
    draft → critic("grounded? complete?") → flawed? → revise → loop (capped)
```

## Elaborate

Reflexion formalized "let the model check its own work and try again." The catch the field learned: self-critique has a ceiling set by the model's own blind spots, which is why high-stakes systems use a *different* model as critic (the self-preference bias from LLM-as-judge). aptkit's rubric-improvement agent is the seed of a real reflexion system — it already has the judge and the rubric; wiring it to critique an agent's *answer* (not a learner's subject) would be the step to actual reflexion.

## Interview defense

**Q: Do your agents self-critique?**
Not over their own answers. The rubric-improvement agent is a judge — it scores an external subject against a rubric and emits a next action — but it doesn't loop on its own judgment. And the runtime has a recovery turn that re-prompts on a *parse* failure, but that's salvage, not quality critique. I deliberately don't run a critique loop on every answer because a model grading itself shares its own blind spots and costs 2-5x tokens.

```
  recovery turn: parse-fail → ONE retry (format)   ≠   reflexion: quality → loop
```
*Anchor: name the difference — aptkit loops on parse-validity, not on judged quality.*

**Q: If you needed real self-critique, how?**
A critic step from a *different* model family, gated on stakes — not the same model grading itself. My swappable provider layer makes that one config change. And I'd cap the rounds, because a self-critic with no cap loops forever.

## See also

- `02-agent-loop-skeleton.md` — `runRecoveryTurn` in the kernel
- `04-agent-evaluation.md` (SECTION D) — the rubric-judge eval, the judge mechanics
- `03-multi-agent-orchestration/05-debate-verifier-critic.md` — the multi-agent version of critique
- `study-prompt-engineering/` — the prompt-level self-critique mechanics (cross-ref)
