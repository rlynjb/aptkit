# What an LLM is

Large language model · the IO model (Industry standard)

A model is a function. Tokens in, tokens out. That's the whole thing. It's not a database you query, not a reasoner that "thinks," not a planner that holds intent across calls. Every bug you'll chase in your first year comes from forgetting that.

## Zoom out, then zoom in

Here's where the LLM sits in aptkit. Everything above it is your code; the model is one stateless box near the bottom.

```
aptkit — where the model lives
┌─────────────────────────────────────────────┐
│ Capabilities (analytics / RAG agents)        │  your features
├─────────────────────────────────────────────┤
│ Agent loop + structured generation           │  orchestration
├─────────────────────────────────────────────┤
│ ★ ModelProvider.complete(request)→response   │  THE IO MODEL ← you are here
├─────────────────────────────────────────────┤
│ Adapters: anthropic / openai / gemma / ...   │  vendor glue
├─────────────────────────────────────────────┤
│ The model itself (remote API or local Ollama)│  the function
└─────────────────────────────────────────────┘
```

The pattern is "the model as a pure function with a typed boundary." The question it answers: *what is the smallest honest shape of an LLM call?* Answer: one request object goes in, one response object comes out, and nothing is remembered between calls. If you've ever written a `fetch()` with `{loading, success, error}` states, you already know this shape — the model is the server on the other end of that fetch, and like any server it has no memory of your last request unless you resend it.

## Structure pass

The layers, top to bottom: your feature → orchestration → the `ModelProvider` contract → an adapter → the model. Pick the **state** axis and trace it down.

```
STATE axis — who remembers anything?
Layer                         remembers context?
─────────────────────────────────────────────
Capability / feature          yes (it owns the goal)
Agent loop                    yes (it accumulates messages)
ModelProvider.complete()      NO  ←★ seam: state dies here
The model                     NO  (every call is the first call)
```

The seam is at `complete()`. Above it, your code holds the conversation. Below it, there is no conversation — only the exact bytes you put in `request.messages` this call. The model doesn't "know" what it said last turn; your loop reminded it by replaying the transcript. Memory is an illusion you maintain by resending history.

## How it works

**Mental model.** Think of the model as `f(prompt) → next_token`, called in a loop until it emits a stop. aptkit wraps that loop behind one method so you never see the token-by-token grind — you hand it a request, you get a finished response.

```
The IO model — one call
  request                          response
  ┌──────────────┐                 ┌──────────────────┐
  │ system?      │                 │ content: blocks[] │
  │ messages[]   │ ─ complete() ─▶ │ usage?            │
  │ tools?       │                 │ model?            │
  │ maxTokens?   │                 └──────────────────┘
  │ temperature? │
  │ signal?      │
  └──────────────┘
```

**The contract is the IO model, verbatim.** aptkit doesn't describe the function-shape in a comment — it encodes it as a type. Look at the port itself.

```ts
// packages/runtime/src/model-provider.ts:54-58
export type ModelProvider = {
  id: string;                                    // which adapter
  defaultModel?: string;                         // fallback model id
  complete(request: ModelRequest): Promise<ModelResponse>;  // f(in)→out
};
```

One method. No `streamTokens`, no `getState`, no `remember`. The entire surface of "talk to an LLM" is `complete(request) → Promise<response>`. That `Promise` is the only async story — same mental model as an `await fetch()`.

**The request is the whole world the model sees.** Everything the model gets to condition on is in this one object — there's no hidden channel.

```ts
// packages/runtime/src/model-provider.ts:39-46  (ModelRequest)
system?:      string;            // the standing instruction
messages:     ModelMessage[];    // the replayed transcript (your "memory")
tools?:       ModelTool[];       // functions the model may ask to call
maxTokens?:   number;            // output budget
temperature?: number;            // randomness knob
signal?:      AbortSignal;       // cancellation — same as fetch's signal
```

If a fact isn't in `system` or `messages`, the model cannot use it. That's the load-bearing line. "Why did it forget my name?" Because `messages` didn't include the turn where you said it.

**The response is typed blocks, not a string.** Output isn't raw text — it's an array of content blocks, because the model can emit either text or a request to call a tool.

