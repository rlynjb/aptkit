# Heuristic-before-LLM

Heuristic-before-LLM · the cheap-path gate (Industry standard)

The cheapest model call is the one you never make. Before aptkit spends a token, a deterministic check rules out work the agent can't possibly do — if a task needs a capability the workspace doesn't have, it's filtered out *before* the model runs. aptkit's real version of this is the coverage gate. It's a `.filter()` over tasks, run by code, not by an LLM.

## Zoom out, then zoom in

The gate sits in front of the agent loop — a deterministic checkpoint between "here are the tasks" and "spend tokens."

```
aptkit — where the cheap path gates the expensive one
┌─────────────────────────────────────────────┐
│ Requested tasks (requirements)                │
├─────────────────────────────────────────────┤
│ ★ coverage-gate: runnableRequirements()        │  ← you are here (DETERMINISTIC)
│    schemaCapabilities → requirementCoverage     │
├─────────────────────────────────────────────┤
│ Agent loop + complete()  ── only runnable tasks │  ← EXPENSIVE, model spends here
├─────────────────────────────────────────────┤
│ Model                                           │
└─────────────────────────────────────────────┘
```

The pattern is "heuristic-before-LLM" — a cheap deterministic filter guarding an expensive probabilistic one. The question: *which of these tasks can we rule out without asking the model?* You've done this exact move on the frontend: validate the form client-side before hitting the API, so you don't burn a round trip on input you already know is invalid. Here the "invalid input" is a task whose required capabilities aren't in the workspace.

## Structure pass

Three steps: read what the workspace can do, score each task, drop the impossible. Trace the **cost** axis.

```
COST axis — what's spent at each step?
Step                       cost          can rule out work?
───────────────────────────────────────────────────────────
schemaCapabilities()       ~free (read)  —
requirementCoverage()      ~free (compare) scores full/limited/unavailable
runnableRequirements()     ~free (filter)  drops 'unavailable' ←★ seam
agent loop + complete()    $$ tokens       runs ONLY survivors
```

The seam is `runnableRequirements`. Everything before it is free CPU work. Everything after it costs tokens. The filter is the gate: an `unavailable` task dies here, for free, instead of dying after the model spent tokens discovering it couldn't be done. The whole point is that the flip from free-to-expensive happens *after* the impossible tasks are gone.

## How it works

**Mental model.** Match required capabilities against available ones, like a set membership test. The workspace advertises what it can do; each task declares what it needs; coverage is the intersection. No model involved — it's a comparison.

```
The gate — set matching, no LLM
  workspace capabilities:  {A, B, C}
  task needs A,B → 'full'        ✓ runnable
  task needs A,X → 'limited'     ~ partial (some missing)
  task needs X,Y → 'unavailable' ✗ FILTERED OUT before any token
```

**Reading what the workspace can do.** First, derive the capability set from the schema.

```ts
// packages/tools/src/coverage-gate.ts:23-35  (schemaCapabilities)
// inspect the workspace/schema → produce the set of capabilities it supports
// pure derivation: no model, no network
```

**Scoring each requirement.** Each task gets graded against that set.

```ts
// packages/tools/src/coverage-gate.ts:38-45  (requirementCoverage)
// returns 'full' | 'limited' | 'unavailable'
//   full        = every needed capability present
//   limited     = some present, some missing
//   unavailable = none / the critical ones missing
```

Three states, not a boolean — because "partially doable" is real (run the task but warn). `coverageReport` (lines 56-70) rolls these into a per-task summary you can show before committing to a run.

**The filter that saves the tokens.** This is the gate itself.

```ts
// packages/tools/src/coverage-gate.ts:73-78  (runnableRequirements)
// keep tasks whose coverage is NOT 'unavailable'
//   → 'full' and 'limited' survive; 'unavailable' is dropped
//   the agent never sees an unavailable task → never spends a token on it
```

