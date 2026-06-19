# The model is a function — tokens in, tokens out

**Industry names:** language model, next-token predictor, completion API · *Industry standard*

## Zoom out, then zoom in

Strip away the agent loop, the eval layer, the cost ledger — everything AptKit
is famous for — and at the bottom there's one call: hand the model some text,
get some text back. That call is the only thing every other layer in the repo
depends on. Here's where it sits.

```
  Zoom out — the one call everything rests on

  ┌─ Agent layer (packages/agents/*) ───────────────────────────┐
  │  QueryAgent / RecommendationAgent / AnomalyMonitor          │
  └───────────────────────────────┬──────────────────────────────┘
                                   │  calls
  ┌─ Runtime layer (packages/runtime) ─▼──────────────────────────┐
  │  runAgentLoop · generateStructured · usage-ledger             │
  │  all of them call ──┐                                          │
  └─────────────────────┼─────────────────────────────────────────┘
                        │  model.complete(request)
  ┌─ Provider layer ────▼──────────────────────────────────────────┐
  │  ★ ModelProvider.complete() ★  ←── THIS CONCEPT                 │
  │  anthropic / openai / fixture / local-guard                     │
  └─────────────────────────────────────────────────────────────────┘
```

Zoom in: an LLM is a function. You give it a prompt (text, as a sequence of
tokens), it returns a continuation (more tokens). No memory between calls, no
hidden state you own — every call is the prompt plus the model's weights, full
stop. AptKit's entire *view* of the model is one TypeScript type: the
`ModelProvider` contract. And that contract is narrow on purpose — two members
wide. The narrowness is the lesson.

## Structure pass

**Layers.** Two relevant here: the *contract* (`ModelProvider`, a type the whole
repo codes against) and the *adapter* (a concrete class that implements it by
calling a vendor SDK). The contract is what callers see; the adapter is what
talks to the wire.

**Axis — dependency: who depends on whom?** Trace it. The agent loop depends on
`ModelProvider`. `generateStructured` depends on `ModelProvider`. The cost
ledger depends on the *shape of one field* the contract returns (`usage`).
Nothing in the core depends on Anthropic or OpenAI. The arrow points *at the
contract*, never past it to a vendor.

**Seam.** The load-bearing seam is `complete(request): Promise<ModelResponse>`.
On the caller's side: provider-neutral types, testable, vendor-free. On the
other side: an HTTP call to a specific vendor with that vendor's quirks. The
dependency arrow stops dead at this seam — which is exactly why you can drop in
a `FixtureModelProvider` for tests and the agent loop can't tell the difference.

## How it works

You already write functions with one job: `parse(text) → AST`. An LLM is that,
except the function body is 100B+ learned weights and the mapping is `tokens →
tokens`. Same mental shape, though: deterministic-looking interface, input goes
in, output comes out.

### Move 1 — the mental model

The model is a pure-ish function over (prompt, weights). Same prompt, same
weights, same sampling settings → same distribution of outputs. The picture:

```
  The LLM as a function

   prompt tokens               model                output tokens
   ┌──────────────┐      ┌──────────────────┐      ┌──────────────┐
   │ system +     │ ───► │  weights (fixed)  │ ───► │ continuation │
   │ messages +   │      │  next-token       │      │ text + maybe │
   │ tool schemas │      │  prediction loop  │      │ tool_use     │
   └──────────────┘      └──────────────────┘      └──────────────┘
        input                 the "body"               output

   no memory across calls — each call is prompt + weights, nothing else
```

The "body" is opaque and you don't control it. What you *do* control is entirely
on the two sides: what tokens you send in, and how you parse what comes out. That
is the whole job of an LLM application, and it's why AptKit's contract is shaped
the way it is.

### Move 2 — the load-bearing skeleton

The contract has a kernel. Strip it to the minimum that's still a usable model
abstraction:

```
  Kernel — the ModelProvider contract (pseudocode)

  type ModelProvider = {
    id: string                              // which vendor (for traces/pricing)
    defaultModel?: string                   // what model, if caller doesn't say
    complete(request) -> Promise<response>  // THE call. one method.
  }

  type request  = { system?, messages, tools?, maxTokens?, temperature?, signal? }
  type response = { content: block[], usage?, model? }
```

**Name each part by what breaks without it:**

- **`complete(request) -> Promise<response>`.** The one method. Drop it and there
  is no model — every other type here is just describing its argument and return.
  It's `async` because it's a network round-trip; it returns the *whole* response
  (not a stream), which is the single most consequential design choice in the
  repo (see `05-streaming.md`).
- **`request.messages`.** The conversation so far, as a list. Drop it and the
  model has nothing to continue from. This carries the "no memory across calls"
  truth: *you* resend the whole history every time; the model doesn't remember.
