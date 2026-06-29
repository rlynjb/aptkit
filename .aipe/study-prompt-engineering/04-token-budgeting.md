# 04 — Token budgeting and context window management

**Industry name:** context window management / token budgeting — *Industry standard*

## Zoom out, then zoom in

The chain that worked fine in the demo and fell over in production almost always
fails the same way: nobody counted tokens. Small inputs fit; then a real
workspace shows up with a 40-table schema, the prompt blows past the window, and
the model either truncates silently or the call times out. **Token counting is
not optional — it's basic hygiene, the thing that separates amateur from
professional prompt work.** You allocate a budget: system prompt, retrieved
context, history, response — and you defend the boundaries in code.

Here's where token pressure shows up in this repo.

```
  Zoom out — where tokens get spent and bounded

  ┌─ Authoring ───────────────────────────────────────────────┐
  │  PromptPackage.system (big) + compactSystem? (budget cut)  │
  │  schemaSummary() — context renderer, the variable cost     │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Runtime (the budget defenses) ─▼──────────────────────────┐
  │  ★ run-agent-loop.ts: maxTokens, maxToolCalls, maxTurns ★   │ ← we are here
  │  ★ truncate() tool results @ 16_000 chars ★                │
  │  generateStructured: maxTokens                             │
  └───────────────────────────┬────────────────────────────────┘
  ┌─ Provider ────────────────▼────────────────────────────────┐
  │  ★ local provider: context-window GUARD ★                  │
  │  usage-ledger.ts: inputTokens/outputTokens accounting      │
  └──────────────────────────────────────────────────────────────┘
```

Zoom in: the budget isn't one number, it's a set of caps spread across the loop —
`maxTokens` on the response, `maxToolCalls` on the retrieval fan-out, `maxTurns`
on the conversation, and a hard `truncate()` on tool results. Each cap defends a
different slice of the window.

## The structure pass

**Layers:** the static prefix (system + schema, sent every call) → the growing
middle (history + tool results, accumulates per turn) → the response (bounded by
`maxTokens`).

**Axis — what consumes the window, and does it grow?** This is the axis that
exposes the danger:

```
  Axis: "does this token cost grow per turn?" — traced down

  ┌──────────────────────────────────────────┐
  │ system + {schema} prefix                  │  → FIXED per call (but re-sent)
  └──────────────────────────────────────────┘
      ┌──────────────────────────────────────┐
      │ messages[] history + tool results     │  → GROWS every turn  ⚠
      └──────────────────────────────────────┘
          ┌──────────────────────────────────┐
          │ response                          │  → bounded by maxTokens
          └──────────────────────────────────┘

  the GROWING middle is where windows blow — that's the seam to defend
```

**Seam:** the per-turn append in the loop (`run-agent-loop.ts:124` and `:189`).
Every turn pushes the assistant message *and* the tool results back onto
`messages[]`. That's the accumulator that silently grows toward the window
ceiling. The defenses — `truncate()` (`:54`), `maxToolCalls` (`:101`),
`maxTurns` (`:87`) — all exist to keep that growing middle bounded. **What breaks
without them:** a loop that searches 10 times stacks 10 tool results into the
context and the 11th call exceeds the window.

## How it works

### Move 1 — the mental model

You already manage a fixed budget when you paginate an API: you have a page size,
and you don't fetch 10,000 rows into memory just because you can. The context
window is the same fixed budget. You decide how much goes to instructions, how
much to retrieved context, how much you reserve for the answer — and you cap the
things that grow.

```
  Pattern — the context window as a budget

  ┌──────────── total window (model-specific) ────────────┐
  │ system+schema │  retrieved context  │ history │ resp.  │
  │  (prefix,     │  (tool results,     │ (turns, │ (cap:  │
  │   re-sent)    │   truncate@16k)     │ maxTurns│ maxTok)│
  └───────────────┴─────────────────────┴─────────┴────────┘
  the 80% rule: stay under ~80% — if you're at the ceiling,
  you're one model change (smaller window) away from breaking
```

### Move 2 — walking the budget defenses

**Cap 1 — the response: `maxTokens`.** `runAgentLoop` defaults `maxTokens = 4096`
(`run-agent-loop.ts:87`); `generateStructured` passes its own
(`structured-generation.ts:70`). The intent classifier sets `maxTokens: 16`
(`intent.ts:22`) — it returns one word, so it reserves almost nothing for the
response. **What breaks without a sane cap:** either you reserve too little and
the answer truncates mid-JSON (breaking the parser, concept 02), or too much and
you starve the input.

**Cap 2 — tool results: `truncate()`.** This is the most concrete defense in the
repo:

```
  Inline annotation — run-agent-loop.ts:52 truncate

  const MAX_TOOL_RESULT_CHARS = 16_000;          ← hard ceiling per tool result
  function truncate(value: string): string {
    if (value.length <= MAX_TOOL_RESULT_CHARS)
      return value;
    return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;  ← visible, not silent
  }
  // applied to EVERY tool result before it re-enters messages[] (:162, :167)
```

A `search_knowledge_base` call that returns a huge chunk can't dump 50k chars
into the growing middle — it's clipped to 16k with a visible `[truncated]`
marker. **The boundary condition done right:** the truncation is *visible* to the
model, so it knows the result was cut rather than silently reasoning over partial
data.

