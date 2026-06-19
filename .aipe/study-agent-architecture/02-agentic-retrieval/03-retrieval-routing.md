# 03 — Retrieval Routing

## Sending the query to the right source — which in AptKit means picking the right tool

---

## Zoom out

A retrieval router answers one question: *given this query, where do I look?* In
a system with several kinds of sources — a vector store for docs, SQL for
records, a web search for fresh facts — the router classifies the query and sends
it to the source most likely to answer it. That is *multi-source-type* routing,
and it is the textbook picture.

AptKit's situation is narrower and you should be precise about it. There is **one
source type**: read-only workspace analytics APIs. There is **no router
component** — no classifier, no dispatch table, no "if question is about
campaigns, use source X." Instead, the *model* picks which of ~35 analytics tools
to call, inside the agentic-RAG loop, based on the question. That is routing —
real routing, with real consequences — but it is **implicit** (the model does it
turn by turn) and **single-source-type** (every choice is an analytics tool).
What sits *in front* of the loop is not a router but the **coverage gate**, which
pre-filters which retrieval *tasks* are runnable before any tokens are spent.

```
  Where routing lives in AptKit — and where it doesn't

  ┌─ Agentic retrieval (02) ──────────────────────────────────────────┐
  │                                                                    │
  │   Agentic RAG (01) ── the loop                                     │
  │   Self-corrective RAG (02) ── grade the result                     │
  │                                                                    │
  │   ★ Retrieval routing (03) ★                                       │
  │     ├─ classic: query → ROUTER → {vector | SQL | web}   ✗ not here │
  │     ├─ AptKit:  query → model picks tool among ~35       ◄ implicit│
  │     └─ AptKit:  coverage gate pre-filters runnable tasks ◄ real    │
  └────────────────────────────────────────────────────────────────────┘
```

So this file teaches two real things AptKit does — implicit tool routing and the
coverage gate — and is honest that the classic multi-source router is absent.

---

## Structure pass

Routing in AptKit happens on two axes at two different times. The **coverage
gate** runs *before* the loop and answers "is this retrieval task even runnable
in this workspace?" The **model's tool choice** runs *during* the loop and
answers "which tool fetches the evidence I need next?"

```
  Two routing seams, two timings

  BEFORE the loop (deterministic, code)        DURING the loop (model, per turn)
  ─────────────────────────────────────        ────────────────────────────────
  coverage gate                                 model picks a tool
       │                                             │
  runnableRequirements(tasks, capabilities)     model.complete(question, toolSchemas)
       │                                             │
       ├─ requires tokens present? ──► keep         ├─ "campaign question" → list_email_campaigns
       └─ tokens absent?           ──► DROP          ├─ "metric over time"  → get_metric_timeseries
                                                     └─ "ad-hoc"            → execute_analytics_eql
       │                                             │
       ▼                                             ▼
  fewer tasks reach the model                   one source type, model chooses tool
```

The coverage gate is the deterministic pre-router: it never reads the *question*,
only the *workspace schema*, and it prunes whole tasks. The model's tool choice
is the soft router: it reads the question and the running evidence, and picks a
tool each turn. Neither routes across *source types* — there is only one.

---

## How it works

### Move 1 — Mental model: routing is a switch, and AptKit splits it in two

You know routing from the frontend: a route table maps a URL to a component, and
a guard decides whether you are even allowed onto that route. AptKit's retrieval
routing has the same two halves — a guard and a switch — but the switch is soft.

```
  PATTERN — guard then switch

  request (question + workspace)
        │
        ▼
  [ GUARD ]  coverage gate — is this retrieval task runnable here?
        │
        ├─ no  ──► drop the task, never reach the model
        └─ yes ──► task is on the menu
                     │
                     ▼
              [ SWITCH ]  model picks which tool to call
                     │
                     ├─ list_dashboards
                     ├─ execute_analytics_eql
                     └─ get_event_segmentation … (one of ~35)
```

The guard is a hard route filter in code (it cannot be talked out of dropping a
task whose data is missing). The switch is a soft route the model performs by
emitting a `tool_use` — no `switch` statement, no router class, just the model
choosing from the schemas it was handed.

### Move 2 — Step by step

#### **Step 1 — Build the workspace capability set**

Routing needs to know what the workspace *has*. `schemaCapabilities` flattens the
workspace's events, event properties, and catalogs into a set of tokens — the
vocabulary every coverage check is measured against.

```
  Capabilities

  workspace { events, properties, catalogs }
        │
        ▼
  schemaCapabilities ──► Set{ "purchase", "purchase.revenue", "catalog:products", … }
```

```text
capabilities = Set()
for event in events:   capabilities.add(event.name); for p in event.properties: add(`${event.name}.${p}`)
for catalog in catalogs: capabilities.add(`catalog:${catalog.name}`)
```

