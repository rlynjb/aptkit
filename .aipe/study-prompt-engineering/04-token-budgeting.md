# 04 — Token budgeting and context window management

**Subtitle:** token budgeting / context-window management — allocate, count,
compress, position (Industry standard)

## Zoom out, then zoom in

This is the most operational concept in the guide. Counting tokens is not
optional — it's the hygiene that separates amateur prompt work from
professional. A chain that runs fine on small inputs and silently truncates
at scale is the signature failure of skipping it. aptkit's budget lives at
the assembly seam, where context gets spliced into the prompt.

```
  Zoom out — where tokens accumulate before a model call

  ┌─ Source ────────────────────────────────────────────────────┐
  │  system prompt (constant)  + compactSystem? (budget variant) │
  └───────────────────────────┬──────────────────────────────────┘
                              │ + injected context
  ┌─ ★ Assembly (budget seam) ▼───────────────────────────────────┐
  │  ★ system + profile + {schema} + tool schemas + history ★     │ ← we are here
  │     this is where the window fills up                         │
  └───────────────────────────┬──────────────────────────────────┘
                              │ maxTokens caps the RESPONSE
  ┌─ Provider ────────────────▼───────────────────────────────────┐
  │  Anthropic: huge window   |   Gemma: small LOCAL window        │
  └────────────────────────────────────────────────────────────────┘
```

Zooming in: the context window is a fixed budget split four ways — system
prompt, retrieved context, conversation history, and the reserved space for
the response. Token budgeting is the discipline of allocating that budget on
purpose instead of discovering you blew it when the model truncates.

## Structure pass

**Layers.** Source (system text, sized at authoring) → assembly (context
injected, where the window actually fills) → provider (the window size,
which *differs per provider*).

**Axis — how much of the window is left for the response?** Trace it down:

```
  Axis: "what fraction of the window is consumed before the answer?"

  system prompt    → fixed cost, every call
  profile inject   → + a whole me.md document (rag-query)
  {schema} summary → + workspace fields (query agent)
  tool schemas     → + rendered JSON (Gemma: into system TEXT)
  history          → + grows per turn in the loop
  ─────────────────────────────────────────────────
  response budget  → whatever's LEFT (maxTokens caps it)  ← the squeeze
```

**Seam.** The load-bearing boundary is the *provider*. The same assembled
prompt that fits comfortably in Anthropic's window can blow Gemma's local
window. The window size flips across the provider seam, so a prompt that's
safe on one model is one provider-swap away from truncating on another.

## How it works

You know how a fixed-height flex container distributes space among its
children, and if you cram too many in, the last one gets clipped? The
context window is that container. Every prompt section is a child competing
for the same fixed height. Let's walk the budget.

### Step 1 — the four claimants on the window

```
  The window as a fixed budget — four claimants

  ┌───────────────────────── context window ─────────────────────┐
  │ system prompt │ retrieved context │ history │  RESPONSE        │
  │  (constant)   │  (per call)       │ (grows) │  (reserved)      │
  └───────────────┴───────────────────┴─────────┴──────────────────┘
                                                  ↑ maxTokens caps THIS
   if the first three grow, the response space shrinks — silently
```

In aptkit the response cap is explicit: `maxTokens` defaults to 4096 in the
loop (`run-agent-loop.ts:87`) and 16 for the intent classifier
(`intent.ts:22` — it only needs one word). That cap is you *reserving*
response space. The other three sections eat the rest.

### Step 2 — counting tokens: aptkit measures, it doesn't guess

The honest position: aptkit does not bundle a tokenizer or pre-count the
assembled prompt. What it does instead is *measure actual usage after the
call* and record it. The Gemma provider reads Ollama's real counts:

```ts
// packages/providers/gemma/src/gemma-provider.ts:116 (toResponse)
usage: {
  inputTokens: response.prompt_eval_count,   // real count from Ollama
  outputTokens: response.eval_count,
  estimated: false,                          // ← not a guess
},
```

That `estimated: false` flag is the tell — aptkit distinguishes a real token
count from an estimate, and surfaces it as a `model_usage` trace event
(`run-agent-loop.ts:112`). So the budgeting discipline here is
*measurement and observability*, not pre-flight estimation. You learn your
real input-token cost per call from the trace, then size your prompt
accordingly. Knowing your model's tokenizer and rough ratios is still on
you; the repo gives you the ground truth to calibrate against.

### Step 3 — compression slot: `compactSystem`

The `PromptPackage` carries a second, shorter system variant:

```ts
// packages/prompts/src/types.ts:13
export type PromptPackage = {
  system: string;
  compactSystem?: string;   // ← the budget variant
  ...
};
```

This is the compression lever at the system layer: a long, detailed system
prompt for a roomy model, a terse one for a tight window. It's a slot the
type provides; whether a given package fills it is per-package. The pattern
it encodes is the right one — keep two sizes of the same instruction and
pick by budget — even where it's `not yet exercised` in every package.

### Step 4 — retrieval AS context compression

The most important compression technique in this repo isn't summarization —
it's retrieval. The RAG-query agent doesn't stuff the whole knowledge base
into the prompt. It retrieves the top-k relevant chunks and injects only
those:

```ts
// packages/retrieval/src/search-knowledge-base-tool.ts:22
const DEFAULT_TOP_K = 5;
// the tool returns at most top_k ranked chunks, each a ~160-char snippet:
// toResult(): const snippet = text.length > 160 ? `${text.slice(0,157)}...` : text;
```

