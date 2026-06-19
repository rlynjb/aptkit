# 01 — Context Engineering

*Context engineering / context assembly / "what fills the window" — Pattern +
in-codebase (the discipline is universal; AptKit's three levers are concrete
code).*

## Zoom out, then zoom in

The model's context window is the only thing it can see. Not your database, not
your codebase, not last week's run — only the bytes you put in front of it this
call. So the highest-leverage engineering decision in an agent isn't the model
and isn't the loop; it's *what you choose to put in the window.* Start by seeing
that the window is assembled from several independent sources, each of which you
control separately.

```
  Where the bytes in the context window come from (per model call)

  ┌─ SOURCES (you curate each one) ────────────────────────────────────┐
  │                                                                      │
  │  ┌─ system prompt ──────┐   renderPromptTemplate(package.system, {  │
  │  │  role + instructions │     schema, categories, intent, ... })    │
  │  │  + schemaSummary()   │   ← per-agent, rendered fresh each run     │
  │  └──────────────────────┘                                           │
  │                                                                      │
  │  ┌─ messages[] ─────────┐   the running conversation:               │
  │  │  user → assistant →  │     accumulates assistant turns +          │
  │  │  tool_result → ...   │     tool_result blocks every lap           │
  │  └──────────────────────┘   ← grows over the run (run-agent-loop:94) │
  │                                                                      │
  │  ┌─ tool results ───────┐   truncate(JSON.stringify(result))        │
  │  │  capped at 16k chars  │   ← bloat control (run-agent-loop:52)     │
  │  └──────────────────────┘                                           │
  └───────────────────────────┬──────────────────────────────────────────┘
                              ▼
                    ┌─ the context window ─┐
                    │  system + messages   │  ← all the model sees
                    └──────────────────────┘
```

The frontend instinct: this is the props of your component. The model is a pure
function `render(context) → output`. If the output is wrong, you don't blame the
function — you check the props. Context engineering is "what props do I pass,
and how do I keep them from ballooning."

## Structure pass

Trace one axis: the **lifecycle axis** — *when does each piece of context get
written, and how long does it live.* This is the seam that separates "stuff you
compute once before the loop" from "stuff that grows during the loop."

```
  The lifecycle axis: when each context piece is written

  Source           Written                    Lifetime
  ───────────────  ─────────────────────────  ───────────────────────────
  system prompt    ONCE, before the loop       constant every turn
                   (renderPromptTemplate)
  ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  ─ ─ ─ ─ ─ ─ ─ ─ ─ ◄ SEAM
  messages[]       EVERY turn (push x2)         grows, dies on return
  tool results     EVERY tool call (truncated)  embedded into messages[]
```

The seam is "computed once vs accumulated." Above it: the system prompt is
*frozen* the moment the loop starts — `renderPromptTemplate` runs before
`runAgentLoop` is even called, so the schema and category list the model sees
never change mid-run. Below it: `messages[]` is the live, growing part. This
split matters because it tells you *where* to do context work: static curation
(prompt + schema) happens up front and you can test it deterministically;
dynamic curation (truncation) happens per turn and is a guard, not a design.

## How it works

### Move 1 — the mental model

Context engineering is the **superset**. Prompt engineering, RAG, memory, and
tool outputs are not four separate disciplines — they're four *sources* feeding
one window, and engineering the context means curating all of them together
under a single budget.

```
  Context engineering is the union of four sources (PATTERN)

         prompt          RAG / retrieval      memory         tool outputs
       (instructions)   (fetched docs)     (prior turns)   (live results)
            │                  │                 │                │
            └──────────────────┴───────┬─────────┴────────────────┘
                                       ▼
                          ┌─ ONE context window ─┐
                          │  finite token budget  │
                          └───────────────────────┘
            curate all four together; they compete for the same space
```

The trap beginners fall into: optimizing the prompt in isolation while
tool-result bloat silently eats the window. They compete for the same finite
budget, so you engineer them as one thing.

### Move 2 — the three levers, one at a time

**Lever 1 — the per-agent system prompt (static, templated)**

```
  renderPromptTemplate fills {placeholders} in a frozen template

  promptPackage.system  =  "You are X. Schema:\n{schema}\nCategories:\n{categories}"
            │
            ▼  renderPromptTemplate(template, { schema, categories })
            │
  system    =  "You are X. Schema:\n<rendered schema>\nCategories:\n<list>"
            ▲
        provenance: package carries id / version / capabilityId
```

Pseudocode: `system = renderPromptTemplate(package.system, { schema, categories
})`. Each agent owns its own template and decides which variables to inject. The
prompt isn't a string literal — it's a *template + a fill step*, so the same
template renders different context per workspace.

**Lever 2 — the deterministic schema summary**

