# 01 — When NOT to Go Multi-Agent

> The escalation gate. The most senior answer in this whole sub-section is
> "we stayed single-agent on purpose, and here's the exact failure that would
> change my mind." This file is that answer, and AptKit is its worked example.

## Zoom out

Multi-agent is not a level you graduate to. It's a cost you take on when a
specific kind of failure forces you to. Most teams that "go multi-agent" do it
because it sounds advanced, ship a brittle web of agents talking to agents, and
then spend a quarter debugging non-deterministic handoff loops they could have
avoided. The decision is layered: there's a baseline you must build first, a
measurement you must take, and a *gate* you cross only when the measurement
shows a particular shape of failure.

```
  The decision as layers (you cannot skip a layer)

  ┌─ Layer 0: Baseline ───────────────────────────────────────────────┐
  │  Build the single-agent ReAct loop. Ship it. This is AptKit.       │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  run it on real cases, collect a trace
  ┌─ Layer 1: Measurement ────────────────────────────────────────────┐
  │  Where does it fail? Wrong answers? Runs out of budget? Confuses    │
  │  two unrelated subtasks in one context? Hits a tool ceiling?        │
  └───────────────────────────────┬───────────────────────────────────┘
                                  │  classify the failure
  ┌─ Layer 2: The gate ───────────────────────────────────────────────┐
  │  Is the failure DECOMPOSABLE? i.e. does splitting the work into     │
  │  separately-scoped agents remove the failure — not just relocate    │
  │  it into coordination overhead?                                     │
  └──────────────┬─────────────────────────────────┬───────────────────┘
            NO   │                                  │  YES
                 ▼                                  ▼
   stay single-agent (fix the prompt,     go multi-agent (pay the
   the budget, the tool policy)           2-5x coordination tax)
```

The point of the diagram: you are not allowed to be at Layer 2 without having
done Layer 1, and you are not allowed at Layer 1 without a Layer 0 baseline.
"We should use multiple agents" with no baseline and no measurement is a smell,
not a design.

## Structure pass

There is one axis here, and everything sorts along it: **does the failure get
*removed* by decomposition, or merely *moved* into coordination?**

```
  The one axis: removed vs moved

  failure REMOVED by split            failure MOVED into coordination
  ──────────────────────────►         ◄──────────────────────────────
  • two subtasks need disjoint        • one coherent task that just
    tool sets and disjoint context      needs a better prompt
  • a worker's output must be         • a long task that needs a
    independently verified             bigger budget, not a second agent
  • subtasks are genuinely             • subtasks that share so much state
    parallel and independent            you'd pass everything between them

  ──► cross the gate                  ──► stay; you'd add tax for nothing
```

The seam to watch: the moment two "agents" need to share most of their context
to do their jobs, you have not decomposed anything. You've taken one agent,
cut it in half, and added a network of message-passing between the halves. That
is strictly worse than the one agent you started with.

## How it works

### Move 1 — the mental model

The mental model is a **manager hiring decision**. You don't hire a second
person because the first person is "only one person." You hire when the work
splits cleanly into two roles that *don't need to sit in each other's heads* —
when the coordination cost of two people is less than the cost of one person
context-switching between two unrelated jobs.

```
  The hiring-decision mental model

   One job, coherent              Two jobs, disjoint
   ┌─────────────┐                ┌─────────┐   ┌─────────┐
   │  one agent  │                │ agent A │   │ agent B │
   │  does it    │                │ (role 1)│   │ (role 2)│
   └─────────────┘                └────┬────┘   └────┬────┘
   coordination cost: 0                └─── handoff ──┘
   →  DEFAULT here                 coordination cost: 2-5x
                                   →  only if A and B don't
                                      need each other's context
```

For a frontend reader: this is the same call as "should this be one component
with internal state, or a parent + child with props and callbacks?" You split
into parent/child when the child has a *genuinely separate responsibility* and a
clean prop interface. You do *not* split when the child needs to reach back into
the parent's state for everything — that's prop-drilling hell, the UI version of
two agents passing each other their entire context every turn.

### Move 2 — step by step

**Step 1 — build and ship the single-agent baseline.**

```
  Layer 0 in practice

  task ──► [ single ReAct loop ] ──► result
                  │
                  └─ prompt + tool policy + budget + validator
```

```
build_baseline():
  agent = ReActLoop(prompt, toolPolicy, budget, validator)
  ship(agent)            # to real users / real cases
  return agent
```

