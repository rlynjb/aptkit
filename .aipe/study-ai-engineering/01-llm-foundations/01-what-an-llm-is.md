# What an LLM actually is

**Subtitle:** The model as a function · text → text · *Industry standard*

## Zoom out, then zoom in

Before any mechanism, here's where "the model" sits in aptkit. Everything above
it is your code; the model is one box near the bottom that turns input text into
output text.

```
  Zoom out — where the model sits in aptkit

  ┌─ Capability layer ──────────────────────────────────────────┐
  │  rag-query / query / recommendation agents                  │
  └───────────────────────────┬─────────────────────────────────┘
                              │ runAgentLoop
  ┌─ Runtime layer ───────────▼─────────────────────────────────┐
  │  ModelProvider.complete(request) → response                 │ ← we are here
  └───────────────────────────┬─────────────────────────────────┘
                              │ HTTP / SDK
  ┌─ Provider / model ────────▼─────────────────────────────────┐
  │  ★ the LLM ★  (Gemma / Claude / GPT) — predicts next token  │
  └──────────────────────────────────────────────────────────────┘
```

Now zoom in. An LLM is a function. You hand it text, it hands you text. It is not
a database, not a reasoner, not a planner — those are things your code builds
*on top of* the function. Most LLM bugs come from treating the model as more than
it is. aptkit's whole architecture is an answer to "given that the model is just
this function, what do we wrap around it?"

## Structure pass

**Layers.** Capability → runtime contract → provider → model. The model is the
innermost layer; the contract `ModelProvider.complete()` is the seam that hides
it.

**Axis — control.** Who decides what happens? Trace it down: the capability
decides the *task*; the runtime loop decides *how many turns*; the model decides
only *the next token*. The model has no control over its own invocation. That
single fact is why aptkit can swap Gemma for Claude without any agent noticing.

**Seam.** The load-bearing boundary is `ModelProvider` (`model-provider.ts:54`).
Above it: your typed request/response. Below it: vendor-specific HTTP. The axis
"who knows about the vendor?" flips exactly here — above, nobody; below,
everything.

## How it works

### Move 1 — the mental model

You know how a `fetch()` is just `Request → Response` and you don't care what
server answers it? The model is that, but the response is *predicted*, not
retrieved. Same plug, different guarantee: `fetch` returns what exists; the model
returns what's *likely*.

```
  The LLM as a pure function

      input tokens                    output tokens
   ┌──────────────┐   ┌───────────┐  ┌──────────────┐
   │ "What ORM    │──►│   LLM     │─►│ "It depends  │
   │  should I…"  │   │ (predict  │  │  on…"        │
   └──────────────┘   │  next     │  └──────────────┘
                      │  token)   │
                      └───────────┘
   no memory · no side effects · same-ish input → same-ish output
```

### Move 2 — the contract aptkit wraps around it

**The request shape.** aptkit models the function as one TypeScript type. Here's
the actual contract — `packages/runtime/src/model-provider.ts:39`:

```ts
export type ModelRequest = {
  system?: string;                 // standing instructions
  messages: ModelMessage[];        // the conversation so far
  tools?: ModelTool[];             // capabilities the model MAY ask to call
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;            // cancellation — the model call is I/O
};
```

Read it as "everything the function needs": instructions, history, the menu of
tools, and the knobs. `signal` is the giveaway that this is I/O, not computation
— you can abort an in-flight call.

**The response shape.** `model-provider.ts:48`:

```ts
export type ModelResponse = {
  content: ModelContentBlock[];    // text blocks AND/OR tool_use blocks
  usage?: ModelUsage;              // tokens in/out, for the ledger
  model?: string;
};
```

The key surprise: `content` is an array of *blocks*, not a string. A response can
be `[{type:'text'}]` or `[{type:'tool_use'}]` or both. That's because the model's
"output text" sometimes encodes a request to call a tool — the runtime parses
those blocks back out (`run-agent-loop.ts:66`, `toolUsesFromContent`).

**The function itself.** `model-provider.ts:54`:

```ts
export type ModelProvider = {
  id: string;
  defaultModel?: string;
  complete(request: ModelRequest): Promise<ModelResponse>;  // the whole function
};
```

One method. Everything aptkit does — RAG, agents, evals, fallback — is built on
this one async call. When the spec says "the model is just a function," this type
is that sentence in code.

### Move 3 — the principle

Model the LLM as the *smallest possible* interface and push everything else into
your own layers. The model predicts tokens; your code does memory, control flow,
validation, and side effects. aptkit's `complete()` is the cleanest expression of
that discipline — and it's exactly why the model is swappable.

## Primary diagram

```
  The LLM function and the contract that hides it

  your code                         aptkit contract            the model
  ┌──────────────┐  ModelRequest    ┌─────────────────┐  HTTP  ┌──────────┐
  │ agent / chain│ ───────────────► │ complete(req):  │ ─────► │ predicts │
  │              │                  │   Promise<resp> │        │ next tok │
  │              │ ◄─────────────── │                 │ ◄───── │          │
  └──────────────┘  ModelResponse   └─────────────────┘        └──────────┘
                    (content blocks: text | tool_use)
   above the seam: typed, vendor-free   │   below: Gemma/Claude/GPT specifics
```

## Elaborate

The "model as function" framing comes from treating the LLM the way you'd treat
any external service: a boundary with a contract. The historical mistake was
embedding vendor SDKs directly in business logic — then a model swap is a rewrite.
aptkit's `ModelProvider` is the antidote, and it's load-bearing: the fallback
chain (`06/05`), the context guard, and every agent depend on it. Read
`08-provider-abstraction.md` next — it walks how this one type makes Gemma,
Claude, and GPT interchangeable.

## Project exercises

### Add a token-count assertion to the contract's tests
- **Exercise ID:** —  (no curriculum file in repo)
- **What to build:** a unit test that constructs a `ModelRequest`, runs it
  through a `FixtureModelProvider`, and asserts the returned `ModelResponse.usage`
  has `inputTokens`/`outputTokens` populated.
- **Why it earns its place:** proves you understand the function returns metadata,
  not just text — the seam most candidates miss.
- **Files to touch:** `packages/runtime/src/model-provider.ts` (no change),
  a new `packages/runtime/test/model-provider-contract.test.ts`.
- **Done when:** `node --test` passes asserting usage fields on a fixture response.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: "What is an LLM, in one sentence, to an engineer?"**
A function from text to text that predicts likely continuations — no memory, no
side effects, no guarantees of truth. Everything else (RAG, agents, tools) is
scaffolding your code builds around that function.

```
  text ──► [predict next token] ──► text     (that's the whole model)
   the rest — memory, tools, control — is YOUR layer
```
Anchor: *the model is `complete(req): Promise<resp>` — one method.*

**Q: "Why is `content` an array of blocks instead of a string?"**
Because a single model turn can be prose, a tool-call request, or both. Modeling
it as blocks lets the runtime split text from `tool_use` and route each
(`run-agent-loop.ts:126,131`). A string would force fragile parsing.
Anchor: *text and tool_use are co-equal content, not one parsed from the other.*

## See also

- `08-provider-abstraction.md` — the seam in full
- `04-agents-and-tool-use/02-tool-calling.md` — what a `tool_use` block becomes
- `06-token-economics.md` — what `usage` feeds