```
  Retrieval as compression — don't stuff, retrieve

  whole KB (1000s of chunks)        retrieved (top 5)
  ┌────────────────────────┐        ┌──────────────┐
  │ ████████████████████   │  embed │ relevant 5   │ → into prompt
  │ ████████████████████   │ ──ANN─►│ ~160 chars ea│
  │ ████████████████████   │        └──────────────┘
  └────────────────────────┘        fits the budget by design
   would blow any window               (concept lives in study-ai-engineering)
```

Retrieval is context compression: instead of paying tokens for everything,
you pay an embedding+ANN search and bring back only what's relevant. The
160-char snippet truncation in `toResult` is a second compression — even the
retrieved chunks are clipped before they hit the prompt.

### Step 5 — history growth and the loop's truncation guard

In the agent loop, conversation history grows every turn — each assistant
turn and each tool result gets appended to `messages`
(`run-agent-loop.ts:124,189`). Unbounded, that's how a chain that worked on
turn 2 blows the window on turn 6. aptkit's guard is at the tool-result
boundary:

```ts
// packages/runtime/src/run-agent-loop.ts:52
const MAX_TOOL_RESULT_CHARS = 16_000;
function truncate(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}
```

A tool that returns a giant blob can't single-handedly evict the system
prompt from the window — it's capped at 16k chars before being appended.
That's a crude but real budget control on the fastest-growing claimant.

### Step 6 — the 80% rule and lost-in-the-middle

Two principles aptkit doesn't enforce in code but that govern how you should
author against it:

- **The 80% rule.** If your assembled prompt uses more than 80% of the
  window, you're one model change away from breaking. The provider seam
  makes this concrete: a prompt at 60% of Anthropic's window might be at 95%
  of Gemma's. Leave headroom.
- **Lost-in-the-middle.** Even when context fits, content buried in the
  middle of a long prompt is poorly attended. Position matters — put the
  retrieved chunks and the actual question where the model attends, not
  buried after a wall of rules. aptkit's prompts front-load the role and
  rules and put `{schema}` / the question near the end, which is the right
  instinct.

Prefix caching — caching the static prompt prefix across calls so you don't
re-pay for it — is the natural next lever (and an argument for keeping the
stable system prompt at the front). aptkit does `not yet exercise` it: there
is no `cache_control` anywhere in `packages/`. It's the highest-leverage
unbuilt budgeting feature here.

### The principle

**The context window is a fixed budget, and the professional move is to
allocate it on purpose — measure real usage, reserve response space,
compress with retrieval, and leave headroom for the next model.** The
amateur move is to assume it fits and find out it didn't when the output
truncates in production.

## Primary diagram

The full budget picture, claimants and controls labelled.

```
  Token budget in aptkit — claimants and the controls on each

  ┌───────────────────────── context window ─────────────────────┐
  │ SYSTEM         │ RETRIEVED        │ HISTORY    │  RESPONSE      │
  │ (constant)     │ (per call)       │ (per turn) │  (reserved)    │
  │  ↑ compactSystem│ ↑ top_k=5 +     │ ↑ 16k-char │  ↑ maxTokens   │
  │    variant slot │   160-char snip  │   truncate │    cap (4096)  │
  └────────────────┴──────────────────┴────────────┴────────────────┘
   measured after the call:  model_usage event { inputTokens, estimated:false }
   provider seam:  Anthropic window ≫ Gemma local window  ← the squeeze flips here
   not yet exercised:  prefix caching (cache_control)
```

## Elaborate

The token-budget discipline comes straight from production LLM work — the
OpenAI cookbook's context-management notes, the lost-in-the-middle paper
(Liu et al.), and every postmortem where a prompt grew past the window. The
repo's stance is measurement-first: it records real `prompt_eval_count` from
Ollama and flags estimates, rather than shipping a tokenizer. That's a
defensible call for a toolkit — the host app knows its model's tokenizer
better than the toolkit does.

The connection to retrieval (`study-ai-engineering`) is the load-bearing
one: retrieval is the dominant compression technique here, and the 160-char
snippet plus `top_k=5` are both budget decisions wearing retrieval clothes.
The connection to prompts-as-code (concept 3) is `compactSystem` — a budget
variant versioned alongside the full prompt.

## Interview defense

**Q: How do you budget a context window?**

Treat it as a fixed allocation: system prompt + retrieved context + history
+ reserved response space. Reserve the response (a `maxTokens` cap),
compress context with retrieval rather than stuffing, cap the fastest
grower (tool results / history), and stay under ~80% so the next model
doesn't tip you over. Measure real usage and calibrate — don't guess.

```
  [ system | retrieved | history | RESPONSE ]  ← reserve the last box first
   under 80% full = one model change of headroom
```

Anchor: "aptkit reserves with `maxTokens`, caps tool results at 16k chars,
compresses via `top_k=5` retrieval, and records `model_usage` with
`estimated:false` so the real cost is observable."

**Q: Name the budgeting failure mode you watch for.**

A chain that works on small inputs and silently truncates at scale because
nobody counted. The provider seam makes it worse: a prompt safe on a
big-window cloud model blows a small local window. The control is the
truncation guard (`MAX_TOOL_RESULT_CHARS`) plus measuring real usage per
provider — and the unbuilt lever is prefix caching, which aptkit doesn't do
yet.

Anchor: "Works small, truncates at scale — the provider window flips the
budget; prefix caching is the unbuilt fix."

## See also

- [01-anatomy.md](01-anatomy.md) — bloating the constant section costs
  tokens every call
- [03-prompts-as-code.md](03-prompts-as-code.md) — `compactSystem` as a
  versioned budget variant
- [08-few-shot.md](08-few-shot.md) — examples cost context tokens; budget
  them
- study-ai-engineering — retrieval as the dominant compression technique
