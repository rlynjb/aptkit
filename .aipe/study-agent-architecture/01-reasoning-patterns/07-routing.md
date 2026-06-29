# Routing

**Industry standard.** "Intent routing," "LLM router," "classify-then-dispatch." Type label: reasoning pattern (the bridge to multi-agent). **In this codebase: yes — the query agent's `classifyIntent` is an LLM router.**

## Zoom out, then zoom in

Routing picks the right handler *before* committing to a loop. aptkit's query agent does exactly this: it classifies a natural-language question into one of three intents, then dispatches. It's also the bridge from single-agent to multi-agent — in a single-agent system routing picks a *tool*; in a multi-agent system the same pattern picks which *agent* runs (the supervisor's core job).

```
  Zoom out — routing in aptkit's query agent

  ┌─ Caller layer ──────────────────────────────────────────┐
  │  ★ classifyIntent ★  query/src/intent.ts:13              │ ← we are here
  │  one model call → "monitoring" | "diagnostic" |          │
  │                   "recommendation"                       │
  └───────────────────────────┬──────────────────────────────┘
                              │ parseIntent maps word → route
  ┌─ Dispatch layer ──────────▼──────────────────────────────┐
  │  picks which capability/answer path handles the query     │
  └────────────────────────────────────────────────────────────┘
```

## Structure pass

**Layers:** classify → dispatch. **Axis: who decides, and how cheaply?** aptkit's router is a single 16-token model call (`intent.ts:25`) — deterministic dispatch, model-decided classification. The seam: classification is *model* judgment (handles paraphrase), dispatch is *code* (deterministic). That split is the production routing pattern — let the model handle ambiguity, let code handle the branch.

## How it works

### Move 1 — the mental model

Routing is a switch statement where the model fills in the case. You know how a form might `switch (field.type)` to pick a renderer? Same shape — except the model reads the user's natural language and returns which case to take.

```
  Routing — heuristic-first, LLM-fallback (the production pattern)

  Input
    │
    ▼
  ┌─────────────────────┐
  │ Heuristic router    │  fast, deterministic (parseIntent: substring match)
  └─────────┬───────────┘
            │ ambiguous / no clear match
            ▼
  ┌─────────────────────┐
  │ LLM router          │  classify intent, pick the handler
  └─────────────────────┘
```

### Move 2 — aptkit's two-piece router

**Piece 1 — the LLM classifier.** One tiny model call, constrained to one word, with a tight token budget so it can't ramble.

```typescript
// packages/agents/query/src/intent.ts:13
const response = await model.complete({
  system: 'Classify the user query as exactly one word: monitoring (what changed / what is new), '
        + 'diagnostic (why did something happen), or recommendation (what should I do). '
        + 'Reply with ONLY the one word.',
  messages: [{ role: 'user', content: query }],
  maxTokens: 16,   // ← can't produce more than the one word
});
```

**Piece 2 — the deterministic parser (the heuristic).** `parseIntent` maps the model's word to a route by substring match, with a safe default — so even a noisy model answer routes somewhere sane.

```typescript
// packages/agents/query/src/intent.ts:4
export function parseIntent(raw: string): Intent {
  const text = raw.trim().toLowerCase();
  if (text.includes('monitoring')) return 'monitoring';
  if (text.includes('recommendation')) return 'recommendation';
  if (text.includes('diagnostic')) return 'diagnostic';
  return 'diagnostic';   // ← default: don't crash on an off-format answer
}
```

The interesting choice is the **default to `diagnostic`** (line 10). The model might return "I think this is a diagnostic question" instead of just "diagnostic" — the substring match catches it. And if it returns garbage, it routes to diagnostic rather than throwing. That's the heuristic guarding the LLM, the production pattern in miniature: model for the ambiguous classification, code for the robust dispatch.

**The boundary condition.** A pure-LLM router with no parsing fallback breaks the first time the model returns "monitoring." or "Monitoring:" or a full sentence. `parseIntent`'s substring-match-plus-default is what makes the router survive a weak local model — the same defensive instinct as the `minTopK` floor and the Gemma retry nudge.

### Move 3 — the principle

Routing is the bridge from SECTION A to SECTION C. Here it picks an answer path; in a supervisor-worker topology the identical pattern picks which *agent* handles the request. The production shape is heuristic-at-the-front for the predictable high-volume routes, LLM-at-the-back for the ambiguous ones — and aptkit's classify-then-parse is the two-call version of that.

## Primary diagram

```
  aptkit's query router — classify then dispatch

  ┌─ NL question ────────────────────────────────────────────┐
  └───────────────────────────┬──────────────────────────────┘
                              ▼
  classifyIntent ─model call (16 tok)─► raw word    [Caller→Provider hop]
                              │
                              ▼
  parseIntent ─substring match + default─► 'monitoring' |
                                           'diagnostic' (default) |
                                           'recommendation'
                              │
                              ▼
  dispatch to the matching answer path
```

## Elaborate

Routing is the cheapest way to specialize a system without going multi-agent: instead of one giant agent that handles everything, classify first and run a focused path. aptkit's three intents (what changed / why / what to do) map onto the three analytics concerns its agents cover — so the router is also a map of the capability surface. If aptkit ever composed those agents into one multi-agent system, `classifyIntent` is exactly the supervisor's routing step, lifted unchanged.

## Interview defense

**Q: How does your query agent decide what to do?**
A two-piece router. An LLM classifier — one 16-token call constrained to a single word (monitoring/diagnostic/recommendation) — then `parseIntent`, a deterministic substring match with a safe default. The model handles the ambiguity of natural language; the code handles robust dispatch. The default-to-diagnostic is deliberate: a weak local model that returns a full sentence still routes somewhere sane instead of crashing.

```
  classify (model, ambiguity) → parseIntent (code, robust dispatch + default)
```
*Anchor: heuristic guards the LLM — same defensive pattern as the top_k floor.*

**Q: How does this become a supervisor in a multi-agent system?**
Unchanged. In single-agent it picks an answer path; in supervisor-worker the same classify step picks which worker agent runs. The router IS the supervisor's routing half — the other half is synthesis, which aptkit doesn't have yet because the agents don't compose.

## See also

- `01-chains-vs-agents.md` — the router is the chain-side step
- `03-multi-agent-orchestration/02-supervisor-worker.md` — routing as the supervisor's core job
- `02-agentic-retrieval/03-retrieval-routing.md` — the same pattern applied to picking a knowledge source
