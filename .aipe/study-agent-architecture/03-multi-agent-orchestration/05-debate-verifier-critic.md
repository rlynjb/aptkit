# 05 — Debate / Verifier-Critic

> A producer agent makes something; a critic agent independently judges it; they
> iterate until the critic is satisfied. The quality topology. AptKit's
> rubric-improvement agent looks like this but isn't — it's *single-agent
> self-critique*. The difference is the whole lesson.

## Zoom out

The producer/critic split exists for one reason: an agent grading its own work
is a conflicted judge. Generation and verification are different skills, and
worse, a model tends to *agree with itself* — it shares its own blind spots. So
you put the judging in a separate agent (ideally a different model family) whose
only job is to find what's wrong. The producer revises; the critic re-checks;
the loop continues until the critic passes it or a budget stops it.

```
  Debate / verifier-critic as layers

  ┌─ Production layer ────────────────────────────────────────────────┐
  │  PRODUCER agent: makes the artifact (answer, plan, recommendation) │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │ artifact
                                  ▼
  ┌─ Verification layer ──────────────────────────────────────────────┐
  │  CRITIC agent (SEPARATE, ideally different model): finds flaws     │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │ critique (pass / revise + why)
                                  ▼
            revise? ──► back to producer    |    pass? ──► ship
```

The new thing is the *separation* — two agents, two perspectives. The trap is
collapsing them back into one (which is what self-critique is).

## Structure pass

The axis is **whose perspective judges the work**. Self-critique: the producer
judges itself (one perspective). True debate: an independent critic judges (two
perspectives). The seam is the critique handoff and the revise/pass decision.

```
  The perspective axis

  SELF-CRITIQUE (one perspective)      TWO-AGENT DEBATE (two perspectives)
  ────────────────────────────►        ◄───────────────────────────────
  same model makes AND judges          producer model ≠ critic model
  shares its own blind spots            blind spots only partly overlap
  cheap, single loop                    2x cost, real independent check
  → AptKit's rubric agent IS this       → what you build when self-critique
                                          misses errors it can't see
```

The honest framing: self-critique is a *real, useful* pattern — it catches
careless errors, format violations, missed steps. It just cannot catch errors
the model is systematically blind to, because the same blindness is in the
judge. That ceiling is *why* you'd escalate to a two-agent critic.

## How it works

### Move 1 — the mental model

The mental model is **code review by someone who didn't write the code**. The
author can proofread their own PR (self-critique) and will catch typos — but a
reviewer who didn't write it catches the *assumptions the author couldn't see*,
because the reviewer doesn't share them.

```
  The code-review mental model (the topology IS this picture)

  SELF-REVIEW (rubric agent)           PEER REVIEW (true debate)
  ┌──────────────┐                     ┌──────────┐    ┌──────────┐
  │ author reads  │                    │ author    │    │ reviewer │
  │ own PR, edits │                    │ writes PR │──► │ critiques│
  └──────────────┘                     └────▲─────┘    └────┬─────┘
   catches typos                            │ revise        │
   misses own blind spots                   └───────────────┘
                                       reviewer ≠ author → sees blind spots
```

For a frontend reader: self-critique is you re-reading your own component before
opening the PR — valuable, catches the obvious. A two-agent critic is a
teammate's review — catches the thing you were *sure* was fine. Same artifact,
different eyes, and the second pair of eyes is the entire point.

### Move 2 — step by step

**Step 1 — producer makes the artifact.**

```
  produce: task ──► artifact
  ┌──────────────────────────────┐
  │ single-agent loop → candidate │
  └──────────────────────────────┘
```

```
produce(task):
  return reactLoop(producerPrompt, producerPolicy, budget)
```

**Step 2 — critic judges it (separately, ideally a different model).**

```
  critique: artifact ──► { pass: bool, issues: [...] }
  ┌────────────────────────────────────────────┐
  │ DIFFERENT model loop, sees ONLY the artifact │
  │ + the rubric, not the producer's reasoning   │
  └────────────────────────────────────────────┘
```

```
critique(artifact):
  return criticLoop(criticPrompt /* different model */, rubric, artifact)
```

**Step 3 — revise or ship.**

```
  decide: critique ──► revise(artifact) | ship(artifact)
       pass ──► ship
       fail ──► producer revises with the issues, loop (bounded!)
```

```
debate(task):
  artifact = produce(task)
  for round in 0..maxRounds:           # bounded, or it loops forever
    c = critique(artifact)
    if c.pass: return artifact
    artifact = produce_revision(task, artifact, c.issues)
  return artifact                       # ship best-effort at budget
```

### Move 3 — the principle

The value of a critic is *independence*, and independence has degrees. A critic
that's the same model as the producer is barely independent — it shares the
training blind spots, so it'll wave through the same systematic errors. Using a
*different model family* as the critic is the cheap, high-leverage move: the two
models' blind spots only partly overlap, so the critic catches errors the
producer is constitutionally blind to. And the loop must be bounded — producer
and critic can ping-pong forever ("still not good enough" / "okay revised")
without a round cap. Independence buys quality; the round cap buys termination.

## Primary diagram

The bounded debate loop with the independence requirement and round cap marked.

