# 05 — Reflexion / Self-Critique

*Reflexion / self-critique / LLM-as-judge / self-refine — Industry standard
(Shinn et al. "Reflexion" 2023; Madaan et al. "Self-Refine" 2023).*

## Zoom out, then zoom in

This is the one fancier pattern AptKit *actually built* — and it's the rubric
agent. Place it.

```
  The reasoning family, with the built upgrade marked

  ┌─ reasoning patterns ─────────────────────────────────────┐
  │   chain                                                   │
  │   ReAct ───────────── 4 analytics agents (produce)        │
  │   plan-and-execute ── NOT BUILT                           │
  │   ★ reflexion / self-critique ★ ── rubric agent  ← here   │
  │   tree-of-thoughts ── NOT BUILT                           │
  └──────────────────────────────────────────────────────────┘
```

Here's the shift that makes this pattern click. The four analytics agents
*produce* an answer: "here are the anomalies," "here is the diagnosis." The
rubric-improvement agent *judges* a subject against a rubric, finds the weakest
dimension, and proposes one next action. The model's job flips from *author* to
*critic.* That flip — model evaluating work instead of generating it — is the
heart of the reflexion/self-critique family.

Frontend anchor: producing is a render function returning markup. Judging is a
*validator* — `function validate(formState): { weakestField, fix }`. Same
machinery (a function over input), opposite intent: one emits the artifact, one
emits a critique of an artifact. The rubric agent is a validator powered by an
LLM instead of a regex.

And the hard limit you must say out loud: **a self-critic shares the blind spots
of the thing it critiques.** If the same model both wrote and graded an answer,
a flaw the model can't see when writing is a flaw it can't see when grading. The
rubric agent sidesteps this by judging a *separate* subject against an
*external* rubric — it's not grading its own essay — but the general pattern's
ceiling is real, and naming it is the staff-level move.

## Structure pass

Trace the **role axis** — "is the model producing or evaluating" — to locate
where the rubric agent flips.

```
  Role axis: what the model's output IS

  Capability              Model's output is…              Role
  ──────────────────────  ──────────────────────────────  ─────────
  scan / investigate /    the artifact (anomalies, etc.)  PRODUCER
  propose / answer
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   ─ ─ ◄ SEAM
  improve (rubric agent)  a JUDGMENT of an artifact        CRITIC
                          + weakest dimension + next action
```

The seam is `improve()`. Everything before it on the role axis emits work;
`improve` emits an *assessment* of work. Mechanically it's the same kernel —
same `runAgentLoop`, same budget, same forced synthesis. Only the *prompt and
the parser* change: the prompt says "score this," the parser validates a
judgment shape. That's the elegant part: reflexion is the kernel with a critic's
prompt, not new machinery.

## How it works

### Move 1 — the mental model

Self-critique is a loop where the model generates (or is handed) a subject, then
evaluates it against criteria, then the evaluation drives the next move — fix,
re-attempt, or stop. The rubric agent runs the *evaluate* half.

```
  Self-critique = produce → judge → act-on-judgment

  ┌──────────┐   subject    ┌───────────┐   verdict +    ┌─────────────┐
  │ PRODUCE  │ ───────────▶ │  JUDGE     │  weakest dim   │ ACT:        │
  │ (or take │              │ score vs   │ ─────────────▶ │ next action │
  │  given)  │              │ rubric     │                │ / drill     │
  └──────────┘              └─────┬──────┘                └─────────────┘
                                  │ uses tools (history, context)
                                  ▼
                            grounded judgment
```

### Move 2 — the moving parts

**The subject under judgment**

```
  input.subject  ──▶  the thing being graded (NOT produced here)
  input.context  ──▶  extra facts to ground the grade
```

Pseudocode: the user prompt is `Subject:\n{subject}` plus optional context. The
agent does not write the subject; it receives one and grades it. This is what
keeps it out of the self-grading trap — separate author, separate grader.

**The rubric as the evaluation criteria**

