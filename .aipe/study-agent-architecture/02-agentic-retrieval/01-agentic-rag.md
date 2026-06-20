# 01 — Agentic RAG

## The loop the agent drives: query a tool, read the result, query again, then synthesize

---

## Zoom out

You have written RAG before. In AdvntrCue, "retrieval" was a single function you
called before the model spoke: embed the question, ANN-search pgvector, take the
top-k chunks, hand them to GPT-4. One hop. The model never *asked* for more — it
got one bundle of context and produced one answer.

AptKit does retrieval differently, and the difference is the entire point of
this sub-section. Here the model is *in* the retrieval loop. It calls an
analytics tool, the harness runs it, the result comes back as a message, and the
model looks at that result and decides what to fetch next. For the two agents
this file teaches — monitoring and diagnostic — there is no embedding, no vector
store, no chunking: the "store" is a set of read-only workspace analytics
endpoints. (The repo *does* now have a real vector store — the
`@aptkit/agent-rag-query` capability in `04-agentic-rag-over-vector-search.md`
runs this same loop over `nomic-embed` embeddings and ANN search. This file is
the analytics-source flavor; file 04 is the similarity-index flavor.) The
*control structure* is identical, and it is the thing the literature calls
agentic RAG: retrieval that the model steers, turn by turn, until it has enough.

```
  Where agentic-RAG sits among the agent-architecture concepts

  ┌─ Reasoning patterns (01) — the loop kernel, ReAct, routing ─────────┐
  │                                                                     │
  │   ┌─ Agentic retrieval (02) ─────────────────────────────────────┐ │
  │   │                                                               │ │
  │   │   ★ Agentic RAG ★  ── the driven loop: query → eval → query   │ │
  │   │       │              → synthesize. monitoring + diagnostic    │ │
  │   │       ├─ Self-corrective RAG — grade what you got (02)         │ │
  │   │       ├─ Retrieval routing — pick the right tool (03)          │ │
  │   │       └─ RAG over vector search — same loop, real ANN (04)     │ │
  │   └───────────────────────────────────────────────────────────────┘ │
  │                                                                     │
  ├─ Multi-agent orchestration (03) — latent pipeline ──────────────────┤
  ├─ Agent infrastructure (04) — tool policy, coverage gate ────────────┤
  └─ Production serving (05) — budgets, fallback, context guard ────────┘
```

Agentic RAG is the trunk of this sub-section. Self-corrective RAG and retrieval
routing are both refinements of *this* loop — one about grading the result, one
about choosing which tool to fire. Learn the loop first.

---

## Structure pass

There is one axis here: **who controls the next fetch.** In classic RAG, your
application code controls it (you wrote the ANN query). In agentic RAG, the model
controls it through tool calls, and your code only executes what the model asks
for and feeds the result back.

```
  The seams that make the loop work (AptKit)

  ┌────────────────────────────────────────────────────────────┐
  │  Agent wrapper        — monitoring-agent.ts / diagnostic     │
  │  (prompt + tool policy + budget + validator)                 │
  └───────────────┬──────────────────────────────────────────────┘
                  │ hands everything to ↓
  ┌───────────────▼──────────────────────────────────────────────┐
  │  runAgentLoop         — run-agent-loop.ts:76                  │
  │   for turn in 0..maxTurns:                                    │
  │     ── model.complete() ─── proposes tool calls (the query)   │  ← model controls fetch
  │     ── tools.callTool() ─── executes the analytics tool       │  ← harness executes
  │     ── push result into messages ── result becomes context    │  ← result steers next turn
  └───────────────┬──────────────────────────────────────────────┘
                  │ at budget exit ↓
  ┌───────────────▼──────────────────────────────────────────────┐
  │  Synthesis turn       — tools dropped, answer from gathered   │  ← retrieval stops, generate
  └────────────────────────────────────────────────────────────┘
```

Two seams carry the whole story. The **ModelProvider seam** (`model.complete`)
is where the model emits a *request* to retrieve. The **ToolExecutor seam**
(`tools.callTool`) is where that request actually hits an analytics endpoint.
The model never touches a tool directly — it emits intent, the harness retrieves.

---

## How it works

### Move 1 — Mental model: retrieval is a feedback loop, not a function call

The mental shift from AdvntrCue: stop thinking of retrieval as *a step before the
answer*, and start thinking of it as *a loop the answer comes out of*. Each tool
result is a new piece of state that the model reads and reacts to, the same way a
React component re-renders when state changes and the new render decides what to
fetch next.