```
  Two-agent debate with its two controls

  task ──► ┌──────────┐ artifact ┌───────────────────────────────┐
           │ PRODUCER  │ ───────► │ CRITIC (different model ★1)    │
           │  (model X)│          │  finds flaws vs rubric         │
           └────▲──────┘          └───────────────┬───────────────┘
                │ revise(issues)                   │ pass / fail
                │                                  ▼
                └────────────  fail  ◄──── round < maxRounds ? ★2
                                          pass ──► ship
  ★1 critic must be independent (different model) or it shares blind spots
  ★2 cap the rounds or producer/critic loop forever (file 09: infinite handoff)
```

## Implementation in this codebase

**Not yet exercised as multi-agent.** AptKit has a *self-critique* agent, not a
two-agent debate.

The rubric-improvement agent
(`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:57`) scores
a *subject* against a rubric — the model judges rather than produces. But the
judging and any improving happen in **one loop, one model**
(`improve()` calls a single `runAgentLoop`, line 66, bounded 6 turns / 3 tool
calls / 2400 tokens, lines 76-77). There is no separate critic agent and no
second model checking the first. So:

- This is the **self-critique / reflexion** shape (covered in
  `../01-reasoning-patterns/05-reflexion-self-critique.md`), *not* the two-agent
  debate this file teaches.
- It inherits the self-critique ceiling: a single model judging shares its own
  blind spots. The mitigation taught here — a *different-model-family* critic —
  is not present. Today the judge and the (implicit) producer are the same model
  family.

What you'd reuse to build a real debate: the producer and critic are each just a
`runAgentLoop` (`packages/runtime/src/run-agent-loop.ts:76`) with its own prompt
and policy, and the per-agent validator (e.g.
`packages/agents/diagnostic-investigation/src/validate.ts:25`) is the gate that
decides "pass." The missing piece is wiring a *second* loop on a *different
provider* (`@aptkit/provider-anthropic` vs `@aptkit/provider-openai` both exist)
as the critic, plus a bounded revise loop.

The honest one-liner: AptKit does single-agent self-critique (real), not a
two-agent producer/critic debate (not built); the SECTION F templates
(`../06-orchestration-system-design-templates/`) sketch the two-agent version.

## Elaborate

The self-preference bias is the reason this topology exists and the reason
self-critique has a ceiling. A model asked "is this answer good?" about its own
output is systematically biased toward "yes" — it generated that output by
following its own most-likely paths, so the same paths look correct on review.
This is the LLM-as-judge self-preference problem, and the cross-link
`.aipe/study-ai-engineering` treats it directly. The practical consequence:
self-critique is fine for *mechanical* checks (did it follow the format, did it
hit every rubric dimension) and unreliable for *judgment* checks (is this
conclusion actually right). When the judgment matters, you need an independent
critic — and the cheapest independence is a different model family.

A subtlety: "different model" doesn't have to mean "better model." A weaker
critic from a different family can still catch a strong producer's blind spots,
because the blindness isn't about capability — it's about *correlation*. Two
strong models from the same family share more blind spots than a strong and a
weak model from different families.

## Interview defense

**Q: "Your rubric agent judges quality — is that a multi-agent
verifier/critic setup?"**

"No — it's single-agent self-critique. One `runAgentLoop`, one model, scoring a
subject against a rubric; there's no separate critic agent. That's a real,
useful pattern for mechanical checks, but it has a hard ceiling: a model judging
its own kind of output shares its own blind spots — the self-preference bias. A
true verifier/critic puts the judging in a *separate* agent, ideally a different
model family, so the blind spots only partly overlap. I'd build that the day
self-critique starts waving through systematic errors it can't see — and AptKit
already has two provider packages (Anthropic, OpenAI) to make the critic
independent. The loop has to be round-capped or producer and critic ping-pong
forever."

```
  The one-line defense
  rubric agent = self-critique (one model, shares blind spots)
  true critic = SEPARATE different-model agent (independent eyes) + round cap
```

Anchor: `rubric-improvement-agent.ts:57,66` (single loop, single model — the
self-critique shape); `validate.ts:25` (the pass gate you'd reuse);
`@aptkit/provider-anthropic` + `@aptkit/provider-openai` (the independence
you'd wire in).

## Validate your understanding

1. **Spot the self-critique.** Read `rubric-improvement-agent.ts:57-90`. Confirm
   `improve()` runs *one* `runAgentLoop` with *one* model — no second agent
   judges it.

2. **Find the ceiling.** Explain why this agent can't catch an error it's
   systematically blind to. (Same model judges and reasons — shared blind spots,
   self-preference bias.)

3. **Predict the upgrade.** To make it a true critic, what two things do you add?
   (A second agent on a *different* model family as the critic, and a bounded
   revise loop with a round cap.)

4. **Predict the failure if unbounded.** Producer and critic with no round cap —
   what happens? (Infinite ping-pong; file 09's infinite-handoff failure.)

## See also

- `../01-reasoning-patterns/05-reflexion-self-critique.md` — the single-agent
  shape the rubric agent actually is
- `06-swarm-handoff.md` — another place the infinite-handoff failure shows up
- `09-coordination-failure-modes.md` — infinite handoff and its round-cap bound
- `.aipe/study-ai-engineering` — LLM-as-judge self-preference bias (the reason a
  separate, different-family critic is needed)
- `../06-orchestration-system-design-templates/` — SECTION F: the two-agent
  build template