```
  schemaSummary(workspace) → a compact, bounded description of the data

  WorkspaceDescriptor (full, large)
       │  schemaSummary(workspace, { maxEvents: 20, maxEventProperties: 10 })
       ▼
  "Project: ... | Total customers: ... | Top events (capped): ... |
   Data horizon: <from> -> <to> ... ALL queries MUST land inside this window."
       ▲
   deterministic: same workspace in → same string out (no model call)
```

Pseudocode: `schema = schemaSummary(workspace)`. This is the agent's "what data
exists" context. It's a *pure renderer* — no model, no randomness — and it's
bounded (caps events, properties, customers) so a huge workspace can't blow the
window. This is RAG's cousin: instead of fetching documents, you summarize the
schema deterministically and inject it.

**Lever 3 — tool-result truncation (the bloat guard)**

```
  every tool result is capped before it enters messages[]

  tool returns { result: <maybe huge JSON> }
       │  truncate(JSON.stringify(result))
       ▼
  result.length <= 16_000 ?  keep as-is
                          :  slice(0, 16_000) + "\n...[truncated]"
       │
       ▼  pushed into messages[] as a tool_result block
```

Pseudocode: `content = result.length <= 16000 ? result : result.slice(0,16000)
+ "...[truncated]"`. Without this, one fat query result poisons the window for
every subsequent turn — the model re-reads it each lap. The cap is the
difference between "bounded context growth" and "the window fills up by turn 3."

### Move 3 — the principle

The window is finite and the model sees nothing else, so context engineering is
budget allocation: decide what each source is allowed to contribute, freeze what
can be frozen, and cap what grows. The skill is not writing a clever prompt —
it's keeping the *whole* window curated as it evolves.

## Primary diagram

The full assembly for one AptKit agent run, all three levers in place.

```
  Context assembly for one agent run

  BEFORE the loop (computed once):
    schema     = schemaSummary(workspace)              ← deterministic, bounded
    categories = formatCategoryChecklist(runnable)     ← agent-specific
    system     = renderPromptTemplate(package.system, { schema, categories })
                  └─ provenance: package.{id, version, capabilityId}

  DURING the loop (run-agent-loop.ts):
    messages = [ userPrompt ]                           ← seed (line 94)
    each turn:
      model.complete({ system, messages, tools })       ← system is constant
      push assistant(response) ─────────────────────────┐ grow
      for each tool_use:                                 │ messages[]
        result = callTool(...)                           │
        push tool_result( truncate(result, 16k) ) ──────┘ (line 162)

    ┌──────────────────────────────────────────────────────┐
    │  window each turn = system (frozen) + messages (grown) │
    └──────────────────────────────────────────────────────┘
```

The only thing that changes turn to turn is `messages[]`. The system prompt —
the most token-expensive part — is computed once and reused, which is also why
provenance (id/version) is attached: you can later prove *which* prompt produced
a given run.

## Implementation in codebase

**Use case 1 — every agent renders its own context.** The five agents share the
loop but each assembles its own window.

`packages/agents/anomaly-monitoring/src/monitoring-agent.ts:61`:

```ts
const system = renderPromptTemplate(this.prompt, {       // line 61
  schema: schemaSummary(this.options.workspace),         // ← lever 2 into lever 1
  categories: formatCategoryChecklist(categories),       // ← agent-specific context
});
```

Line 61 is the assembly point: the workspace schema is summarized and injected
into the prompt template *before* the loop runs. The same line shape repeats per
agent — `query-agent.ts:79`, `diagnostic-agent.ts:58`, `recommendation-agent.ts:71`
— each filling its own template with `schemaSummary(workspace)` plus
agent-specific variables.

**Use case 2 — the deterministic schema renderer.**
`packages/context/src/workspace-summary.ts:11`:

```ts
export function schemaSummary(workspace, options = {}) {   // line 11
  const { maxEvents = 20, maxEventProperties = 10, maxCustomerProperties = 30 } = options;
  // ...
  const eventsText = workspace.events.slice(0, maxEvents)   // ← cap: bounded context
    .map((event) => `  - ${event.name} (${event.eventCount}): ...`)
    .join('\n');
  return [`Project: ...`, `Total customers: ...`, eventHeading, eventsText, ...].join('\n');
}
```

Line 11 is a pure function — no model, no I/O — so the same workspace always
renders the same string. The `slice(0, maxEvents)` caps (lines 27, 34) are the
bound: a workspace with 5,000 events still produces a ~20-event summary. The
data-horizon line (line 62) injects `ALL queries MUST land inside this window` —
context that *steers* the model, not just describes.

**Use case 3 — tool-result truncation.**
`packages/runtime/src/run-agent-loop.ts:52` and the call at line 162:

```ts
const MAX_TOOL_RESULT_CHARS = 16_000;                     // line 52
function truncate(value: string): string {                // line 54
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}
// ... inside the tool loop:
resultContent = truncate(JSON.stringify(result));         // line 162
```