You ship this. You do not pre-build the multi-agent version "just in case." The
baseline is the thing the gate decision is measured *against*.

**Step 2 — measure where it fails, on real traces.**

```
  Layer 1 in practice — classify each failure

  trace ──► failure type?
            ├─ wrong answer, right tools     → prompt problem
            ├─ ran out of budget mid-task    → budget problem
            ├─ two unrelated subtasks bled
            │   into one context             → DECOMPOSABLE
            └─ needed disjoint tool sets      → DECOMPOSABLE
```

```
classify(trace):
  if wrong_answer and tools_were_right:  return "prompt"
  if hit_budget_exit and task_unfinished: return "budget"
  if context_mixed_unrelated_subtasks:    return "decomposable"
  if needed_tools_outside_policy:          return "decomposable"
```

**Step 3 — apply the gate.**

```
  Layer 2 in practice — the gate

  failure == "decomposable"  ?
       │ no                          │ yes
       ▼                             ▼
  fix prompt/budget/policy      split into scoped agents,
  (stay single-agent)          accept the 2-5x tax,
                               add coordination + its failure modes
```

```
gate(failureType):
  if failureType in ("prompt", "budget", "tool-policy"):
      return "stay single-agent"   # cheaper fix, no new failure modes
  if failureType == "decomposable":
      return "go multi-agent"      # now read 02..09
```

### Move 3 — the principle

Decomposition is justified only when it *removes* a failure that a bigger
budget or a better prompt cannot. Adding agents always adds coordination, and
coordination is itself a new surface of failure (the whole of file 09). The
default is one agent, because one agent has no handoff to break, no shared state
to corrupt, no second context to bloat. You escalate when the work genuinely
splits — not when it merely gets large.

## Primary diagram

The full gate, end to end, with the tax made explicit.

```
  The escalation gate (the whole decision on one page)

  ┌────────────────────┐
  │ single-agent loop  │  ◄── DEFAULT. AptKit's 5 agents all live here.
  │ (cheap, no handoff)│
  └─────────┬──────────┘
            │ measure on real cases
            ▼
     ┌─────────────┐   no    ┌────────────────────────────┐
     │ decomposable │ ──────► │ fix prompt / budget / policy│ ──► stay
     │  failure?    │         └────────────────────────────┘
     └──────┬───────┘
            │ yes
            ▼
  ┌──────────────────────────────────────────────┐
  │ go multi-agent — accept the 2-5x tax:         │
  │  • more model calls (each agent reasons)      │
  │  • handoff/merge plumbing to build + test     │
  │  • non-deterministic coordination to debug    │
  │  • the failure modes in file 09               │
  └──────────────────────────────────────────────┘
```

The 2-5x is not a rounding error. Each agent is its own reasoning loop with its
own token spend; the orchestration adds calls that do nothing but route. You
buy that with a failure you could not otherwise fix.

## Implementation in this codebase

**AptKit is the worked example of correctly staying single-agent.** This is not
a "not yet exercised" file — staying single-agent *is* the exercised decision,
and the code shows the decision was made well rather than by omission.

Use cases where the gate was applied and answered "stay":

1. **Five capabilities, five independent loops — none decomposed.** Each agent
   is a thin wrapper over one `runAgentLoop` call:
   `AnomalyMonitoringAgent.scan()`
   (`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:57`),
   `DiagnosticInvestigationAgent.investigate()`
   (`packages/agents/diagnostic-investigation/src/diagnostic-agent.ts:55`),
   `RecommendationAgent.propose()`
   (`packages/agents/recommendation/src/recommendation-agent.ts:64`). Each is
   *one coherent job* — scan, or investigate, or propose — so each is one agent.

2. **The "budget" fix was chosen over decomposition.** A long investigation
   isn't split into sub-agents; it's given a bounded budget and a forced
   synthesis turn. In `run-agent-loop.ts`, `maxTurns` (default 8, line 87) and
   `maxToolCalls` (line 89) cap the loop, and `forceFinal` (line 102) trips the
   forced-synthesis exit at lines 102-105. The answer to "this task is large"
   was a bigger budget with a hard ceiling — *not* a second agent.

3. **The "tool-policy" fix was chosen over decomposition.** Different agents
   need different tools, which looks like a reason to split — but AptKit handles
   it with a per-capability allowlist instead.
   `filterToolsForPolicy` (`packages/tools/src/tool-policy.ts:11`) narrows the
   one shared tool registry down to each agent's role. The monitoring agent sees
   4 tools (`monitoring-agent.ts:14-19`); the diagnostic agent sees 11
   (`diagnostic-agent.ts:13-25`). Disjoint tool sets did *not* force separate
   processes — they're separate *policies* over one loop.