```
  PATTERN — agentic RAG as a state-driven loop

      ┌─────────────────────────────────────────────┐
      │            messages[]  (the state)           │
      │  user q · assistant tool_use · tool_result … │
      └───────────────┬─────────────────────▲────────┘
                      │ model reads state    │ result appended
                      ▼                      │
              decide next fetch ──► run tool ┘
                      │
                      │ when "enough" OR budget spent
                      ▼
              synthesize final answer
```

The analogy that fits your head: `messages[]` is component state, `model.complete`
is the render that reads state and returns the next action (a tool call), and
`tools.callTool` is the effect that fetches and writes back to state. The loop
re-runs until the model stops asking — exactly like an effect chain that settles.

### Move 2 — Step by step

#### **Step 1 — Seed the loop with the question, not the data**

You do *not* pre-fetch context. You hand the model the question and the *menu of
tools* it may call, then let it decide what to retrieve. This is the inversion
from classic RAG.

```
  Seeding

  userPrompt ──────────────► messages = [ {role:user, content: question} ]
  tool policy ─► toolSchemas ─► passed to every model.complete() turn
```

```text
messages = [{ role: "user", content: userPrompt }]   # question only, no context
toolSchemas = filterToolsForPolicy(allTools, policy) # the retrieval menu
```

#### **Step 2 — Model proposes a retrieval (tool_use)**

Inside the `for` loop, `model.complete` runs with the tool schemas attached. The
model answers with either text (it is done) or one or more `tool_use` blocks —
each one is a retrieval request: "run `get_metric_timeseries` with these args."

```
  Turn N — propose

  model.complete(messages, tools=toolSchemas)
        │
        ▼
  response.content = [ tool_use{ name:"get_metric_timeseries", input:{…} }, … ]
        │
        ▼
  toolUses = blocks where type == "tool_use"     # the requested fetches
  if toolUses is empty → finalText = text; break # model is satisfied, stop retrieving
```

```text
toolUses = toolUsesFromContent(response.content)
if (toolUses.length === 0) { finalText = text; break }  # no fetch requested → done
```

#### **Step 3 — Harness executes the retrieval and truncates the result**

For each requested tool, the harness calls the real analytics endpoint through
the `ToolExecutor` seam, stringifies the result, and **caps it at 16k chars**
before it ever re-enters the prompt. That cap is your retrieval context-budget
control — the analytics equivalent of choosing top-k.

```
  Execute + cap

  for toolUse in toolUses:
      result = tools.callTool(name, input)     # hits analytics API
      content = truncate(JSON.stringify(result))   # ≤ 16_000 chars
      toolResults.push({ tool_result, content })
```

```text
const { result } = await tools.callTool(toolUse.name, toolUse.input)
resultContent = truncate(JSON.stringify(result))   # MAX_TOOL_RESULT_CHARS = 16_000
```

#### **Step 4 — Feed results back; the loop re-evaluates**

The tool results are pushed onto `messages` as a user turn. Next iteration,
`model.complete` sees them and decides: fetch more, or stop. **This feedback edge
is what makes it agentic** — the retrieved data changes the next retrieval.

```
  Feed back → re-evaluate

  messages.push({ role:"user", content: toolResults })
        │
        └──► next turn: model reads new evidence, queries again or stops
```

```text
messages.push({ role: "user", content: toolResults })   # results become context
# loop continues: next model.complete() reacts to what was just retrieved
```

#### **Step 5 — Budget trips, synthesis forced**

The loop cannot run forever. Two independent budgets cap it: `maxTurns` (8) and
`maxToolCalls` (6 for monitoring and diagnostic). On the last turn — or once tool
spend is exhausted — the harness **drops the tool schemas** and appends a
synthesis instruction, forcing the model to answer from what it already
retrieved instead of asking for one more query.

```
  Budget exit → synthesize

  budgetSpent = toolCalls.length >= maxToolCalls
  forceFinal  = (turn == maxTurns-1) OR budgetSpent
        │
        ▼
  model.complete(system + synthesisInstruction, tools = undefined)  # no tools → must answer
```

```text
budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls
forceFinal  = turn === maxTurns - 1 || budgetSpent
tools: forceFinal ? undefined : toolSchemas   # drop the retrieval menu on the final turn
```

### Move 3 — The principle

