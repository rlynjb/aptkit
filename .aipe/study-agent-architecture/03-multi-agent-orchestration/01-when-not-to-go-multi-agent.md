# When NOT to Go Multi-Agent

**Industry standard.** "The single-agent-first rule," "the escalation gate." Type label: architectural decision. **In this codebase: this is the decision aptkit made.** aptkit is single-agent-per-capability on purpose — it built single agents, and never crossed the gate to a coordinated topology because no capability's failure was decomposable into independent specialties *inside aptkit*. The consuming app (blooming_insights) sequences agents; the toolkit doesn't.

## Zoom out, then zoom in

The single most important multi-agent decision is whether to be multi-agent at all. This file comes first by design. aptkit is the worked example of choosing *not* to — and being able to say why is the senior-grade answer.

```
  Zoom out — the gate aptkit chose not to cross

  ┌─ single-agent (aptkit) ─────────────────────────────────┐
  │  6 capabilities, each one runAgentLoop                   │ ← we are here
  │  no supervisor, no handoff, no shared state              │
  └───────────────────────────┬──────────────────────────────┘
                              │ the gate (cross only on a named, decomposable failure)
  ┌─ multi-agent (not crossed in aptkit) ─────────────────────┐
  │  topology + coordination + 2-5x overhead                  │
  │  (blooming_insights, the consumer, sequences agents)      │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Axis: cost vs decomposability.** Multi-agent adds ~2-5x coordination overhead and a much larger debugging surface — now you debug the conversation *between* agents, not just one loop. The gate test: is the failure single-agent can't fix *genuinely decomposable into independent specialties*? Trace aptkit's capabilities against that and each one fails the test — they're already focused single concerns, not bundles of specialties fighting in one prompt.

## How it works

### Move 1 — the mental model

You don't reach for multi-agent because it sounds powerful; you reach for it when a *specific, named* single-agent failure is genuinely decomposable. The gate is a four-step filter.

```
  The escalation gate

  ┌───────────────────────────────────────────────┐
  │ 1. Build a single-agent (ReAct) baseline      │
  │ 2. Measure: success, tool accuracy, latency,  │
  │    cost                                        │
  │ 3. Identify the SPECIFIC failure single-agent │
  │    cannot fix                                  │
  │ 4. Is that failure decomposable into          │
  │    independent specialties?                    │
  │       ├─ no  → stay single-agent, fix the      │
  │       │        prompt / tools / retrieval      │
  │       └─ yes → escalate to the SPECIFIC        │
  │                topology that addresses it      │
  └───────────────────────────────────────────────┘
```

### Move 2 — aptkit's decision, walked

**Step 1-2: aptkit built single-agent baselines and measured them.** Six capabilities, each a `runAgentLoop` with replay-based evals (precision@k for rag-query, structural-diff and rubric-judge for the analytics agents — SECTION D). The measurement infrastructure is the replay pipeline.

**Step 3-4: the failures aptkit hit were not decomposable.** Walk them:
- rag-query: weak model starves retrieval → fixed by `minTopK` floor (an argument guard, not a second agent).
- recommendation: model asks for one more query forever → fixed by the forced synthesis turn (a loop control, not a supervisor).
- any agent: prose instead of JSON → fixed by the recovery turn (a salvage, not a critic agent).

None of these splits into "agent A is good at X, agent B is good at Y, coordinate them." They're failures *inside one agent's loop*, fixable inside the loop. So aptkit stayed single-agent — correctly.

**Where the gate WAS crossed: in the consumer, not the toolkit.** blooming_insights sequences monitoring → diagnostic → recommendation (`docs/blooming-insights-aptkit-core-migration-plan.md`). That's a real decomposition: "what changed" (monitoring), "why" (diagnostic), "what to do" (recommendation) *are* independent specialties, and the output of one feeds the next. So the consuming app earns the pipeline. The toolkit stays single-agent so each capability is independently usable — bundling them into a pipeline inside aptkit would couple them and break their reuse. That's the architectural insight: **the toolkit packages independent single agents; the application composes them.**

**The cost of crossing.** Multi-agent adds ~2-5x coordination overhead and a debugging surface that now includes inter-agent messages. The quality gain is modest unless the problem genuinely splits. aptkit's per-capability agents would gain nothing from being forced into one topology — and would lose their independent reusability, which is the whole reason the monorepo exists (core must not couple capabilities).

### Move 3 — the principle

Build single-agent, measure, and escalate only when a *specific, decomposable* failure appears. aptkit's whole design is this discipline at the toolkit level: independent single agents, composed by the consumer when the consumer's task genuinely decomposes. The senior answer aptkit earns: "I considered multi-agent and kept the toolkit single-agent, because the failures were fixable in-loop and bundling would break per-capability reuse — the *application* composes them when its task decomposes."

## Primary diagram

```
  aptkit's choice — single-agent toolkit, app-level composition

  ┌─ aptkit (toolkit) ──────────────────────────────────────┐
  │  rag-query  recommendation  monitoring  diagnostic ...   │
  │  6 INDEPENDENT single agents, each reusable alone        │
  └───────────────────────────┬──────────────────────────────┘
                              │ consumed by
  ┌─ blooming_insights (app) ─▼──────────────────────────────┐
  │  monitor → investigate → recommend  (a PIPELINE)          │
  │  the gate is crossed HERE, where the task decomposes      │
  └────────────────────────────────────────────────────────────┘
```

## Elaborate

The "don't reach for multi-agent before single-agent hits its quality ceiling" rule is production scar tissue — it comes from teams that shipped multi-agent and paid the coordination tax for a modest quality gain. aptkit encodes the rule structurally: by keeping the toolkit single-agent, it forces the composition decision up to the application, where the actual task shape decides whether a topology is warranted. blooming_insights decided yes (sequential pipeline); a different consumer might decide no.

## Interview defense

**Q: Why isn't aptkit multi-agent?**
Deliberate. The toolkit packages six independent single agents; the failures I hit were all fixable inside one loop — a top_k floor, a forced synthesis turn, a JSON recovery turn — none decomposable into coordinating specialties. Bundling them into a topology inside aptkit would couple capabilities and break per-capability reuse, which is the whole reason the monorepo exists. The *consuming app* (blooming_insights) sequences monitoring → diagnostic → recommendation, because *its* task genuinely decomposes. Toolkit stays single-agent; application composes.

```
  failure decomposable into independent specialties?
    no → stay single-agent (aptkit)   yes → topology (the consumer)
```
*Anchor: "I considered multi-agent and chose not to, because the failure wasn't decomposable" — the strongest version of the answer.*

**Q: What's the cost you avoided?**
~2-5x coordination overhead and a debugging surface that includes inter-agent messages, for a modest quality gain on tasks that don't split. And the reusability cost: coupled capabilities can't ship independently.

## See also

- `02-supervisor-worker.md` — the topology to reach for *if* the gate is crossed
- `03-sequential-pipeline.md` — what blooming_insights actually uses
- `01-reasoning-patterns/06-tree-of-thoughts.md` — the same "don't over-reach" judgment
- `agent-patterns-in-this-codebase.md` — the single-agent inventory