#### **Step 2 — Gate: drop retrieval tasks whose data is absent**

`runnableRequirements` is the pre-loop router. Each task declares what tokens it
`requires`; if the workspace lacks them, the task is dropped *before* the model
spends a single token trying to retrieve for it.

```
  Gate (runnableRequirements)

  for task in tasks:
      coverage = requirementCoverage(task, capabilities)
      keep task unless coverage == "unavailable"      ← hard drop
        │
        ▼
  runnable tasks ──► reach the model
  dropped tasks  ──► never asked
```

```text
runnableRequirements(tasks, capabilities) =
  tasks.filter(t => requirementCoverage(t, capabilities) !== 'unavailable')
```

#### **Step 3 — Classify coverage: full / limited / unavailable**

The gate's verdict is three-valued. `requirementCoverage` returns `unavailable`
if a required token is missing, `limited` if an *enriching* token is missing, and
`full` otherwise. Only `unavailable` causes a drop; `limited` still runs, just
with a noted gap.

```
  Classify (requirementCoverage)

  all requires present? ──no──► "unavailable"   (drop)
        │ yes
  all enriches present? ──no──► "limited"        (run, degraded)
        │ yes
        └──────────────────────► "full"          (run, complete)
```

```text
if (!requires.every(d => capabilities.has(d)))  return 'unavailable'
if (enriches?.length && !enriches.every(d => capabilities.has(d))) return 'limited'
return 'full'
```

#### **Step 4 — Switch: the model picks the tool inside the loop**

Now the soft route. The agent hands the model a policy-filtered list of analytics
tools, and `model.complete` returns a `tool_use` choosing one. The choice depends
on the question and the evidence gathered so far — there is no code mapping
question-type to tool.

```
  Switch (inside runAgentLoop)

  toolSchemas = filterToolsForPolicy(allTools, policy)   ← the route table (the menu)
        │
        ▼
  model.complete(question, toolSchemas)
        │
        ▼
  tool_use{ name: "get_event_segmentation" }   ← the route taken, model's choice
```

```text
toolSchemas = filterToolsForPolicy(allTools, queryToolPolicy)   # ~35 tools for the query agent
# model.complete returns tool_use blocks — the model's routing decision, per turn
```

### Move 3 — The principle

Routing is about *not wasting effort on the wrong source*, and it pays off
earliest when it runs cheapest. The deepest principle here: **gate
deterministically before you route probabilistically.** A hard, schema-driven
filter that drops impossible tasks costs nothing per task and never hallucinates;
a model picking a tool from a menu is flexible but costs a round-trip and can
choose wrong. Put the cheap, certain filter first so the expensive, fuzzy chooser
only ever sees viable options. The second principle is about *surface area*: the
fewer source *types* you have, the less you need an explicit router — collapse
"where do I look?" into "which tool do I call?" and the model's native
tool-selection becomes your router for free. The price is that you give up
explicit, inspectable routing logic; the win is you delete a component and let
the model's judgment do the dispatch.

---

## Primary diagram

The full routing picture: deterministic gate in front, model-driven tool choice
inside the loop, one source type throughout, with the classic multi-source router
drawn as the explicitly-absent piece.

```
  Retrieval routing in AptKit

  question + workspace
        │
        ▼
  ┌─ PRE-LOOP GATE (coverage-gate.ts, deterministic) ──────────────────┐
  │  schemaCapabilities(workspace) ─► Set of tokens                     │
  │  runnableRequirements(tasks, capabilities):                         │
  │     requirementCoverage ─► full | limited | unavailable             │
  │        unavailable ──► DROP task (no tokens spent)                   │
  └───────────────┬─────────────────────────────────────────────────────┘
                  │ runnable tasks only
                  ▼
  ┌─ IN-LOOP SWITCH (runAgentLoop, model-driven) ──────────────────────┐
  │  toolSchemas = filterToolsForPolicy(allTools, policy)   ~35 tools   │
  │        │                                                            │
  │        ▼                                                            │
  │  model.complete(question, toolSchemas) ─► tool_use{ name }          │
  │        │                                                            │
  │        ├─ list_dashboards                                           │
  │        ├─ execute_analytics_eql                                     │
  │        └─ get_event_segmentation …   (model chooses, per turn)      │
  └───────────────┬─────────────────────────────────────────────────────┘
                  │
                  ▼
        ONE source type: workspace analytics APIs

  ┌─ NOT PRESENT ──────────────────────────────────────────────────────┐
  │  classic router:  query ─► classifier ─► { vector | SQL | web }     │
  │  AptKit has no multi-source-type router; one source, model picks tool│
  └─────────────────────────────────────────────────────────────────────┘
```

Read it top to bottom as cost order: free deterministic gate, then a model
round-trip per tool choice, all inside one source type.

