# Provider abstraction

Provider abstraction · the adapter/factory pattern (Industry standard)

This is the crown jewel of LLM foundations. One interface — `ModelProvider` — and everything in aptkit depends on it, never on a vendor SDK. Anthropic, OpenAI, Gemma, a fallback chain, a context guard: all of them are just adapters behind that one `complete()` method. Swap the adapter, the rest of the system doesn't notice. This is dependency inversion applied to the most vendor-locked thing in your stack.

## Zoom out, then zoom in

The port sits at the waist of aptkit; adapters hang below it, all features above depend only on it.

```
aptkit — the provider waist
┌─────────────────────────────────────────────┐
│ Capabilities, agent loop, generateStructured  │  depend on the PORT only
├─────────────────────────────────────────────┤
│ ★ ModelProvider — the PORT (one complete())    │  ← you are here
├─────────────────────────────────────────────┤
│ ADAPTERS:                                       │
│  anthropic · openai · gemma · fallback · local │
└─────────────────────────────────────────────┘
   each maps complete() → its vendor's API (or wraps another provider)
```

The pattern is the **adapter** behind a **port** (hexagonal architecture / dependency inversion). The question: *what changes when you swap providers?* Answer: nothing above the waist. You've shipped this before — a `DataSource` interface with `MySQLAdapter` and `PostgresAdapter` behind it, every repository coded against the interface. Same move, except the "database" is a language model and the adapters include a *local* one with no native tool calling at all.

## Structure pass

Two adapter shapes here: leaf adapters (map to a vendor) and wrapper adapters (decorate another provider). Trace the **trust** axis — what each adapter assumes about the model below it.

```
TRUST axis — what does the adapter assume?
Adapter        type      trusts the model to...           ←★ seams
──────────────────────────────────────────────────────────────────
anthropic      leaf      emit native tool_use blocks       (full trust)
openai         leaf      emit native tool_calls            (full trust)
gemma          leaf      NOT support tools → emulate+retry  ←★ trust flips
fallback       wrapper   one provider may fail → try next   ←★ failure-aware
local (guard)  wrapper   request may overflow → reject early ←★ size-aware
```

Two seams. At **gemma**, trust in native capability flips to zero — it can't do tool calling, so the adapter fakes it. At **fallback/local**, the adapter stops trusting a single call to succeed and adds resilience. Every adapter presents the *same* `complete()`; what differs is how much it had to compensate for the model beneath it.

## How it works

**Mental model.** A port is a contract; adapters are implementations; wrappers are adapters that take another provider as input (decorator pattern). The factory just hands you the right one. Everything upstream holds a `ModelProvider`, never a vendor type.

```
The port + adapters
            ModelProvider (port)
                  │ complete(request): Promise<ModelResponse>
   ┌──────┬───────┼────────┬─────────────┐
 anthropic openai gemma  fallback      local
  (leaf)  (leaf) (leaf)  (wrapper)     (wrapper)
                          holds [p1,p2] holds inner provider
```

**Leaf adapter: native tool calling (Anthropic).** Maps the request straight onto the vendor SDK; the model speaks tools natively.

```ts
// packages/providers/anthropic/src/anthropic-provider.ts:18-26, 28-61
id = 'anthropic';
defaultModel = 'claude-sonnet-4-6';                  // ~:24
async complete(request) {
  const res = await client.messages.create({ ... }); // :28-61 map request → vendor
  // native tool_use blocks; usage input_tokens/output_tokens, estimated:false
}
```

`estimated:false` matters — Anthropic returns real token counts, so the usage ledger isn't guessing (contrast `02-tokenization.md`). This is the easy case: the vendor already speaks the contract's dialect.

**Leaf adapter: emulated tool calling (Gemma) — the hard case.** Local Gemma over Ollama has *no* tool API. The adapter manufactures one with a prompt + parse + retry loop.

