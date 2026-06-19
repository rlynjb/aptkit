# The context window (the finite container)

**Industry names:** context window, context length, token budget · *Industry standard*

## Zoom out, then zoom in

Everything the model knows for one call has to fit in one box: the context window.
System prompt, every message, every tool schema, the room reserved for the answer —
all of it, measured in tokens, capped at a fixed number. Overflow it and the call
fails (or silently drops the oldest content, depending on the provider). AptKit
manages this box in exactly one explicit place — a guard that sits in front of the
local provider and refuses requests that won't fit.

```
  Zoom out — where window management lives

  ┌─ Agent layer ─────────────────────────────────────────────────┐
  │  builds system + messages + tool schemas (the input)           │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ runAgentLoop → truncate tool results to 16k
  ┌─ Runtime layer ────────────────▼────────────────────────────────┐
  │  messages[] grows each turn (no summarization / compaction)      │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ model.complete()
  ┌─ Provider layer ───────────────▼────────────────────────────────┐
  │  ★ ContextWindowGuardedProvider — estimate, refuse if too big ★  │ ← we are here
  └───────────────────────────────┬────────────────────────────────┘
                                   │ (only if it fits)
  ┌─ Vendor / local model ─────────▼────────────────────────────────┐
  │  the actual fixed-size window                                   │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: the context window is a fixed token budget the *entire request* must fit
inside — and the answer needs room too, so the usable input budget is smaller than
the raw window. The question this file answers: how do you keep a request from
overflowing, and what does AptKit actually do about it? Answer: estimate the input
tokens up front, reserve room for the output, and *refuse before calling* if the
sum is too big. That's the only explicit window management in the codebase — and
the honesty about what's *not* there (no summarization) is part of the lesson.

## Structure pass

**Layers.** Three touch the window: the *agent* (decides what goes in), the
*runtime loop* (truncates individual tool results, grows the message history), and
the *provider guard* (the one place that estimates and enforces the total budget).

**Axis — cost / how many tokens does this consume, and who's counting?** Trace it.
The agent doesn't count — it just assembles content. The loop counts indirectly: it
caps each tool result at 16k chars so one result can't dominate. The guard is the
only layer that counts the *total* — it sums system + messages + tool schemas and
compares against `maxTokens - outputReserve`. The token budget is enforced at
exactly one seam.

```
  One question — "who counts the tokens?"

  ┌─ agent ─────────┐  → doesn't count; assembles content
  ┌─ runtime loop ──┐  → caps each tool result (16k chars), not the total
  ┌─ provider guard ┐  → counts the TOTAL, refuses if > budget − reserve
  ┌─ model ─────────┐  → the hard physical limit (the guard protects it)