Agentic retrieval trades a fixed, cheap, one-hop fetch for an adaptive,
expensive, multi-hop one. The win is that the model can *follow the data*: a flat
metric makes it pivot to segments, an error in one query makes it route around
it, a surprising value makes it drill in. The cost is real — every hop is a model
round-trip plus a tool round-trip, so latency and tokens grow linearly with the
number of fetches. The discipline that makes it safe is the **bounded budget**:
you cap the number of retrievals up front and force a synthesis from whatever was
gathered when the cap trips. Unbounded agentic retrieval is a runaway bill;
bounded agentic retrieval is a controllable one. The bound is not a safety
afterthought — it is the feature that makes the loop shippable.

---

## Primary diagram

The full agentic-RAG loop as AptKit runs it, from question to synthesized answer,
with the budget gate that ends retrieval.

```
  Agentic RAG in AptKit — one capability run

  question
    │
    ▼
  messages = [user: question]            toolSchemas = policy-filtered analytics tools
    │                                          │
    ▼                                          │
  ┌─────────── for turn in 0..maxTurns ───────▼──────────────────────────┐
  │                                                                       │
  │   budgetSpent = toolCalls >= maxToolCalls   (6 for monitoring/diag)   │
  │   forceFinal  = lastTurn OR budgetSpent                               │
  │        │                                                              │
  │        ├── forceFinal? ──yes──► model.complete(+synthesis, NO tools) ─┼──► finalText
  │        │                                                              │
  │        no                                                             │
  │        ▼                                                              │
  │   model.complete(messages, tools)                                     │
  │        │                                                              │
  │        ▼                                                              │
  │   tool_use blocks?  ──none──► finalText = text; break ────────────────┼──► finalText
  │        │ yes                                                          │
  │        ▼                                                              │
  │   for each tool_use:                                                  │
  │       result = tools.callTool(name, args)    ← retrieval hits API     │
  │       content = truncate(result)             ← ≤16k chars             │
  │        │                                                              │
  │        ▼                                                              │
  │   messages.push(user: toolResults)           ← feedback edge          │
  │        │                                                              │
  │        └───────────── loop ─────────────────────────────────────────┘│
  └───────────────────────────────────────────────────────────────────────┘
                                                       │
                                                       ▼
                              parseResult(finalText) ──null?──► recoveryPrompt turn
                                                       │              │
                                                       ▼              ▼
                                                  structured    synthesize from
                                                   output         gathered evidence
```

The loop body *is* the retrieval; the synthesis turn *is* the generation. There
is no separate retriever object — retrieval and generation are the two halves of
one loop.

---

## Implementation in the codebase

Two agents make agentic RAG concrete. The monitoring agent runs a *checklist*
loop (query metrics, decide which category to check next). The diagnostic agent
runs a *hypothesis-test* loop (retrieve evidence for or against each candidate
cause).

### Use case A — Monitoring scan: checklist-driven retrieval

The monitoring agent grants four read-only retrieval tools and runs the loop with
a 6-call budget, scanning anomaly categories the workspace can actually support.

```text
packages/agents/anomaly-monitoring/src/monitoring-agent.ts
```

```ts
// :12   the retrieval menu — least-privilege grant, four analytics tools
export const anomalyMonitoringToolPolicy = {
  capabilityId: ANOMALY_MONITORING_CAPABILITY_ID,
  allowedTools: [
    'execute_analytics_eql',     // :15  ad-hoc EQL query over events
    'get_metric_timeseries',     // :16  a metric over time
    'get_segments',              // :17  segment breakdown
    'get_anomaly_context',       // :18  context around a flagged point
  ] as const,
};
```

- `:12` — `anomalyMonitoringToolPolicy` is the *whole* retrieval surface for this
  agent. The model can only fetch through these four. This is your top-k
  analogue: it bounds *what* can be retrieved, not how much.
- `:15-18` — all four are read-only analytics endpoints. No write, no vector
  search. "Retrieval" here = call one of these and read the JSON back.

```ts
// :52  pre-filter: only scan categories this workspace can support (coverage gate)
runnableCategories(): AnomalyCategory[] {
  return runnableCategories(this.categories, schemaCapabilities(this.options.workspace));
}

// :66  hand the menu + budget + validator to the loop
const { parsed } = await runAgentLoop<Anomaly[]>({
  // …
  toolSchemas,                 // :73  policy-filtered retrieval menu
  maxTurns: 8,                 // :76  loop cap
  maxToolCalls: 6,             // :77  retrieval-spend cap
  synthesisInstruction: buildSynthesisInstruction(  // :78  forced answer-from-evidence
    'Stop querying now and output your final answer. … based on the data you have already gathered.',
  ),
  parseResult: tryParseAnomalies,        // :81  structured-output validator
  recoveryPrompt: buildRecoveryPrompt,   // :82  synthesize-from-evidence fallback
});
```

