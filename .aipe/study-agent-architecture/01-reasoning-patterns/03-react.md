# 03 — ReAct

*ReAct (Reason + Act) — Industry standard (Yao et al. 2022; the default
production reasoning pattern).*

## Zoom out, then zoom in

ReAct isn't a fifth thing layered on the kernel — it *is* the kernel, named.
Place it in the family first.

```
  The reasoning-pattern family, and where ReAct sits

  ┌─ reasoning patterns (this sub-section) ──────────────────┐
  │                                                          │
  │   chain ──────────── fixed steps, no model control       │
  │                                                          │
  │   ★ ReAct ★ ──────── reason→act→observe loop  ← we are here, AND
  │     │                ALL 5 AptKit agents are this        │
  │     │                                                    │
  │     ├─ plan-and-execute ── ReAct + a plan phase (not built)│
  │     ├─ reflexion ───────── ReAct where model judges (rubric)│
  │     └─ tree-of-thoughts ── ReAct branched (not built)     │
  │                                                          │
  └──────────────────────────────────────────────────────────┘
```

Look at the tree: every other pattern is "ReAct plus something." That's not an
accident of drawing — it's the actual relationship. ReAct is the base case. You
default to it, and you only graduate to a fancier pattern when you can *name the
specific failure* ReAct showed you. AptKit graduated zero times for its four
analytics agents, and graduated once (to reflexion-shaped) for the rubric agent
because the *task* is judging, not producing — more on that in
`05-reflexion-self-critique.md`.

The frontend instinct to fight here: you don't reach for the elaborate
abstraction first. You ship `useState` and a `fetch`, watch it break in a
specific way, *then* reach for the state machine. Same discipline. ReAct is your
`useState`-and-`fetch`. Escalate on evidence, not on anticipation.

## Structure pass

Trace the **failure axis** — "what specific failure justifies leaving ReAct" —
across the escalation ladder.

```
  The escalation ladder: each rung needs a NAMED failure to climb

  Rung                 Climb to it ONLY when ReAct shows you…
  ───────────────────  ──────────────────────────────────────────────
  ReAct (base)         (start here, always)
  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ◄ measure first
  plan-and-execute     …it loses the thread across many steps / redoes work
  reflexion            …its first answer is confidently wrong + checkable
  tree-of-thoughts     …it commits early to a bad path it can't back out of
```

The seam is "measure first." Below ReAct, every rung is a response to an
*observed* failure, never a precaution. If you can't name the failure on the
left that pushed you up, you're cargo-culting. AptKit stayed on the base rung
for analytics because ReAct *measured fine* there — the queries are independent
lookups, not a long fragile plan.

## How it works

### Move 1 — the mental model

ReAct interleaves three things per turn: **reason** (the model thinks in text),
**act** (it emits a tool call), **observe** (the harness feeds the result back).
That's the kernel's loop body with the model's text reframed as "reasoning."

```
  ReAct = one kernel turn, three named moments

  ┌─────────────────────────────────────────────────────┐
  │  REASON   model writes "conversion dropped on mobile, │
  │           let me check segments"     (text block)     │
  │     │                                                 │
  │     ▼                                                 │
  │  ACT      model emits get_segments(...)  (tool_use)   │
  │     │                                                 │
  │     ▼                                                 │
  │  OBSERVE  harness runs it, appends result  (tool_result)│
  │     │                                                 │
  │     └────────── loop: reason again with the new fact  │
  └─────────────────────────────────────────────────────┘
```

(The Thought-Action-Observation prompting mechanics — how you actually get the
model to interleave these — live in
`.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`; this
file is about *placement and escalation*, not the prompt craft.)

### Move 2 — the moving parts

**Default to ReAct**

```
  new agent task  ──▶  ReAct  (kernel + tools + budget + parser)
                       no plan phase, no branching, no self-critique
```