```ts
// packages/providers/gemma/src/gemma-provider.ts:52-92  (complete)
const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1;   // :57 (default 2)
for (let attempt = 0; attempt < maxAttempts; attempt += 1) {     // :62
  // :67 on retry, append RETRY_NUDGE to the system text
  const raw = await ollamaChat(...);
  const call = parseToolCall(raw);                               // :78
  if (call) return toolUseBlock(call);
  if (looksLikeToolAttempt(raw)) continue;                       // :86 retry
}
return textBlock(raw);                                           // :91 fallback to text
```

```ts
// packages/providers/gemma/src/gemma-provider.ts:133-165  (buildSystemText)
// renders each tool as JSON {name, description, input_schema} into the system prompt,
// then: "When a tool is needed, respond with ONLY a single JSON object, no prose: ..."

// :168-182 (parseToolCall) — tolerant field mapping
parsed = parseAgentJson(text);                       // :171 (reuse the JSON extractor)
const name = obj.tool ?? obj.name ?? obj.tool_name;  // accept any of three spellings
const args = obj.arguments ?? obj.input ?? obj.args; // ditto
```

```
Gemma emulated tool call
  inject tool schemas into system prompt
        │
  attempt 1: model replies ──▶ parseToolCall
        │                         │
     valid JSON tool? ─yes─▶ return tool_use block ✓
        │ no
  looks like a botched attempt? ─yes─▶ append RETRY_NUDGE, attempt 2
        │ no
  return as plain text  (it wasn't trying to call a tool)
```

The genius is that *from above*, Gemma's `complete()` looks identical to Anthropic's — same `tool_use` block out. The prompt-engineering, the retry, the lenient `tool ?? name ?? tool_name` field mapping all hide behind the port. The local model can't speak tools, so the adapter teaches it to, one nudge at a time.

**Wrapper adapter: the fallback chain.** Holds a list of providers and tries them in order — resilience as composition.

```ts
// packages/providers/fallback/src/fallback-provider.ts:27-96  (complete 47-89)
for (const provider of this.providers) {
  try { return await provider.complete(request); }       // try it
  catch (error) {
    if (!shouldFallback(error, provider)) throw error;    // not a fallback-able error → bail
    emitWarning(...);                                     // :78-84 record the fallback
    // else loop to next provider
  }
}
throw new ProviderFallbackError(...);                     // :88 all exhausted
```

The `shouldFallback` gate is the discipline — you only fall through on *retryable* errors (rate limit, timeout), not on a bad request, so you don't paper over real bugs. Because `FallbackModelProvider` *is* a `ModelProvider`, it composes: a fallback whose first entry is a context-guarded Gemma whose fallback is Anthropic. Turtles all the way down, one interface.

**Wrapper adapter: the context guard (decorator).** Wraps any provider and rejects oversized requests before they hit it (see `02-tokenization.md`).

```ts
// packages/providers/local/src/context-window-guard.ts:38-71  (complete 57-69)
estimateContextWindow(request);                  // :59 estimate input tokens
if (over)  throw new ContextWindowExceededError; // :60-68 reject locally
return this.inner.complete(request);             // :69 else delegate down
```

```
Decorator stack — same interface at every layer
  guard.complete()  ── too big? throw  : ──▶  inner.complete()
       │                                          │
       └ still a ModelProvider ───────────────────┘ still a ModelProvider
```

**The principle.** Invert the dependency on anything you don't control. Define the interface *you* need, make every vendor conform to it via an adapter, and never let a vendor type leak upward. Then resilience (fallback) and safety (guard) become decorators you stack, not rewrites. The reward shows up the day you swap providers — or run a local model with none of the vendor's features — and nothing above the waist changes.

## Primary diagram

The whole abstraction: one port, leaf adapters mapping to vendors, wrapper adapters composing for resilience and safety.

