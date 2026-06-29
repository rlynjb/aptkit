# Routing

**Industry term:** routing / intent classification (pick the handler before committing to a loop). *Industry standard.*

## Zoom out, then zoom in

Pick the right handler before you run a loop. In a single-agent system, routing picks a tool; in a multi-agent system, the same pattern picks which *agent* handles the request — which is the supervisor's core job. aptkit has a real instance of this in the query agent.

```
  Zoom out — routing lives at the front of the query capability

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  query agent: classifyIntent() ─► route to a handler         │ ← we are here
  │  (monitoring / diagnostic / recommendation)                  │
  └───────────────────────────────┬──────────────────────────────┘
                                   │ then the agent loop runs
  ┌─ Runtime layer ─────────────────▼───────────────────────────┐
  │  the agent loop skeleton                                      │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: aptkit's query agent (`packages/agents/query/src/intent.ts`) uses an LLM router to classify a natural-language question into one of three intents, with a deterministic parser turning the model's word into an enum. It's a clean two-tier router — and it's the bridge from this sub-section to multi-agent orchestration.

## The structure pass

**Layers.** A fast deterministic tier (parse the model's word) over the model tier (classify intent).

**Axis: control — who decides the route?** A heuristic decides when the input is unambiguous; the model decides when it isn't.

```
  "who decides the route?" — traced across the two tiers

  ┌─ heuristic tier ─┐   seam    ┌─ model tier ──────┐
  │ string match     │ ═══╪═════► │ classify intent   │
  │ (deterministic)  │ (it flips) │ (model-decided)   │
  └──────────────────┘           └───────────────────┘
```

**The seam.** The boundary between deterministic matching and model classification. aptkit actually inverts the textbook order here — see the walkthrough.

## How it works

**Use case in aptkit:** the query agent. A user asks a free-text question; the agent must route it to the right analytical lens (what changed / why / what to do) before answering.

### Move 1 — the mental model

It's a `switch` statement where the case is decided by a model instead of by your code. You know the handlers; you just need to pick one. The fast path is a string match; the slow path asks a model to classify.

```
  Input
    │
    ▼
  ┌─────────────────────┐
  │ Heuristic router    │ fast, deterministic
  │ (regex, rules)      │
  └─────────┬───────────┘
            │ no clear match
            ▼
  ┌─────────────────────┐
  │ LLM router          │ classify intent, pick
  │ (model-decided)     │ the handler/agent/tool
  └─────────────────────┘
```

### Move 2 — the walkthrough

**aptkit's router runs the tiers in the other order — and that's deliberate.** The model classifies first, then a deterministic parser turns its word into an enum:

```ts
// intent.ts:12 — model classifies the intent
const response = await model.complete({
  system: 'Classify the user query as exactly one word: monitoring (what changed / what is new), '
        + 'diagnostic (why did something happen), or recommendation (what should I do). '
        + 'Reply with ONLY the one word.',
  messages: [{ role: 'user', content: query }],
  maxTokens: 16,           // ← tiny budget; this is a cheap classify, not a loop
});
// intent.ts:4 — deterministic parse with a safe default
export function parseIntent(raw: string): Intent {
  const text = raw.trim().toLowerCase();
  if (text.includes('monitoring')) return 'monitoring';
  if (text.includes('recommendation')) return 'recommendation';
  if (text.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';     // ← the floor: a garbled model reply still routes
}
```

Two things to notice. First, `maxTokens: 16` — routing is a *cheap* single call, not an agent loop. You don't spend loop budget to pick a handler. Second, `parseIntent` is the deterministic guard *after* the model: it tolerates a messy reply (`"monitoring."`, `"Monitoring intent"`) via substring match, and defaults to `diagnostic` when the model says something off-script. That default is the load-bearing part — it means a weak model's garbled output still routes somewhere sane instead of throwing.

**The textbook order vs aptkit's.** Textbook routing puts the cheap deterministic tier *first* (regex catches high-volume predictable routes) and the model *behind* it for ambiguous ones. aptkit puts the model first because the routes are all natural-language intents with no clean regex — there's no "high-volume predictable" route to short-circuit. The deterministic tier here is a *normalizer + floor*, not a front-line filter. Name the difference: aptkit's heuristic tier guards the model's output rather than pre-empting the model.

**Routing as the bridge to multi-agent.** This same pattern is what a supervisor uses to pick a worker. `classifyIntent` picks an intent; a supervisor would pick an *agent*. aptkit stops at intent-picks-handler because it's single-agent — there's no second agent to route *to*. That's the seam where this sub-section hands off to SECTION C.

### Move 3 — the principle

Route before you loop, and route cheap. The production pattern is heuristic-at-the-front for predictable high-volume routes, model-at-the-back for ambiguous ones — but invert it (model first, deterministic floor behind) when there's no clean heuristic to pre-empt the model, as aptkit does. Either way, the deterministic guard with a safe default is what keeps a weak model's bad classification from breaking the route.

## Primary diagram

```
  aptkit's query-agent router — model first, deterministic floor

  free-text question
        │
        ▼
  ┌──────────────────────────────┐
  │ classifyIntent (model)        │  maxTokens: 16, cheap single call
  │ "monitoring|diagnostic|       │
  │  recommendation" (one word)   │
  └──────────────┬────────────────┘
                 │ raw word (possibly messy)
                 ▼
  ┌──────────────────────────────┐
  │ parseIntent (deterministic)   │  substring match
  │ default → 'diagnostic'        │  ← the floor against a garbled reply
  └──────────────┬────────────────┘
                 ▼
       handler for that intent runs
```

## Elaborate

Routing is the cheapest high-leverage pattern in agent design: a tiny classify call up front saves a wrong-handler loop downstream. The two-tier shape (deterministic + model) is everywhere — spam filters, support-ticket triage, query planners. aptkit's inversion (model first because no clean regex exists) is the honest adaptation when the inputs don't have a predictable surface. The same pattern scales straight into a supervisor's worker-selection, which is why it sits at the SECTION A → SECTION C seam.

## Interview defense

**Q: How does aptkit route a natural-language query?**

A two-tier router: a cheap model call (`maxTokens: 16`) classifies the query into one of three intents, then a deterministic `parseIntent` normalizes the reply and defaults to `diagnostic` if the model goes off-script.

```
  question → model classify (cheap) → deterministic parse + default floor → handler
```

I'd note it inverts the textbook order — model first, deterministic guard behind — because the intents have no clean regex to pre-empt the model with. The default-to-diagnostic floor is what makes it safe against a weak model.

*Anchor: route cheap, and put a deterministic floor with a safe default behind the model so a garbled classification still routes somewhere sane.*

## See also

- [02-agent-loop-skeleton.md](02-agent-loop-skeleton.md) — what runs after the route is picked.
- [../02-agentic-retrieval/03-retrieval-routing.md](../02-agentic-retrieval/03-retrieval-routing.md) — the same pattern applied to picking a knowledge source.
- [../03-multi-agent-orchestration/02-supervisor-worker.md](../03-multi-agent-orchestration/02-supervisor-worker.md) — routing as a supervisor's worker-selection.