You start every agent as a bare ReAct loop. It's the cheapest agent that can
handle unknown step count. AptKit's `scan`, `investigate`, `propose`, `answer`
all started and stayed here.

**Measure**

```
  run it on real tasks ──▶ collect failures ──▶ categorize them
                           "wrong answer"? "ran out of budget"?
                           "redid work"? "committed to bad path"?
```

You don't escalate on vibes. You run the loop against the replay artifacts (the
eval backbone — `../04-agent-infrastructure/`) and look at *how* it fails. The
failure category tells you which rung, if any, to climb.

**Escalate only on a specific failure**

```
  failure category            ──▶  escalation
  ──────────────────────────       ─────────────────────────
  "loses thread over 10 steps" ──▶  plan-and-execute
  "confidently wrong, checkable"──▶  reflexion / self-critique
  "early bad commitment"        ──▶  tree-of-thoughts (rarely)
  none of the above             ──▶  STAY on ReAct
```

Most of the time the answer is "stay." Escalation adds latency, tokens, and
code. AptKit's analytics tasks never produced a failure category that justified
leaving ReAct — short investigations, independent queries, the budget+synthesis
already handles "ran out of room."

### Move 3 — the principle

ReAct is the default agent. Treat every other pattern as a debt you take on only
to pay down a measured, named failure — never as a precaution.

## Primary diagram

ReAct as the base of the family, with the named-failure gate on every upgrade
path.

```
  ReAct as base case; escalation gated by named failure

                    ┌──────────────┐
   start here ────▶ │    ReAct     │  ◀── all 5 AptKit agents live here
                    │ reason→act→  │
                    │   observe    │
                    └──────┬───────┘
                           │  measure on real tasks
                           ▼
                  ┌─────────────────┐
                  │ named failure?  │
                  └───┬────────┬────┘
                  NO  │        │ YES (and only then)
                      ▼        ▼
                  ┌───────┐  climb exactly one rung:
                  │ STAY  │  plan-exec / reflexion / ToT
                  └───────┘
```

The default branch is "stay," and AptKit takes it for four of five agents.

## Implementation in codebase