```
Provider abstraction — full picture
  Capabilities / agent loop / generateStructured
        │ (hold a ModelProvider, nothing else)
        ▼
  ┌──────────────── ModelProvider port ─────────────────┐
  │ complete(request): Promise<ModelResponse>            │
  └──────────────────────────────────────────────────────┘
        │                │                  │
   ┌────┴────┐      ┌────┴─────┐       ┌────┴──── wrappers ────────┐
 anthropic  openai  gemma                fallback           context guard
 native     native  EMULATE tools:       try p1→p2→p3,      estimate→reject
 tool_use   calls   prompt+parse+retry    shouldFallback     or delegate
 est:false                                ProviderFallbackError
        └─ leaf adapters → vendor API ─┘   └─ wrap other providers ─┘
```

Read it top-down: features see one box; reality is five adapters and two compositions, all wearing the same interface.

## Elaborate

This is hexagonal architecture (Cockburn) / ports-and-adapters, and the dependency inversion principle (the D in SOLID): high-level policy depends on an abstraction, low-level vendor detail conforms to it. The fallback chain is the **chain of responsibility** pattern; the context guard is the **decorator** pattern; the thing that picks an adapter is a **factory**. The Gemma emulation is the standout — it's the same trick LangChain/LlamaIndex use to give tool calling to models that lack it, built here from scratch over Ollama. What aptkit does *not* have: rate limiting, circuit breakers, exponential backoff — only the bounded retry in `generateStructured` and this fallback chain exist; richer resilience is **not yet exercised**. Read `04-structured-outputs.md` (a tool call is a structured output) and `05-streaming.md` (the port returns once, no token stream).

## Project exercises

### Add a backoff-and-retry decorator provider

- **Exercise ID:** `EX-LLM-08a`
- **What to build:** This abstraction is the foundation (Case A) — extend it with a missing resilience layer. Build a `RetryingModelProvider` wrapper (decorator, same shape as the context guard) that catches retryable errors (rate limit, 5xx, timeout) and retries `complete()` with exponential backoff and jitter, capped at N attempts, then re-throws. Compose it: retry-wrap each provider *inside* the fallback chain.
- **Why it earns its place:** It's the named gap (no backoff/circuit-breaker today) and it cements the decorator insight — resilience is a wrapper, not a rewrite, because everything is the same port. You'll feel why dependency inversion pays off when you stack guard → retry → fallback without touching a capability.
- **Files to touch:** new file under `packages/providers/local/src/` (mirror `context-window-guard.ts:38-71`); wire into `packages/providers/fallback/src/fallback-provider.ts` (27-96); type from `packages/runtime/src/model-provider.ts` (54-58).
- **Done when:** a provider that throws a rate-limit error is retried with growing delays then succeeds, a non-retryable error re-throws immediately, the wrapper still satisfies `ModelProvider`, and it composes inside the fallback chain.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: How does a local model with no tool API expose the same tool-calling interface as Anthropic?**

```
  Anthropic: vendor returns tool_use block          → return it (native)
  Gemma:     inject tool schemas into prompt
             "reply ONLY JSON {tool, arguments}"
             parse reply → tool ?? name ?? tool_name  (lenient)
             malformed? append RETRY_NUDGE, retry (max 2)
             still bad? return as text
             └ same tool_use block out the top
```

The Gemma adapter emulates tool calling — prompts for a JSON tool call, parses it leniently, retries with a nudge — and emits the identical `tool_use` block, so callers can't tell. Anchor: *the adapter hides the model's missing features behind the port.*

**Q: What changes upstream when you swap Anthropic for the fallback chain?**

```
  capability ─holds─▶ ModelProvider ◀─ anthropic
  capability ─holds─▶ ModelProvider ◀─ fallback[gemma→anthropic]
                      └ same interface, zero upstream change
```

Nothing. Everything above the waist depends only on `complete()`; the fallback chain *is* a `ModelProvider`, so it drops in transparently. Anchor: *depend on the port, swap the adapter, the policy never notices.*

## See also

- [`04-structured-outputs.md`](./04-structured-outputs.md) — a tool call is a structured output.
- [`01-what-an-llm-is.md`](./01-what-an-llm-is.md) — the port as the IO model.
- [`05-streaming.md`](./05-streaming.md) — why the port returns once.