```ts
// packages/runtime/src/model-provider.ts:48-52, 1-11  (ModelResponse + blocks)
content: ModelContentBlock[];    // [{type:'text'}] or [{type:'tool_use'}]
usage?:  { ... };                // token counts (see 06-token-economics)
// ModelTextBlock    {type:'text', text}
// ModelToolUseBlock {type:'tool_use', id, name, input}
```

A `tool_use` block is the model saying "I'd call `getWeather({city})` — you run it." It didn't run anything. It returned a *request to run something*, and your loop decides what to do. Still just IO.

**The principle.** Most LLM bugs come from treating the model as more than a next-token function — as a memory, a database, a will. aptkit's contract makes the function boundary explicit so the category error is hard to make: there's no method to misuse. When something breaks, you ask "what was in the request?" not "what is the model thinking?"

## Primary diagram

The full round trip Move 2 walked: your code builds a request, the contract carries it to an adapter, the model returns typed blocks, and nothing persists.

```
One complete() round trip
  YOUR CODE                       ModelProvider              MODEL
  ─────────                       ─────────────              ─────
  build request   ── complete(req) ──▶  adapter maps  ──▶  f(prompt)
   system+messages                       to vendor API       → tokens
   +tools+temp                                                  │
        ▲                                                       │
        │                                                       ▼
  read content[]  ◀── ModelResponse ──  adapter maps  ◀──  text or
   text | tool_use     {content,usage}   from vendor        tool_use
        │
        ▼
  (state lives HERE, never below the line)
```

After the arrow returns, the model remembers nothing. Next call starts cold.

## Elaborate

This shape comes from the transformer's autoregressive decoder: predict the next token given all prior tokens, append, repeat. "Chat," "memory," and "agents" are all software conveniences layered on top of that one operation. The contract here is a textbook **port** in hexagonal architecture (see `08-provider-abstraction.md`) — the rest of aptkit depends on this interface, never on a vendor SDK. Read `02-tokenization.md` next to see what "tokens" actually are, then `03-sampling-parameters.md` for how `temperature` shapes the next-token pick.

## Project exercises

### Make the function boundary visible

- **Exercise ID:** `EX-LLM-01a`
- **What to build:** A tiny CLI script that constructs a `ModelRequest` by hand (system + one user message, no tools), calls `complete()` on the Gemma provider, and prints the raw `content` blocks plus `usage`. No agent loop, no capability — just the bare function call.
- **Why it earns its place:** Phase 1 is about internalizing that the model is `f(request)→response`. Calling `complete()` with nothing wrapped around it burns the IO shape into your hands; you see that one request is the model's entire universe.
- **Files to touch:** read `packages/runtime/src/model-provider.ts`; instantiate from `packages/providers/gemma/src/gemma-provider.ts`; write a new throwaway script under a scratch dir (do not edit repo source).
- **Done when:** running it prints a `ModelTextBlock`, and adding a second message that references the first proves the model only "remembers" what you replayed.
- **Estimated effort:** `<1hr`

## Interview defense

**Q: Is an LLM stateful?**

```
  call 1: messages=[A]        → reply R1   (model sees A)
  call 2: messages=[A,R1,B]   → reply R2   (model sees A,R1,B — you resent it)
          └────────────────┘
           state lives in YOUR array, not the model
```

No. Each `complete()` call is independent; the only "memory" is the transcript you replay in `messages`. Anchor: *the model is amnesiac; your message array is the memory.*

**Q: The model "called a function" — did it?**

```
  response.content = [{type:'tool_use', name:'getX', input:{...}}]
                      └── a REQUEST to call, not a call ──┘
  your loop runs getX(), appends the result, calls complete() again
```

No. A `tool_use` block is the model *asking* you to run something. Your loop executes it and feeds the result back. The model only ever emits tokens. Anchor: *tool_use is a return value, not a side effect.*

## See also

- [`02-tokenization.md`](./02-tokenization.md) — what the "tokens" in/out actually are.
- [`03-sampling-parameters.md`](./03-sampling-parameters.md) — how the next-token pick is shaped.
- [`08-provider-abstraction.md`](./08-provider-abstraction.md) — the contract as a swappable port.