**Use case: all five capabilities are ReAct.** None of them adds a plan phase,
a branch, or (except the rubric agent's *task*) a critic. They differ only in
prompt, tool policy, budget, and parser — the ReAct shape is identical.

The five, each a ReAct loop over the kernel:

- `packages/agents/anomaly-monitoring/src/monitoring-agent.ts:57` — `scan()`,
  ReAct scan; reason about the checklist, query, observe, repeat; sorts and
  `slice(0, 10)` at lines 86-88 (post-loop, not part of ReAct).
- `packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:55` —
  `investigate(anomaly)`, ReAct hypothesis-test: reason a hypothesis, query to
  test it, observe, revise. `diagnosisConfidence()` at line 89 infers confidence
  from hypotheses tested vs supported.
- `packages/agents/recommendation/src/recommendation-agent.ts:64` —
  `propose(anomaly, diagnosis)`, ReAct grounded in existing features; ≤3 recs.
- `packages/agents/query/src/query-agent.ts:75` — `answer(question)`, ReAct over
  ~35 read-only tools; returns plain text.
- `packages/agents/rubric-improvement/src/rubric-improvement-agent.ts:57` —
  `improve()`, ReAct-shaped but the task is *judging* (reflexion family — see
  `05-reflexion-self-critique.md`).

The diagnostic agent is the cleanest ReAct illustration because its loop is
literally reason-a-hypothesis-then-test-it. `diagnostic-agent.ts:64-80`:

```ts
const { toolCalls, parsed } = await runAgentLoop<Diagnosis>({
  capabilityId: DIAGNOSTIC_INVESTIGATION_CAPABILITY_ID,
  model: this.options.model, tools: this.options.tools,
  system,                                    // ← prompt that asks for hypotheses
  userPrompt: 'Investigate the anomaly and return the diagnosis JSON object.',
  toolSchemas,                               // ← the act vocabulary
  maxTurns: 8, maxToolCalls: 6,              // ← budget; nothing fancier
  synthesisInstruction: buildSynthesisInstruction(/* ...diagnosis shape... */),
  parseResult: tryParseDiagnosis,
});
```

There is no plan object, no candidate tree, no critic step. It's ReAct, full
stop. The "reasoning" lives in the model's text blocks each turn; the "acting"
is the tool calls; the "observing" is the kernel pushing `tool_result` back. The
only AptKit-specific touch is post-loop: `diagnosisConfidence` downgrades a
`high` to `medium` if any tool errored (`diagnostic-agent.ts:84-85`) — a cheap
deterministic guard, not a reasoning pattern.

## Elaborate

**Origin.** ReAct (Yao, Zhao, et al., "ReAct: Synergizing Reasoning and Acting
in Language Models," 2022) showed that interleaving chain-of-thought
*reasoning* with tool *actions* beat either alone — reasoning alone hallucinates
facts, acting alone can't plan. The interleaving is the whole idea.

**Adjacent concepts.** Chain-of-thought (CoT) is reason-only, no acting — a
single model call that thinks out loud; that's not an agent. Tool-calling
without explicit reasoning text is act-only. ReAct is the synthesis, and it's
why the kernel keeps both text blocks and tool_use blocks from the same response
(`run-agent-loop.ts:126,131`) — the text *is* the reasoning, the tool_use *is*
the act.

## Interview defense

**Q: "Why ReAct and not plan-and-execute for your investigation agent?"**

```
  the escalation gate, applied

  ReAct measured fine?  ──YES──▶  stay (no plan phase)
       │                          AptKit: short investigations, indep. queries
       NO ──▶ would only climb if "loses thread over many steps" appeared
```

Anchor: "Plan-and-execute is debt I take on for a measured failure I never saw —
the diagnostic loop is short and the queries are independent, so ReAct is the
honest choice."

**Q: "What's the load-bearing difference between ReAct and chain-of-thought?"**

```
  CoT:   reason ─▶ reason ─▶ answer        (no tools, can hallucinate facts)
  ReAct: reason ─▶ ACT ─▶ observe ─▶ reason (grounds reasoning in real data)
```

Anchor: "ReAct grounds each reasoning step in a real observation — CoT just
keeps thinking, which is how it confidently invents numbers." This surfaces the
load-bearing skeleton part: the *execute* bone (`tools.callTool`,
`run-agent-loop.ts:159`) is what makes it ReAct and not CoT.

## Validate

- **Reconstruct:** Draw the reason→act→observe triangle and map each corner to a
  block type in `run-agent-loop.ts` (reason = text block line 126, act =
  tool_use line 131, observe = tool_result line 189).
- **Explain:** Point at where the "reasoning" physically lives in the kernel.
  (the text blocks in `response.content`, surfaced at `run-agent-loop.ts:126`.)
- **Apply:** Given "the diagnostic agent keeps re-running the same query across
  turns," is that a reason to escalate off ReAct? (No — that's a state bug; the
  model should see prior results in `messages`; check the state bone before
  blaming the pattern.)
- **Defend:** Justify, to a skeptic, why all four analytics agents stayed on
  ReAct. (No failure category justified climbing; the budget+synthesis turn
  already handles "ran out of room"; escalation is unpaid-for complexity.)

## See also

- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — the kernel ReAct *is*
- [04-plan-and-execute.md](04-plan-and-execute.md) — the first rung up (not built)
- [05-reflexion-self-critique.md](05-reflexion-self-critique.md) — the rung
  AptKit *did* climb, for the rubric agent
- [06-tree-of-thoughts.md](06-tree-of-thoughts.md) — the rung AptKit correctly skips
- `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` — the
  Thought-Action-Observation *prompting* mechanics (not re-taught here)