```
  rubric = { dimensions[], checks[], verdicts[] }
       │
       ▼
  judgment must score EACH dimension + pick a verdict   ← criteria are external
```

Pseudocode: the system prompt embeds the rubric JSON and demands a fixed output
shape (`{dimensions, verdict, weakestDimension, nextAction}`). The criteria
being *external and explicit* is what prevents the critique from being vibes —
the model can't grade on a curve it invents.

**The single next action (the "reflexion" output)**

```
  weakest dimension  ──▶  ONE focused next action / drill
  (not a rewrite, not an essay)
```

Pseudocode: output includes `weakestDimension` and one `nextAction`. Reflexion's
insight is that a *targeted, minimal* correction beats a sprawling rewrite — fix
the weakest thing, re-run, repeat. The rubric agent enforces this: "Do not
rewrite the subject. Do not provide a long coaching essay."

**The hard parse gate**

```
  output not valid judgment JSON?  ──▶  recovery turn  ──▶  still bad? THROW
```

Pseudocode: `if (!parsed) throw`. Unlike the producers (which fall back to `[]`
or a default), a judgment that won't parse is *useless* — a half-graded rubric
is worse than none — so the rubric agent throws hard.

### Move 3 — the principle

Self-critique flips the model from author to grader against *external* criteria;
its power is targeted correction, its ceiling is shared blind spots — so ground
it in a separate subject and an explicit rubric, never in self-graded vibes.

## Primary diagram

The rubric agent's full shape: kernel underneath, critic's prompt on top,
external rubric as criteria, hard-throw on unparseable judgment.

```
  Rubric-improvement agent — reflexion on the shared kernel

  subject + context              external rubric (criteria)
        │                               │
        ▼                               ▼
  ┌──────────────────────────────────────────────────────┐
  │  runAgentLoop (SAME kernel as producers)              │
  │   model JUDGES: score each dimension, find weakest    │
  │   tools: recent judgments / pattern history / context │
  │   budget 6 turns / 3 tool calls / 2400 tokens         │
  └───────────────────────┬──────────────────────────────┘
                          ▼
              { judgment, weakestDimension, nextAction, nextDrill }
                          │
                  parseable?  ──NO──▶ recovery turn ──NO──▶ THROW
                          │ YES
                          ▼
                  return RubricImprovementResult
```

Same machinery as a producer; only the prompt's intent and the parser's shape
changed.

## Implementation in codebase

**Use case: grade an attempt against a skill rubric and hand back one drill.**
The rubric agent scores a subject across the rubric's dimensions, names the
weakest one, and proposes a single next action plus an optional drill — a
reflexion loop's *evaluate* step, productized.

`packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:57` —
`improve()` is the critic:

```ts
// rubric-improvement-agent.ts:66-90 — the kernel, in critic mode
const { parsed } = await runAgentLoop({
  capabilityId: RUBRIC_IMPROVEMENT_CAPABILITY_ID,
  model: this.model, tools: this.tools,
  system,                                   // ← judge prompt, embeds the rubric
  userPrompt: buildRubricImprovementUserPrompt(input),  // ← Subject: ... (the thing graded)
  toolSchemas,
  maxTurns: 6, maxToolCalls: 3, maxTokens: 2400,        // ← tighter budget than producers
  synthesisInstruction: buildSynthesisInstruction(
    'Return the final rubric improvement JSON object with judgment, weakestDimension, nextAction, and optional nextDrill.',
  ),
  parseResult: (text) => parseImprovementResult(text, validate),
  recoveryPrompt: (completedToolCalls) => [ /* re-ask for the judgment shape */ ],
});

if (parsed) return parsed;
throw new Error('rubric improvement output was not parseable');  // ← line 92-93, HARD throw
```

The prompt makes the critic role explicit — `buildRubricImprovementSystemPrompt`
at `rubric-improvement-agent.ts:97`:

```ts
// :103-104 — the role flip, in the prompt's own words
'Your job is to score the subject, identify the weakest dimension, and produce one focused next action.',
// :105 — the anti-rewrite guard (reflexion: targeted correction, not sprawl)
'Do not rewrite the subject. Do not provide a long coaching essay.',
```