**Cap 3 — the fan-out: `maxToolCalls`.** The rag-query agent sets
`maxToolCalls: 4` (`rag-query-agent.ts:76`). The loop checks `budgetSpent` when
`toolCalls.length >= maxToolCalls` (`run-agent-loop.ts:101`) and forces a final
answer. **What breaks without it:** a model that keeps searching stacks unbounded
tool results into the window.

**Cap 4 — the conversation: `maxTurns`.** Default 8 (`:87`), rag-query uses 6.
`forceFinal` triggers on the last turn (`:102`). This bounds the number of
history rounds, which bounds the accumulated `messages[]`.

**Cap 5 — the provider guard.** The `local` provider is explicitly a
context-window guard (per the repo's provider set) — a provider-layer check
that fails before a request exceeds the window, rather than letting the model
truncate. And `usage-ledger.ts` accounts `inputTokens`/`outputTokens` per call
(threaded from `response.usage`, `run-agent-loop.ts:111`) so spend is *measured*,
not guessed.

**Retrieval as compression.** The most important budgeting move isn't a cap, it's
the architecture: RAG retrieves *only the relevant chunks* instead of stuffing
the whole corpus into the prompt. `search_knowledge_base` returns top-k ranked
results with 160-char citation snippets (`search-knowledge-base-tool.ts:111`) —
that's deliberate context compression. The `compactSystem?` slot on the
`PromptPackage` (`prompts/src/types.ts:15`) is the same instinct for the system
prompt: a budget-cut variant for when the window is tight.

### Move 2.5 — current state vs future state

```
  Comparison — token discipline: shipped vs gap

  NOW (shipped)                      │  GAP (not yet exercised)
  ─────────────────────────────────  │  ────────────────────────────────
  maxTokens / maxTurns / maxToolCalls│  no tokenizer-accurate counting
  truncate() tool results @ 16k      │    (caps are char/turn proxies)
  usage-ledger accounts spend        │  no prefix CACHING (no cache_control
  retrieval compresses context       │    anywhere — static prefix re-sent
  compactSystem? budget variant slot │    every call, full cost each time)
  local provider window guard        │  no sliding-window history summarizer
                                     │  no lost-in-the-middle mitigation
```

## Primary diagram

Every cap, mapped onto the window it defends.

```
  Token budgeting — caps mapped to window slices

  PROVIDER GUARD (local provider): reject if request > window
  ┌──────────────── context window ────────────────────────────┐
  │ SYSTEM+SCHEMA      │ TOOL RESULTS        │ HISTORY  │ RESP.  │
  │ (compactSystem? to │ truncate() @16k     │ maxTurns │ maxTok │
  │  shrink)           │ each (loop:52,162)  │ (=8/6)   │ (=4096)│
  │ re-sent every call │ maxToolCalls (=4)   │          │        │
  │ — no prefix cache  │ bounds the fan-out  │          │        │
  └────────────────────┴─────────────────────┴──────────┴────────┘
  usage-ledger.ts measures inputTokens/outputTokens per call
```

## Elaborate

Three ideas from the literature that this repo half-touches. **The 80% rule:**
if you routinely use >80% of the window, you're one model swap (to a
smaller-window model, or a model whose tokenizer counts your language heavier)
away from breaking — the char-based caps here are a proxy for the real
tokenizer-accurate count, which is the honest gap. **Lost-in-the-middle**
(Liu et al.): content placed in the middle of a long context is attended worse
than content at the start or end — position matters, and the repo doesn't yet
reorder retrieved chunks to fight it. **Prefix caching:** providers can cache the
static prefix of a prompt across calls so you don't pay to re-encode the system
prompt and schema every time — Anthropic exposes this via `cache_control`, and
the move is to keep everything stable at the *front* of the prompt. This repo
sends the full prefix every call (no `cache_control` exists in the codebase),
which is correct-but-uncached: a real cost lever left on the table.

## Interview defense

**Q: How do you keep a tool-calling agent from blowing the context window?** Cap
the things that grow: bound the response (`maxTokens`), the fan-out
(`maxToolCalls`), the turns (`maxTurns`), and hard-truncate tool results before
they re-enter the message history. Use retrieval to compress context instead of
stuffing the corpus. In this repo all four caps live in `runAgentLoop`.

```
  fixed prefix │ GROWING middle (the danger) │ bounded response
               └─ truncate@16k + maxToolCalls + maxTurns ─┘
```
*Anchor: `truncate` @ `run-agent-loop.ts:52`; `budgetSpent`/`maxToolCalls` @ `:101`.*

**Q: The part people forget?** The **growing middle**. People budget the system
prompt and the response and forget that tool results and history *accumulate* per
turn — that's the slice that actually blows the window in a multi-turn agent. The
load-bearing defense is the per-result `truncate()` plus the tool-call budget,
not the response cap.

## See also

- `03-prompts-as-code.md` — `compactSystem` is the budget variant of the package.
- `06-single-purpose-chains.md` — small models for classifiers spend fewer tokens.
- `09-chain-of-thought.md` — CoT is a deliberate token spend; budget it.
- `../study-performance-engineering/` — cost and latency at depth.