The honest verdict: every place AptKit could have reached for multi-agent, it
found a cheaper single-agent fix that removed the failure without adding
coordination. That is the gate working.

When the gate *would* flip: see `03-sequential-pipeline.md` — the
`scan → investigate → propose` chain is the one place a future orchestrator is
genuinely justified, because the three stages are disjoint roles with clean
typed handoffs. That's decomposable. The SECTION F templates in
`../06-orchestration-system-design-templates/` build it.

## Elaborate

The trap is treating multi-agent as a maturity signal. It isn't. It's a
liability you take on for a payoff. The frontend analogy holds all the way
down: splitting one component into many is sometimes the right call and
sometimes premature abstraction, and the way you tell them apart is identical —
do the pieces have genuinely separate responsibilities with clean interfaces, or
are you just making one thing harder to follow?

A subtle corollary: "the prompt is getting too long / the agent is confused"
almost never justifies multi-agent. That's usually a context-engineering or
tool-policy problem (`../04-agent-infrastructure/`). Splitting a confused agent
into two confused agents that now also have to talk to each other makes it
worse. The only failure that decomposition *removes* is the one where two parts
of the work truly don't need each other — and that's rarer than it feels.

## Interview defense

**Q: "Why didn't you make this multi-agent? Isn't a pipeline of specialized
agents better than one big agent?"**

Answer with the gate, not with a preference. "I build a single-agent baseline,
ship it, and measure failures on real traces. I only go multi-agent on a
*decomposable* failure — where the work splits into roles that don't need each
other's context. If the failure is a bad prompt, a small budget, or an
over-broad tool set, I fix that, because multi-agent costs 2-5x and adds
coordination failure modes I'd then have to debug. In AptKit, every failure I
saw had a cheaper single-agent fix — bounded budgets, a forced synthesis turn,
per-capability tool policies — so I stayed single-agent on purpose."

```
  The one-line defense
  baseline → measure → decomposable? → no → fix cheap (stay)
                                     → yes → pay 2-5x (go)
```

Anchor: `run-agent-loop.ts:87,89,102` (budget fix), `tool-policy.ts:11`
(tool-set fix), the five `*-agent.ts` files (five coherent jobs, five loops).

If pressed on "but when *would* you split?": point to the latent pipeline —
three disjoint roles, clean `Anomaly → Diagnosis → Recommendation` handoff,
already wired by types. That's the one place decomposition is earned, and it's
covered in `03-sequential-pipeline.md`.

## Validate your understanding

1. **Spot the pattern.** Find a place where a "split into agents" instinct was
   answered with a cheaper fix instead. Look at `monitoring-agent.ts:14-19` vs
   `diagnostic-agent.ts:13-25`: disjoint tool sets handled by *policy*, not by
   separate processes. (`tool-policy.ts:11`)

2. **Trace the budget fix.** In `run-agent-loop.ts`, follow `maxTurns` (line 87)
   and `maxToolCalls` (line 89) to `forceFinal` (line 102) and the
   forced-synthesis exit (lines 102-105). Confirm a long task is bounded, not
   decomposed.

3. **Predict the gate.** Given a failure "the agent gives wrong answers but
   called the right tools," which fix does the gate pick? (Prompt — stay
   single-agent. Decomposition removes nothing here.)

4. **Find the one justified split.** Read `diagnostic-agent.ts:55`
   (`investigate(anomaly: Anomaly)`) and `recommendation-agent.ts:64`
   (`propose(anomaly, diagnosis)`). Why are these two *decomposable* (disjoint
   roles, clean typed handoff) where the monitoring/diagnostic tool overlap was
   not? (Because the handoff is a small typed value, not a shared context.)

## See also

- `03-sequential-pipeline.md` — the one place AptKit's gate would flip, and why
- `09-coordination-failure-modes.md` — the cost side of the 2-5x tax, itemized
- `../04-agent-infrastructure/05-guardrails-and-control.md` — the budget and
  policy controls that are the cheap single-agent fixes
- `../06-orchestration-system-design-templates/` — SECTION F: where the
  justified split gets built
- `.aipe/study-ai-engineering/04-agents-and-tool-use/` — single-agent mechanics