- **`request.tools`.** Optional tool schemas the model may ask to call. Drop it
  and the model can only emit text — no agentic behavior. Its presence is what
  turns "a chat completion" into "an agent step."
- **`response.content`.** A list of blocks — `text` and/or `tool_use`. Drop the
  block structure and you can't tell "the model answered" from "the model wants
  to run a tool." That distinction is the pivot the agent loop turns on.
- **`response.usage`.** Token counts. Drop it and the cost ledger has nothing to
  sum. It's optional because not every provider returns it on every call.

**Skeleton vs. hardening.** The kernel is `complete` + the request/response
shapes. Hardening layered on top: `id` (for trace attribution and pricing
lookup), `defaultModel` (a fallback), `signal` (cancellation), `maxTokens` and
`temperature` (knobs the caller may set). You could delete every optional field
and still have a model you could call — that's how you know they're hardening.

### Move 3 — the principle

A good model abstraction is *narrow*. Two members wide — `id` plus
`complete()` — is not a limitation, it's the design. The narrower the seam, the
more the rest of your system is vendor-free, testable, and swappable. Every
field you add to the contract is a field every adapter must honor and every test
must fake. AptKit resisted adding streaming, top-p, top-k, and stop sequences to
the contract not because they don't exist but because nothing in the repo needs
them — and a contract that promises less is a contract you can actually keep.

## Primary diagram

The full contract, every field, with the two consumers that depend on its shape.

```
  ModelProvider — the contract and its dependents

  ┌─ Runtime consumers (depend only on this shape) ─────────────────┐
  │  runAgentLoop ─┐   generateStructured ─┐   usage-ledger ─┐       │
  └────────────────┼───────────────────────┼─────────────────┼──────┘
                   │                        │                 │
                   ▼ complete(req)          ▼ complete(req)    ▼ reads req.usage
  ┌─ ModelProvider (the seam) ──────────────────────────────────────┐
  │  id: string                                                      │
  │  defaultModel?: string                                           │
  │  complete(request): Promise<ModelResponse>                       │
  │                                                                  │
  │  request  { system?, messages[], tools?[], maxTokens?,           │
  │             temperature?, signal? }                              │
  │  response { content: (text | tool_use)[], usage?, model? }       │
  └───────────────────────────────┬──────────────────────────────────┘
                                   │  implemented by
  ┌─ Adapters (vendor-specific) ───▼──────────────────────────────────┐
  │  AnthropicModelProvider · OpenAIModelProvider · FixtureModelProvider│
  └────────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every model call in the repo goes through this type. `runAgentLoop`
calls `options.model.complete(...)` once per turn. `generateStructured` calls it
once per attempt. `classifyIntent` calls it once for a one-word answer. Tests
call a `FixtureModelProvider` that satisfies the same contract. No code in
`packages/runtime` or `packages/agents` imports a vendor SDK directly — they all
import `ModelProvider`.

**The contract**, `packages/runtime/src/model-provider.ts:54-58`:

```
  packages/runtime/src/model-provider.ts  (lines 54-58)

  export type ModelProvider = {
    id: string;                                      ← which vendor; used for
                                                       trace attribution + pricing
    defaultModel?: string;                           ← model id if caller omits
    complete(request: ModelRequest):                 ← THE method. the entire
      Promise<ModelResponse>;                          surface of "the LLM."
  };
       │
       └─ Two members. That's the whole abstraction. Everything the repo
          does with an LLM is expressed as a call to complete(). Add a third
          member and every adapter + every test fixture must grow to match.
```

The request and response shapes that `complete` mediates,
`packages/runtime/src/model-provider.ts:39-52`:

```
  packages/runtime/src/model-provider.ts  (lines 39-52)

  export type ModelRequest = {
    system?: string;            ← system prompt (instructions, not conversation)
    messages: ModelMessage[];   ← the conversation; YOU resend it every call
    tools?: ModelTool[];        ← optional tool schemas the model may invoke
    maxTokens?: number;         ← output cap
    temperature?: number;       ← sampling knob (see 03-sampling-parameters.md)
    signal?: AbortSignal;       ← cancellation
  };

  export type ModelResponse = {
    content: ModelContentBlock[];  ← text and/or tool_use blocks — the pivot
    usage?: ModelUsage;            ← token counts the cost ledger sums
    model?: string;                ← which model actually answered
  };
       │
       └─ content is a discriminated list, not a string. That's deliberate:
          a tool_use block is structurally different from a text block, and
          the agent loop branches on exactly that difference.