Line 162 is where every tool result passes through the cap before it's pushed
into `messages[]` (line 189). This is the only dynamic context-engineering lever
in the loop — and it's a guard, not a strategy.

**Use case 4 — provenance.** `packages/prompts/src/types.ts:13` — `PromptPackage`
carries `id`, `version`, `capabilityId`. This is context *governance*: the
replay-artifact eval (`04-agent-evaluation.md`) checks
`promptPackage.{id,version,capabilityId,templateHash,renderedHash}` so you can
prove which prompt produced which run.

**Not yet exercised: RAG / vector retrieval.** AptKit does *no* embedding-based
retrieval — "fetching context" here is tool-calling over analytics APIs plus the
deterministic schema summary, not ANN over an embedding store. If you needed
semantic retrieval of past incidents or docs, you'd add a retrieval source to
the assembly. See SECTION F (`../06-orchestration-system-design-templates/`).

**Not yet exercised: context compaction / summarization mid-run.** AptKit caps
tool results but never *summarizes* the running `messages[]` to reclaim space —
a long run just grows until the budget exits. The bound today is the turn/tool
budget, not compaction. See SECTION F.

## Elaborate

**Origin.** "Context engineering" is the 2024-25 reframing of prompt
engineering: once agents loop and accumulate tool outputs, the prompt is a small
fraction of the window, and the discipline shifts to managing the *whole* window
over time. The four-source model (prompt + retrieval + memory + tools) is the
standard mental model.

**Adjacent — lost in the middle.** Models attend best to the start and end of
the window and worst to the middle. That's *why* truncation and a frozen,
front-loaded system prompt matter: you keep the high-signal instructions at the
edges and stop low-signal tool dumps from burying them in the middle. The
mechanics of context-window limits and lost-in-the-middle are taught in
`.aipe/study-ai-engineering/`.

**Adjacent — the budgets ARE context control.** `maxTurns` and `maxToolCalls`
(`05-guardrails-and-control.md`) cap how large `messages[]` can grow — they're a
context-budget lever wearing a guardrail hat.

## Interview defense

**Q: "What's the difference between prompt engineering and context engineering?"**

```
  prompt engineering ⊂ context engineering

  prompt engineering:  craft the instruction string
  context engineering: curate the WHOLE window (prompt + retrieval +
                       memory + tool outputs) under one token budget
```

Anchor: "Prompt is one source. Context engineering is all four sources competing
for one finite window — in AptKit that's a templated prompt, a deterministic
schema summary, and a 16k tool-result cap, all curated together."

**Q: "How do you stop tool outputs from blowing your context window?"**

```
  every tool result → truncate(result, 16_000) → into messages[]
  run-agent-loop.ts:52 (cap) + :162 (applied)
```

Anchor: "I cap each tool result at 16k chars before it enters the message array,
so one fat query can't poison every subsequent turn. The turn and tool budgets
bound the rest."

**Q: "How do you keep the context deterministic enough to test?"**

```
  schemaSummary(workspace) = PURE function → same in, same out
  → system prompt is frozen before the loop → testable
```

Anchor: "The schema summary is a pure renderer with no model call, so the static
half of the window is deterministic and the prompt package carries a hash for
provenance." This is the load-bearing idea: freeze what you can, cap what grows.

## Validate

- **Reconstruct:** Draw the four context sources feeding one window, then mark
  which AptKit actually uses (prompt yes, schema-as-retrieval yes, memory =
  messages only, tool outputs yes; vector RAG no).
- **Explain:** Why is `schemaSummary` a pure function with caps instead of just
  dumping `workspace`? (`workspace-summary.ts:27,34` — bounded, deterministic,
  testable; a raw dump would be unbounded and non-reproducible.)
- **Apply:** A new agent needs the last 5 incidents as context. Which source is
  that, and where does it plug in? (a retrieval source, injected into the
  template at the `renderPromptTemplate` call like `monitoring-agent.ts:61` —
  but you'd be adding the RAG source AptKit doesn't have yet.)
- **Defend:** A teammate raises `MAX_TOOL_RESULT_CHARS` to 200k "so we never lose
  data." What breaks? (`run-agent-loop.ts:52` — one tool result fills the window;
  every later turn re-reads it; lost-in-the-middle buries the system prompt.)

## See also

- [02-agent-memory-tiers.md](02-agent-memory-tiers.md) — which context survives
  across turns (the memory subset)
- [03-tool-calling-and-mcp.md](03-tool-calling-and-mcp.md) — how the model fetches
  more context mid-run
- [05-guardrails-and-control.md](05-guardrails-and-control.md) — the budgets that
  bound how large the window can grow
- `../01-reasoning-patterns/02-agent-loop-skeleton.md` — the loop where
  `messages[]` accumulates
- `.aipe/study-ai-engineering/` — context-window limits + lost-in-the-middle
  mechanics
- `.aipe/study-prompt-engineering/` — the prompt *wording* (one source of the
  window)