---

## Implementation in the codebase

Two places make routing real: the coverage gate (deterministic, pre-loop) and the
query agent's tool policy (the menu the model routes within).

### Use case A — Coverage gate: deterministic pre-routing

The coverage gate decides which retrieval tasks are runnable *before* the loop,
purely from workspace metadata.

```text
packages/tools/src/coverage-gate.ts
```

```ts
// :38  the classifier — three-valued coverage from required/enriching tokens
export function requirementCoverage(
  requirement: CoverageRequirement,
  capabilities: ReadonlySet<string>,
): CoverageLevel {
  if (!requirement.requires.every((d) => capabilities.has(d))) return 'unavailable';   // :42  hard miss
  if (requirement.enriches?.length && !requirement.enriches.every((d) => capabilities.has(d)))
    return 'limited';                                                                  // :43  soft miss
  return 'full';                                                                       // :44
}

// :73  the gate — drop unavailable tasks before spending model tokens
export function runnableRequirements<T extends CoverageRequirement>(
  requirements: readonly T[],
  capabilities: ReadonlySet<string>,
): T[] {
  return requirements.filter((r) => requirementCoverage(r, capabilities) !== 'unavailable');  // :77
}
```

- `:38` — `requirementCoverage` is the routing predicate. It never reads the
  question — only the workspace schema vs the task's declared `requires`.
- `:42` — a missing *required* token means the task cannot run at all →
  `unavailable`. This is the hard route filter.
- `:43` — a missing *enriching* token means the task runs degraded → `limited`. It
  still routes through, just with a noted gap.
- `:73-77` — `runnableRequirements` is the pre-loop gate: filter to tasks that are
  not `unavailable`. This is the cheapest, most certain routing in the system —
  zero model calls, zero hallucination risk.

```ts
// :23  build the capability vocabulary the gate measures against
export function schemaCapabilities(source: CapabilityDescriptorSource): Set<string> {
  const capabilities = new Set<string>();
  for (const event of source.events ?? []) {
    capabilities.add(event.name);                                  // :26
    for (const property of event.properties ?? []) capabilities.add(`${event.name}.${property}`);  // :28
  }
  for (const catalog of source.catalogs ?? []) capabilities.add(`catalog:${catalog.name}`);  // :32
  return capabilities;
}
```

- `:23-34` — flattens the workspace into the token set every coverage check reads.
  This is the routing *input*: the system knows what it can retrieve before it
  tries.

The monitoring agent wires this gate in directly:

```text
packages/agents/anomaly-monitoring/src/monitoring-agent.ts:52
```

```ts
runnableCategories(): AnomalyCategory[] {
  return runnableCategories(this.categories, schemaCapabilities(this.options.workspace));
}
```

- `:52` — the scan only checks anomaly categories the workspace supports. A
  category needing an event the workspace lacks is dropped here, never routed to
  the model.

### Use case B — Query agent: the model routes within ~35 tools

The query agent is the clearest case of implicit, single-source-type routing. It
hands the model ~35 read-only analytics tools and lets the model pick.

```text
packages/agents/query/src/query-agent.ts
```

```ts
// :10  the route table is just the tool menu — ~35 read-only analytics tools
export const queryToolPolicy = {
  capabilityId: QUERY_CAPABILITY_ID,
  allowedTools: [
    'list_dashboards', 'get_dashboard', 'list_trends', 'get_trend',     // :13-16
    'list_funnels', 'get_funnel', /* … */                               // :17
    'execute_analytics', 'execute_analytics_eql',                       // :23-24  ad-hoc query path
    'get_event_segmentation', 'list_customers',                         // :28-29
    'list_email_campaigns', 'list_experiments', 'list_scenarios',       // :31-35
    'get_metric_timeseries', 'get_segments', 'get_anomaly_context',     // :46-48
  ] as const,
};
```

- `:10-50` — every entry is a route the model *may* take. There is no code
  classifying "this is a dashboard question, call `list_dashboards`." The model
  reads the question and chooses. All ~35 are the *same source type* — workspace
  analytics — so this is intra-source routing, not cross-source.

```ts
// :85  the switch in action — model picks tools inside the loop, no explicit router
const { finalText } = await runAgentLoop({
  userPrompt: question,                                       // :90  the thing being routed
  toolSchemas,                                                // :85→77  the policy-filtered menu
  maxToolCalls: 6,                                            // :95
  synthesisInstruction: buildSynthesisInstruction(
    'Now answer the user question directly and concisely in plain prose, citing the key numbers you found.',
  ),
});
```

- `:77` — `filterToolsForPolicy(allTools, queryToolPolicy)` produces the menu.
  That filter *is* the route table — it bounds where the model may route.
- `:90` — the question is the input to routing. The model's first `tool_use`
  inside `runAgentLoop` is its routing decision.