```

The block union it returns, `packages/runtime/src/model-provider.ts:20`: a
`ModelContentBlock` is `ModelTextBlock | ModelToolUseBlock`. "The model
answered" is a text block; "the model wants to call `get_metric_timeseries`" is
a tool_use block. One call can return both.

## Elaborate

The "model as a function" framing comes straight from how completion APIs are
built: a stateless HTTP endpoint that takes a prompt and returns a continuation.
The statelessness is not an implementation detail you can ignore — it's why the
agent loop has to accumulate `messages` and resend the whole history each turn
(`../04-agents-and-tool-use/03-react-pattern.md`), and why "conversation memory"
is something your code owns, never the model.

The narrowness of `ModelProvider` is a deliberate application of interface
segregation: the contract promises only what the repo consumes. Contrast with
vendor SDKs, which expose dozens of parameters (logprobs, seed, response_format,
stop sequences, presence/frequency penalties). AptKit's adapters *translate* the
narrow request into the wide SDK call and translate the wide SDK response back
into the narrow `ModelResponse` — that translation is the adapter's whole job
(`08-provider-abstraction.md`).

Adjacent concepts: the provider abstraction that implements this contract
(`08-provider-abstraction.md`), what a token actually is (`02-tokenization.md`),
and the agent loop that calls `complete()` in a loop
(`../04-agents-and-tool-use/03-react-pattern.md`). How prompts are constructed
before they hit `messages` is prompt-engineering territory —
`.aipe/study-prompt-engineering/` *(not yet generated)*.

## Project exercises

*Provenance: Phase 1 — LLM foundations (C1.x). No `aieng-curriculum.md` present;
IDs are by-phase convention.*

### Exercise — a logging ModelProvider decorator

- **Exercise ID:** `[C1.1]` Phase 1, the model-as-function contract
- **What to build:** A `LoggingModelProvider` that wraps any `ModelProvider`,
  implements the same contract, logs each request's message count and each
  response's block types + token usage, then delegates to the inner provider.
- **Why it earns its place:** Implementing the contract yourself proves you
  understand that the seam is swappable — the decorator pattern over a narrow
  interface is exactly how `ContextWindowGuardedProvider` already works
  (`06-production-serving/`). It also makes the "two members wide" point tangible.
- **Files to touch:** new `packages/providers/local/src/logging-provider.ts`,
  `packages/runtime/src/model-provider.ts` (read only), a unit test.
- **Done when:** A test wraps a `FixtureModelProvider`, runs one `complete()`,
  and asserts the log captured the request shape and response block types.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: What *is* an LLM, in one sentence, and how does your code model it?**
A function from tokens to tokens with no memory between calls. I'd sketch the
contract:

```
  caller ─ complete(request) ─► ModelProvider ─► Promise<response>
           {system,messages,         (one method)    {content: blocks,
            tools,...}                                 usage, model}
```

"In AptKit that's the `ModelProvider` type — `id` plus one method,
`complete(request): Promise<ModelResponse>`, in `model-provider.ts:54`. The whole
repo codes against that type; nothing in the core imports a vendor SDK."
*Anchor: the abstraction is two members wide, and that narrowness is the design.*

**Q: Why is `response.content` a list of blocks instead of a string?**
"Because one model call can produce text *and* a request to run a tool, and those
are structurally different things. The agent loop branches on exactly that — if
there's a `tool_use` block it runs the tool; if it's only text the model is done.
A plain string couldn't carry that distinction. It's `model-provider.ts:48-52`."
*Anchor: the block union is the pivot the agent loop turns on.*

## Validate

- **Reconstruct:** From memory, write the `ModelProvider` type and the
  `ModelRequest` / `ModelResponse` shapes. Check against
  `packages/runtime/src/model-provider.ts:39-58`.
- **Explain:** Why is `complete` `async` and why does it return the whole
  `ModelResponse` rather than a stream? (Network round-trip → async; returning
  the whole response is what lets `generateStructured` parse-and-validate the
  complete text — see `05-streaming.md`.)
- **Apply:** You need to add `seed` support for reproducible outputs. What
  changes? (A field on `ModelRequest`, plus every adapter must pass it through,
  plus every test fixture must accept it. That cost is why the contract stays
  narrow — `model-provider.ts:39-46`.)
- **Defend:** Why does nothing in `packages/runtime` import `@anthropic-ai/sdk`?
  (So the core depends only on the contract; the vendor dependency is isolated to
  the adapter at `packages/providers/anthropic/src/anthropic-provider.ts:18`.)

## See also

- [02-tokenization.md](02-tokenization.md) — what the "tokens" in tokens-in-tokens-out actually are
- [03-sampling-parameters.md](03-sampling-parameters.md) — how `request.temperature` shapes the output
- [05-streaming.md](05-streaming.md) — why `complete()` returns the whole response, not a stream
- [08-provider-abstraction.md](08-provider-abstraction.md) — the adapters that implement this contract
- [../04-agents-and-tool-use/03-react-pattern.md](../04-agents-and-tool-use/03-react-pattern.md) — the loop that calls `complete()` per turn