```

**Seams.** The load-bearing seam is the guard's `complete` boundary: it's a
*pre-flight check* — the estimate runs and either throws or passes the request
through *before* the underlying provider is touched. The cost axis flips there:
above it, tokens are uncounted; at it, they're counted and gated. A secondary seam
is the 16k truncation inside the loop — a per-item cap, not a total cap.

## How it works

You already know `Content-Length` and a max request body size: a server rejects a
body that's too big *before* trying to process it. The context guard is that, for
tokens — estimate the size of the request, compare against the limit, reject up
front. The twist: you also have to reserve space for the *response*, because the
output shares the same window as the input.

### Move 1 — the mental model

```
  The window — input + output share one fixed box

  ┌──────────────── maxTokens (the whole window) ────────────────┐
  │  system + messages + tool schemas        │  output reserve    │
  │  ◄────── estimated input tokens ──────►   │  ◄── 768 default ─►│
  │                                           │                    │
  │  availableInputTokens = maxTokens − outputReserve              │
  └───────────────────────────────────────────────────────────────┘
        if estimatedInput > availableInput → REFUSE (throw, don't call)
```

The reserve is the part people forget. If you fill the whole window with input,
there's no room left for the model to answer — so you carve out a fixed slice for
the output *first*, and the input has to fit in what remains.

### Move 2 — the moving parts

**Token estimation.** Bridge from a rough byte count — AptKit doesn't run a real
tokenizer; it approximates. It concatenates the system prompt, every message's
text (and tool-use/tool-result content), and every tool's name + description +
JSON schema, then divides the character count by `charsPerToken` (default 3) and
rounds up. Boundary condition: it's an *estimate*, deliberately conservative
(3 chars/token under-counts real tokens for typical English, which errs toward
refusing borderline-large requests rather than letting them through and failing at
the provider).

```
  Pattern — estimate input tokens

  text = system
       + each message's content
       + each tool's (name + description + JSON.stringify(schema))
  estimatedInputTokens = ceil(text.length / charsPerToken)   ← charsPerToken = 3
```

**The reserve subtraction.** Bridge from reserving headroom on a disk — the usable
input budget is `maxTokens - outputReserve` (reserve defaults to 768). The estimate
must fit *under* that, not under the full window. Boundary condition: set the
reserve too low and a valid-looking request leaves no room for the answer; set it
too high and you reject requests that would've fit fine. It's a tunable, and 768 is
the default floor.

```
  Pattern — the budget the input must fit under

  availableInputTokens = max(0, maxTokens − outputReserve)
  ok = estimatedInputTokens <= availableInputTokens
```

**Refuse before calling.** Bridge from a guard clause that returns early — if
`!ok`, the guard emits a `warning` trace event and *throws* `ContextWindowExceededError`
without ever calling the wrapped provider. Boundary condition: this fail-fast is
what makes the guard useful in a fallback chain — a request too big for a small
local model throws *instantly*, so the fallback chain moves on to a bigger provider
with zero wasted latency (see `../04-agents-and-tool-use/06-error-recovery.md`).

```
  Layers-and-hops — the pre-flight gate

  ┌─ caller ──────┐ complete(request)  ┌─ GuardedProvider ─┐
  │  agent/loop   │ ──────────────────►│  estimate tokens   │
  └───────────────┘                    └────────┬───────────┘
                                          ok?    │
                                  ┌──── no ───────┴──── yes ────┐
                                  ▼                             ▼
                          throw ContextWindow          ┌─ wrapped provider ─┐
                          ExceededError (no call)       │  the local model   │
                          → fallback chain tries next   └────────────────────┘
```

**The 16k tool-result cap (the loop's contribution).** Bridge from a log line
truncation — separate from the guard, the loop caps every tool result at 16,000
chars before appending it to `messages`. This stops one giant API response from
swallowing the window over the course of a multi-turn run. Boundary condition: it's
a per-result cap, not a total — many medium results across many turns still grow
the history (there's no compaction to claw that back).

### Move 2.5 — what AptKit does NOT do, and the one lever it has

```
  Comparison — present vs absent window management

  PRESENT                          ABSENT
  ──────────────────────────       ──────────────────────────────────
  pre-flight token estimate        history summarization / compaction
  (local guard, fail fast)         (messages[] only grows — §05 memory)
  output reserve (768 default)
  per-result truncation (16k)      sliding-window message eviction
  compactSystem prompt variant     automatic prompt minification
```

The one *prompt-side* lever is `compactSystem` — `PromptPackage` carries an optional
shorter system-prompt variant alongside the full `system`. It's the manual knob:
when you need a smaller prompt, you author and select a compact version. AptKit has
the field; it's not auto-swapped. There's no summarization of the *message history*
— that's the section-04 memory story (`messages` grows unbounded within a run).

### Move 3 — the principle

The window is a hard, shared budget — input and output draw from the same pool — so
manage it where it's cheapest: *before* the call, by estimating and refusing, not
after, by catching a provider error. Reserve room for the answer first; fit the
input in what's left. And know your honest position: AptKit *guards* the window
(refuse-if-too-big) and *caps* individual results, but it does not *compact* the
history — so the real defense against overflow on long runs is the budget on the
loop, not a summarizer. Naming that gap is the difference between "we manage
context" and "we have one pre-flight guard and tool-result truncation."

## Primary diagram

The full window picture: estimate, reserve, gate, with the absent layers marked.

```
  Context window management — full picture

  AGENT: assemble system + messages + tool schemas (uncounted)
        │
  RUNTIME LOOP: truncate each tool result to 16k chars (per-item cap)
        │  messages[] grows each turn — NO summarization
        ▼ model.complete()
  PROVIDER GUARD (ContextWindowGuardedProvider) — the only total-budget gate
  ┌──────────────────────────────────────────────────────────────────┐
  │  estimatedInput = ceil( (system+messages+schemas).length / 3 )     │
  │  available      = maxTokens − outputReserve (default 768)          │
  │  ok = estimatedInput <= available                                  │
  │        │ no → emit warning + throw ContextWindowExceededError       │
  │        │      (NO underlying call → fallback chain moves on)        │
  │        │ yes ▼                                                      │
  │  call wrapped provider                                             │
  └──────────────────────────────────────────────────────────────────┘

  prompt-side lever: PromptPackage.compactSystem (manual shorter variant)
```

## Implementation in codebase

**Use cases.** The guard wraps the *local* provider specifically — a small local
model has a tight window, so a large workspace schema + long tool list + multi-turn
history can blow it. The guard catches that and throws fast, letting a fallback
chain reach a bigger provider instead of failing at the local model. The 16k
truncation runs on every tool result in every agent run, so one verbose analytics
response can't dominate the context. `compactSystem` is available on every
`PromptPackage` as the manual smaller-prompt option.

**The estimate**, `packages/providers/local/src/context-window-guard.ts:91-98`:

```
  context-window-guard.ts  (lines 91-98)

  export function estimateModelRequestTokens(request, charsPerToken = 3) {
    const text = [
      request.system ?? '',                                    ← system prompt
      ...request.messages.map(messageText),                    ← every message
      ...(request.tools ?? []).map((tool) =>
        `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
    ].join('\n');                                              ← tool SCHEMAS count too
    return estimateTextTokens(text, charsPerToken);            ← ceil(len / 3)
  }
       │
       └─ tool schemas are counted, not just messages — a 49-tool allowlist
          (query agent) is real input weight. Missing this is how teams
          under-estimate and overflow.
```

**The reserve + gate**, `packages/providers/local/src/context-window-guard.ts:57-68, 73-89`:

```
  context-window-guard.ts  (lines 80-88, 57-68)

  const availableInputTokens = Math.max(0, maxTokens − outputReserve);  ← reserve room for output
  return { …, ok: estimatedInputTokens <= availableInputTokens };
  …
  async complete(request) {
    const estimate = estimateContextWindow(request, this.options);
    if (!estimate.ok) {
      this.options.trace?.emit({ type: 'warning', … });               ← visible in the trace
      throw new ContextWindowExceededError(estimate);                 ← refuse BEFORE the call
    }
    return this.provider.complete(request);                           ← only if it fits
  }
       │
       └─ the throw happens before provider.complete. That fail-fast is
          what lets the fallback chain skip a too-small provider instantly.
          Defaults: outputReserve 768, charsPerToken 3 (lines 50-51).
```

**The per-result cap**, `packages/runtime/src/run-agent-loop.ts:52-57`:

```
  run-agent-loop.ts  (lines 52-57)

  const MAX_TOOL_RESULT_CHARS = 16_000;
  function truncate(value: string): string {
    if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
    return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;  ← per-result cap
  }
       │
       └─ bounds per-observation growth so one huge tool result can't blow
          the window — but it's per-item; the history total still grows.
```

**The compact-prompt lever**, `packages/prompts/src/types.ts:13-22`:

```
  prompts/types.ts  (lines 13-22)

  export type PromptPackage = {
    id: string; version: string; capabilityId: string; description: string;
    system: string;             ← the full prompt
    compactSystem?: string;     ← OPTIONAL shorter variant for tight windows
    variables: PromptVariable[]; examples: PromptExample[];
  };
       │
       └─ the field exists; selecting it is manual. There's no automatic
          swap-to-compact-when-large logic — it's a knob, not a controller.
```

## Elaborate

The context window is the single hardest physical constraint in applied LLM work —
every other concept (RAG, summarization, chunking, memory) exists partly to fit
more useful signal into a fixed box. The two industry strategies are *don't put it
in* (retrieval, so only relevant chunks enter) and *compress what's in* (summarize
the history). AptKit does neither automatically; it does the third, cruder thing —
*refuse what won't fit* and *cap individual items* — which is the right minimal move
for single-shot agents whose input is bounded by a small schema and a tool budget.

The estimate's `charsPerToken = 3` is a pragmatic choice: real tokenizers vary by
model and running one per request is overhead. Three chars/token slightly
*under*-counts tokens for typical English (closer to 4), making the guard
conservative — it'll refuse some requests that would've squeaked in, which is the
safe direction. If you needed precision you'd swap in a real tokenizer at that seam;
the estimate is deliberately a fast approximation.

Adjacent concepts: where attention degrades *inside* a full window
(`02-lost-in-the-middle.md`), the message history that grows to fill it
(`../04-agents-and-tool-use/05-agent-memory.md`), and the fail-fast behavior that
feeds the fallback chain (`../04-agents-and-tool-use/06-error-recovery.md`).

## Project exercises

*Provenance: Phase 2 — Context and prompts (C2.x). No `aieng-curriculum.md`
present; IDs are by-phase convention.*

### Exercise — swap the estimate for a real token count (Case A)

- **Exercise ID:** `[A2.1]` Phase 2, context-window concept
- **What to build:** Replace the `charsPerToken` heuristic in
  `estimateModelRequestTokens` with an injectable tokenizer (default to the
  heuristic, allow a real one to be passed), so the guard can be precise where
  precision matters.
- **Why it earns its place:** The 3-chars/token approximation is conservative but
  blunt; near the boundary it rejects valid requests. Making the tokenizer a seam
  shows you understand the estimate/accuracy trade and where to spend the overhead.
- **Files to touch:** `packages/providers/local/src/context-window-guard.ts`,
  `packages/providers/local/test/context-window-guard.test.ts`.
- **Done when:** The guard accepts an injected tokenizer and falls back to the
  heuristic when none is given; a test compares both on the same request.
- **Estimated effort:** `1–4hr`

### Exercise — auto-select compactSystem under a budget (Case A)

- **Exercise ID:** `[A2.2]` Phase 2, prompt-size concept
- **What to build:** When an agent's estimated input would exceed the available
  budget and a `compactSystem` exists on the prompt package, automatically render
  the compact variant instead of `system` before calling.
- **Why it earns its place:** `compactSystem` exists but is never auto-used — it's
  dead weight until something selects it. Wiring the obvious controller (too big?
  use compact) turns the field into a real lever.
- **Files to touch:** `packages/agents/*/src/*-agent.ts` (prompt selection),
  `packages/providers/local/src/context-window-guard.ts` (or a selector helper),
  matching tests.
- **Done when:** A request that overflows with `system` fits with `compactSystem`,
  and the agent picks the compact variant automatically; a test proves the switch.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: How do you keep a request from overflowing the context window?**
"Estimate and refuse before the call, and reserve room for the output. I'd draw the
box:"

```
  ┌── maxTokens ──────────────────────────────────┐
  │ estimated input        │ output reserve (768)   │
  └────────────────────────┴───────────────────────┘
   input must fit under (maxTokens − reserve), else THROW (don't call)
```

"The guard sums system + messages + *tool schemas* (people forget the schemas),
estimates tokens, and if it exceeds `maxTokens - outputReserve` it throws
`ContextWindowExceededError` *before* touching the provider —
`context-window-guard.ts:60-67`. Failing fast there lets the fallback chain reach a
bigger model instantly."
*Anchor: reserve output room first; refuse before the call, not after it fails.*

**Q: Do you summarize the conversation history to fit the window?**
"No — and I'd be precise about it. AptKit *guards* (refuse-if-too-big) and *caps*
each tool result at 16k (`run-agent-loop.ts:52`), but it does not *compact* the
message history — `messages` only grows within a run. So on long runs the real
overflow defense is the loop's tool-call budget, not a summarizer. If I needed
longer runs I'd add history compaction; that's the honest next step."
*Anchor: guarding and capping are not the same as compacting — know which you have.*

## Validate

- **Reconstruct:** From memory, write the `ok` check: estimate input, subtract the
  reserve from max, compare. Check against `context-window-guard.ts:80-88`.
- **Explain:** Why does the estimate include tool schemas, not just messages
  (`context-window-guard.ts:95`)? (Tool schemas are real input tokens — a 49-tool
  allowlist is substantial weight; ignoring them under-estimates and overflows.)
- **Apply:** A local model has `maxTokens: 4096`, reserve 768, and a request
  estimates 3500 input tokens. Does it pass? (Available = 4096 − 768 = 3328; 3500 >
  3328 → refuse, throw, fallback. `context-window-guard.ts:81-87`.)
- **Defend:** Why cap each tool result at 16k chars rather than the total context
  (`run-agent-loop.ts:52`)? (A per-item cap stops any single result from dominating
  cheaply, inline as results arrive; a total cap would need history compaction,
  which AptKit doesn't have.)

## See also

- [02-lost-in-the-middle.md](02-lost-in-the-middle.md) — attention drop inside a full window
- [03-prompt-chaining.md](03-prompt-chaining.md) — keeping each prompt small by splitting jobs
- [../04-agents-and-tool-use/05-agent-memory.md](../04-agents-and-tool-use/05-agent-memory.md) — the message history that fills the window
- [../04-agents-and-tool-use/06-error-recovery.md](../04-agents-and-tool-use/06-error-recovery.md) — fail-fast feeding the fallback chain
- [../01-llm-foundations/06-token-economics.md](../01-llm-foundations/06-token-economics.md) — what the tokens in the window cost