- `:52` — `runnableCategories` drops checklist items the workspace cannot support
  *before* the loop runs. That is a pre-retrieval gate (covered in file 03 and
  `../04-agent-infrastructure/`); it saves tokens by never asking the model to
  query something it cannot.
- `:77` — `maxToolCalls: 6` is the hard ceiling on retrievals. After six tool
  calls the next turn is forced to synthesize.
- `:78` — `synthesisInstruction` is the "you have no more queries, answer now"
  text the loop appends on the final turn.
- `:81-82` — the loop's output is parsed into `Anomaly[]`; if parsing fails,
  `buildRecoveryPrompt` (`:103`) re-asks for the shape using gathered evidence.

```ts
// :103  recovery prompt — turn the gathered retrievals into the final answer
function buildRecoveryPrompt(toolCalls: ToolCallRecord[]): string {
  const evidence = toolCalls
    .map((call, index) =>
      `Query ${index + 1}: ${call.toolName} … Result: ${JSON.stringify(call.result).slice(0, 900)}`)
    .join('\n\n');
  return ['…Convert the evidence below into the final anomaly JSON array.', evidence, '…'].join('\n\n');
}
```

- `:103-117` — this is "synthesize from what you retrieved" made literal: it
  serializes every tool call's args and result and asks the model for the
  structured shape, no new queries allowed.

### Use case B — Diagnostic investigation: hypothesis-test retrieval

The diagnostic agent grants eleven retrieval tools and uses the same loop to
gather evidence for and against candidate causes of an anomaly.

```text
packages/agents/diagnostic-investigation/src/diagnostic-agent.ts
```

```ts
// :11  a broader retrieval menu — eleven read-only analytics tools
export const diagnosticInvestigationToolPolicy = {
  capabilityId: DIAGNOSTIC_INVESTIGATION_CAPABILITY_ID,
  allowedTools: [
    'execute_analytics_eql',          // :14
    'get_event_segmentation',         // :15
    'list_email_campaigns',           // :16  retrieve possible external causes
    'list_experiments',               // :17
    'list_scenarios',                 // :18
    'list_banners',                   // :19
    'list_customers',                 // :20
    'get_customer_prediction_score',  // :21
    'get_metric_timeseries',          // :22
    'get_segments',                   // :23
    'get_anomaly_context',            // :24
  ] as const,
};
```

- `:11-26` — a wider menu than monitoring because diagnosis must *follow the
  data* into campaigns, experiments, segments. Each entry is a place the model
  can retrieve evidence from. The loop decides which to hit and in what order.

```ts
// :64  same loop kernel, same budget — different menu and validator
const { toolCalls, parsed } = await runAgentLoop<Diagnosis>({
  userPrompt: 'Investigate the anomaly and return the diagnosis JSON object.',  // :69
  toolSchemas,
  maxTurns: 8,         // :73
  maxToolCalls: 6,     // :74
  parseResult: tryParseDiagnosis,                          // :78
  recoveryPrompt: (calls) => buildRecoveryPrompt(anomaly, calls),  // :79
});
```

- `:64` — identical `runAgentLoop` call shape as monitoring. The agentic-RAG
  loop is *one kernel*; the agents differ only in menu, prompt, and validator.
- `:84-85` — after the loop, `hadErrors = toolCalls.some(c => c.error)` *demotes*
  confidence if any retrieval failed. The quality of what was retrieved feeds the
  reported confidence — a bridge to self-corrective RAG (file 02).

---

## Elaborate

A few things that surprise people coming from one-hop RAG:

- **No retriever object exists.** Search your head for a `Retriever` class — there
  isn't one. Retrieval is `tools.callTool` inside the loop. The model *is* the
  query planner. This is why "agentic RAG" and "tool-calling agent" describe the
  same code here.
- **The 16k truncation is the only relevance filter on results.** Classic RAG
  reranks and trims to top-k. AptKit caps each tool result at 16k chars
  (`run-agent-loop.ts:52`) and trusts the model to read what matters. There is no
  reranker because there is no candidate set to rank — each tool returns exactly
  what was asked for.
- **Errors are retrieval signal, not crashes.** A failed `callTool` becomes a
  `{error}` tool result fed back to the model (`run-agent-loop.ts:163-167`), so
  the model can route around a broken tool on its next turn. A failed ANN query
  in AdvntrCue would throw; here it is just one more thing the model reads.