Contrast the failure handling with a producer: the monitoring agent returns `[]`
on a failed parse (`monitoring-agent.ts:85`), the diagnostic agent returns
`FALLBACK_DIAGNOSIS` (`diagnostic-agent.ts:40,82`). The rubric agent *throws*
(line 92-93) because a malformed judgment can't be safely defaulted — there's no
sensible "empty grade."

Note the tools it's granted (`rubric-improvement-agent.ts:17-24`):
`get_recent_judgments`, `get_user_pattern_history`, `get_current_attempt_context`
— evidence to *ground the grade*, exactly like a human grader pulling up a
student's history before marking. It also has `save_judgment` and
`generate_next_scenario`, the only write-ish tools in the five agents.

## Elaborate

**Origin.** "Reflexion" (Shinn, Cassano, et al., 2023) added a self-reflection
step to agents: after a failed attempt, the model writes a verbal critique of
*why* it failed, stores it, and uses it on the retry — measurably improving
coding/QA success. "Self-Refine" (Madaan et al., 2023) showed iterative
self-feedback improving single outputs. "LLM-as-judge" is the same machinery
used for *evaluation* rather than self-improvement.

**Adjacent concepts.** The full reflexion loop has a *retry* edge (judge → fix →
re-attempt → judge); AptKit's rubric agent runs the judge step and emits the
next action but does *not* auto-retry — a human (or another run) acts on the
drill. That's a deliberate, honest scoping: it's reflexion-*shaped*, not a closed
reflexion loop. The shared-blind-spot limit is why production systems often use a
*different* model (or external rubric, as here) for the judge than for the
producer.

## Interview defense

**Q: "Where's self-critique in your codebase, and what's its hard limit?"**

```
  rubric agent: model JUDGES a subject vs external rubric
       │
       limit ─▶ a self-critic shares the blind spots of what it grades
       mitigation ─▶ separate subject + EXTERNAL rubric (not self-grading)
```

Anchor: "The rubric agent flips the model from author to grader — and I keep it
honest by grading a separate subject against an explicit external rubric, never
its own output."

**Q: "Why does the rubric agent throw on a bad parse when the others return a
fallback?"**

```
  producer bad parse ─▶ [] / default     (an empty answer is still safe)
  judge   bad parse ─▶ THROW             (a half-grade is worse than none)
```

Anchor: "There's no safe default for a malformed judgment — a partial grade
misleads — so it fails loud at `rubric-improvement-agent.ts:92`." Surfaces the
skeleton part: the kernel is identical; only the *parser's failure policy* (throw
vs fallback) and the *prompt's intent* (judge vs produce) differ.

## Validate

- **Reconstruct:** Draw produce→judge→act and mark which step the rubric agent
  implements (judge + emit-next-action; no auto-retry edge).
- **Explain:** Why is the rubric agent *not* in the self-grading trap? (it judges
  a separate `input.subject` against an external rubric, not its own output;
  `rubric-improvement-agent.ts:114-118`, `:97-111`.)
- **Apply:** You want to add an auto-retry edge (full reflexion loop). Where does
  the `nextAction` feed back, and what new failure mode appears? (feed
  `weakestDimension`+`nextAction` into a fresh subject; new risk: infinite
  re-grade loop — needs its own budget.)
- **Defend:** Justify the hard `throw` over a `FALLBACK_JUDGMENT`. (no sensible
  empty grade; a defaulted judgment silently misleads a downstream learner;
  compare `diagnostic-agent.ts:40` where a fallback diagnosis *is* sensible.)

## See also

- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — the identical kernel
  underneath, in critic mode
- [03-react.md](03-react.md) — the producer base case this contrasts with
- [04-plan-and-execute.md](04-plan-and-execute.md) — the other escalation rung
- `../04-agent-infrastructure/` — the structured-output validator the hard-throw
  relies on
- `.aipe/study-prompt-engineering/` — the self-critique *prompt* wording