That one filter is the heuristic-before-LLM in code. An `unavailable` task is provably impossible (the workspace lacks the capability), so there's zero value in asking the model to attempt it — you'd pay tokens to be told "can't." The filter answers deterministically, for free, first.

**The principle.** Don't pay the model for work you can rule out deterministically. Any time a cheap, exact check can eliminate a candidate before the expensive probabilistic step, run it first. This generalizes everywhere: a regex pre-filter before an LLM classifier, a cache hit before a generation, a permission check before a tool call. The model is the most expensive tool in the box — gate it.

## Primary diagram

The full route from requested tasks to a token spend, with the impossible ones dropped for free.

```
Coverage gate — full routing
  requested tasks ─────────────┐
                               ▼
  schemaCapabilities() ──▶ {available caps}
                               │
       per task: requirementCoverage(task, caps)
                               │
            ┌──────────────────┼──────────────────┐
          'full'           'limited'          'unavailable'
            │                  │                    │
            └── runnableRequirements() keeps ───────┘ drops here (FREE)
                         │                            ✗ no token spent
                         ▼
                  agent loop + complete()   ── $$ tokens spent only here
```

The expensive box at the bottom only ever sees survivors; the `unavailable` branch is killed before any spend.

## Elaborate

This is the AI-engineering instance of the classic "cheap check before expensive operation" — short-circuit evaluation, a bloom filter before a disk read, client-side validation before a server round trip. In LLM systems it shows up as model routing (small model gates the big one), retrieval gating (no relevant docs → skip generation), and intent classifiers that bail before the expensive agent spins up. aptkit's gate is the capability-coverage flavor. Read `04-structured-outputs.md` (the gate's deterministic-then-probabilistic shape mirrors validate-then-retry) and `06-token-economics.md` (what the gate saves you in dollars).

## Project exercises

### Surface the coverage report before the run

- **Exercise ID:** `EX-LLM-07a`
- **What to build:** This gate exists (Case A) — make its savings visible. Emit a trace event from `coverageReport`/`runnableRequirements` that records how many tasks were dropped as `unavailable` and which capabilities they needed, so Studio can show "skipped 3 tasks, saved N model calls" before the agent runs.
- **Why it earns its place:** Phase 1 wants you to *see* the cheap-path payoff, not just trust it. You'll learn to instrument a deterministic gate and quantify avoided spend, which is exactly the argument you make when defending a heuristic-before-LLM design.
- **Files to touch:** `packages/tools/src/coverage-gate.ts` (56-70 `coverageReport`, 73-78 `runnableRequirements`); emit via the trace/event path used by `packages/runtime/src/ndjson-stream.ts`.
- **Done when:** running a workspace missing a capability produces a trace event listing the dropped tasks and the missing capabilities, and the count matches the tasks the agent never received.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How do you avoid spending tokens on work the agent can't do?**

```
  task needs capability X, workspace lacks X
  → requirementCoverage = 'unavailable'
  → runnableRequirements() DROPS it     (free, deterministic)
  → agent never sees it → 0 tokens
       └ vs: let the model try, pay, get told "can't"
```

A deterministic capability check filters out impossible tasks before the agent runs — `runnableRequirements()` drops `unavailable` ones for free. Anchor: *rule it out with code before you pay the model.*

**Q: Why three coverage states instead of runnable/not?**

```
  full        → run it
  limited     → run it, but warn (some capability missing) ← the nuance
  unavailable → drop it
```

Because "partially doable" is a real case — a `limited` task still runs but flags missing capabilities, which a boolean would force you to wrongly drop or wrongly trust. Anchor: *partial coverage is a first-class state.*

## See also

- [`06-token-economics.md`](./06-token-economics.md) — the dollars this gate saves.
- [`04-structured-outputs.md`](./04-structured-outputs.md) — the deterministic-then-probabilistic shape.
- [`08-provider-abstraction.md`](./08-provider-abstraction.md) — the expensive step the gate guards.