- **The loop usually stops early.** `maxToolCalls: 6` is the *ceiling*, not the
  target. Most runs satisfy themselves in two or three retrievals and `break` on
  a turn with no `tool_use`. The budget is the guardrail, not the plan.
- **This is ReAct.** Reason (model text) → Act (tool call) → Observe (tool
  result) → repeat. Agentic RAG is ReAct where the actions happen to be
  retrievals. See
  `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md`.

---

## Interview defense

**Q: "Walk me through how your agent does retrieval. Is it RAG?"**

> It is agentic RAG, but for these two agents the source is structured analytics
> APIs, not a vector store — no embeddings or ANN search in *this* loop. (The
> repo's `rag-query` capability does run real vector RAG; that's a separate
> agent.) The agent runs a
> bounded loop: the model proposes a read-only analytics tool call, the harness
> executes it against the workspace API, the result is truncated to 16k chars and
> fed back into the message history, and the model reads it and decides whether to
> query again or answer. It is retrieval the model steers, turn by turn, capped at
> six tool calls. When the budget trips, I drop the tool schemas and force a
> synthesis from whatever evidence was gathered.

```
  question → [ model proposes tool → harness runs it → result back ]×≤6 → synthesize
                         └──────────── model decides next fetch ───────────┘
```

**Anchor:** "Think of it like a React effect chain where each fetch writes to
state and the next render reads that state to decide the next fetch — except the
'render' is `model.complete` and the 'fetch' is an analytics tool call. The loop
settles when the model stops asking, or I cut it off at the budget."

**Follow-up — "Why not just one big query?"** Because the second query depends on
the first result. A flat top-line metric tells the model to pivot to segments; a
spike in one segment tells it to pull that segment's event breakdown. You cannot
write that as a fixed query — the data shapes the plan. The cost is more latency
and tokens per run, which is exactly why the loop is bounded.

---

## Validate

Four levels, each tied to a real file you can open.

1. **Spot it** — The loop exists and is shared. `runAgentLoop` at
   `packages/runtime/src/run-agent-loop.ts:76`; the `for (let turn = 0; turn <
   maxTurns; …)` body at `:98`. Confirm both monitoring (`monitoring-agent.ts:66`)
   and diagnostic (`diagnostic-agent.ts:64`) call it.

2. **Trace it** — Follow one retrieval. `model.complete` proposes
   (`run-agent-loop.ts:103`), `toolUsesFromContent` extracts the requests
   (`:131`), `tools.callTool` executes (`:159`), `truncate` caps (`:162`),
   `messages.push` feeds back (`:189`). That is one full retrieval hop.

3. **Bound it** — Find the cap. `MAX_TOOL_RESULT_CHARS = 16_000`
   (`run-agent-loop.ts:52`); `budgetSpent`/`forceFinal` at `:101-102`; the
   tool-schema drop at `:106`. Confirm `maxToolCalls: 6` in
   `monitoring-agent.ts:77` and `diagnostic-agent.ts:74`.

4. **Break it** — Reason about failure. If `parseResult` returns `null`, the
   recovery turn fires (`run-agent-loop.ts:195-198`) using
   `buildRecoveryPrompt` (`monitoring-agent.ts:103`,
   `diagnostic-agent.ts:100`). If a tool throws, the error becomes a tool result
   (`:163-167`) and the model continues. Verify there is no path where an empty
   retrieval crashes the run — monitoring returns `[]` (`:85`), diagnostic returns
   `FALLBACK_DIAGNOSIS` (`:82`).

---

## See also

- `02-self-corrective-rag.md` — grading what the loop retrieved (the diagnostic
  agent's hypothesis evaluation).
- `03-retrieval-routing.md` — how the model picks *which* tool to fetch from.
- `04-agentic-rag-over-vector-search.md` — the same loop over a real vector store
  (`@aptkit/agent-rag-query`), driven by a local Gemma with tool-call emulation.
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop kernel in full.
- `.aipe/study-ai-engineering/03-retrieval-and-rag/` — vector-RAG mechanics
  (embeddings, chunking, ANN) that AptKit deliberately does **not** use.
- `.aipe/study-ai-engineering/04-agents-and-tool-use/03-react-pattern.md` — the
  ReAct loop this implements.
- `../04-agent-infrastructure/03-tool-calling-and-mcp.md` — the tool seam plumbing.