- `:95` — even routing is budgeted: at most six tool choices before synthesis is
  forced.

---

## Elaborate

- **"Implicit" is a strength here, not a hedge.** With one source type, an
  explicit router would be a `switch` the model could second-guess. Letting the
  model emit `tool_use` directly *is* the router, and it adapts to phrasing no
  hand-written classifier would catch. The cost: routing logic is now inside the
  model, not inspectable in code — you debug it by reading the trace, not the
  router.
- **The gate routes on data, the model routes on intent.** Two different inputs.
  The coverage gate never sees the question; it routes on what the workspace
  *has*. The model never sees the workspace schema as a filter; it routes on what
  the question *wants*. They compose: the gate shrinks the world, the model
  navigates what's left.
- **`limited` vs `unavailable` is the routing nuance most people miss.** A
  `limited` task still runs — the gate routes it through with a noted gap, trusting
  the model to retrieve what it can. Only `unavailable` is a hard stop. That
  three-valued logic (`coverage-gate.ts:38`) is more than a boolean filter.
- **What it would take to add multi-source routing.** If AptKit grew a second
  source type — say, a vector store of support docs alongside the analytics APIs —
  *then* you'd want an explicit router to classify "analytics question vs docs
  question" before the loop, because the model can't tool-pick across a boundary
  it doesn't know exists. Today there's one boundary, so there's no router. Name
  that condition precisely; it's the honest scope line.

---

## Interview defense

**Q: "How does your agent decide where to retrieve from?"**

> Two layers, and only one of them is a router in the usual sense. Before the loop,
> a deterministic coverage gate drops any retrieval task whose required
> workspace tokens are absent — it reads the schema, not the question, and it
> hallucinates nothing. Inside the loop, the model picks which of about 35
> read-only analytics tools to call, based on the question and the evidence so
> far. That's real routing, but it's implicit — the model's tool selection is the
> dispatch — and it's single-source-type: every tool is a workspace analytics API.
> There is no classic multi-source router choosing between a vector store, SQL,
> and web, because there's only one source type. If a second type existed, that's
> exactly where I'd add an explicit router.

```
  question+workspace → [coverage gate: drop unavailable] → [model picks tool ×≤6] → answer
                         deterministic, schema-driven        soft, question-driven
                              (the guard)                       (the switch)
```

**Anchor:** "It's a route guard plus a soft switch. The coverage gate is the
guard — like a route guard that blocks you from a page whose data doesn't load.
The model's tool choice is the switch — except instead of a route table mapping
URL to component, the model maps question to tool at runtime. One source type, so
no cross-source router needed."

---

## Validate

1. **Spot it** — Two routing seams. Deterministic gate:
   `requirementCoverage` (`packages/tools/src/coverage-gate.ts:38`) and
   `runnableRequirements` (`:73`). Soft switch: the tool menu at
   `packages/agents/query/src/query-agent.ts:10-50`, handed to the loop at
   `:85`. Confirm there is *no* file that classifies a question to a source type.

2. **Trace it** — Follow both inputs. Gate: `schemaCapabilities`
   (`coverage-gate.ts:23`) → `requirementCoverage` (`:42-44`) →
   `runnableRequirements` filter (`:77`) → consumed by
   `monitoring-agent.ts:52`. Switch: `question` (`query-agent.ts:90`) +
   `toolSchemas` (`:77`) → `runAgentLoop` → model `tool_use`.

3. **Bound it** — The gate's drop is hard and free: only `unavailable` is dropped
   (`coverage-gate.ts:77`), `limited` still runs (`:43`). The switch is budgeted:
   `maxToolCalls: 6` (`query-agent.ts:95`) caps routing decisions per run. The
   menu is bounded by policy (`filterToolsForPolicy`, `:77`).

4. **Break it** — Reason about scope. Because routing is single-source-type, a
   question needing a source AptKit doesn't have (e.g. free-text docs) has no
   route — the model can only pick analytics tools (`query-agent.ts:10-50`) and
   will either answer from analytics or fall back to `FALLBACK_ANSWER` (`:65`).
   Verify the model cannot route outside its policy menu: `filterToolsForPolicy`
   is the only source of `toolSchemas`.

---

## See also

- `01-agentic-rag.md` — the loop the in-loop switch runs inside.
- `02-self-corrective-rag.md` — grading the retrieval the router selected.
- `../01-reasoning-patterns/07-routing.md` — routing as a general reasoning
  pattern in this repo.
- `../04-agent-infrastructure/03-tool-calling-and-mcp.md` — the tool policy and
  schema-filtering plumbing the menu is built from.
- `.aipe/study-ai-engineering/03-retrieval-and-rag/` — classic multi-source and
  query routing in the vector-retrieval setting AptKit does not use.
