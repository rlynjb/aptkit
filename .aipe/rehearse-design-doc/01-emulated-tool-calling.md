# RFC 01 — Emulated tool-calling for a tool-less local model

**Summary:** Gemma over Ollama has no native tool-calling API, so the adapter
(`GemmaModelProvider`) renders tool schemas into the system prompt, demands a
single JSON object back, and parses it into the runtime's tool-use block
(`ModelToolUseBlock`) — with bounded retries and a graceful text fallback — so a
local model satisfies the same `ModelProvider` contract that Anthropic and
OpenAI do.

## Context / problem

AptKit's whole core depends on one provider contract (`ModelProvider.complete()`
in `packages/runtime/src/model-provider.ts`). A `ModelRequest` can carry a
`tools` array; the agent loop (`runAgentLoop`) expects the response to come back
as content blocks, where a `tool_use` block means "the model wants to call this
tool with these arguments." Anthropic and OpenAI both have native tool-calling
APIs that produce exactly that.

Gemma, run locally through Ollama's `POST /api/chat`, has no such API. The
request body Ollama accepts is a flat `messages` array of `{role, content}`
strings — there is nowhere to put a `tools` array, and nothing in the response
that comes back as a structured tool call. The Ollama chat response is just
`{ message: { content: "<text>" } }`.

So the constraint is concrete: the contract promises tool-calling; the local
transport offers a text-in / text-out channel. Either the local provider can't
participate in any agent that uses tools — which is most of them, including the
capstone RAG agent — or the gap gets closed inside the adapter.

## Goals & non-goals

**Goals:**

- `GemmaModelProvider` satisfies the same `ModelProvider` contract as the cloud
  adapters — a tool-using agent runs against it unchanged.
- A tool call comes back as a real `ModelToolUseBlock` the loop can dispatch.
- Survive a weak model's malformed JSON without crashing the loop.
- Stay testable offline — no live Ollama required to test the parse logic.

**Non-goals:**

- Matching frontier-model tool-calling *quality*. Gemma will be worse at
  deciding when and how to call a tool; this RFC closes the *mechanism* gap, not
  the capability gap.
- Parallel/multi-tool calls in one turn. One JSON object = one tool call.
- Streaming. The transport is `stream: false`.
- A general grammar-constrained decoder. Out of scope (see Alternatives).

## The decision

Emulate the tool-calling protocol inside the adapter, in two halves — an
outbound half that teaches the model the protocol, and an inbound half that
parses the model's attempt back into the contract's shape, guarded by a bounded
retry loop.

```
  Emulated tool-calling — the adapter bridges contract ⇄ text transport

  ┌─ Runtime layer ───────────────────────────────────────────────┐
  │  runAgentLoop  →  ModelRequest { system, messages, tools[] }   │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ complete(request)
  ┌─ Provider layer (GemmaModelProvider) ──────────────────────────┐
  │                                                                 │
  │  OUTBOUND  buildSystemText():                                   │
  │    system + "You can call the following tools:" + JSON schemas  │
  │    + "respond with ONLY {\"tool\":...,\"arguments\":{...}}"     │
  │                              │                                  │
  │            ┌─────────────────▼─────────────────┐  retry ≤ N    │
  │            │  for attempt in 0..maxAttempts:    │◄────────────┐ │
  │            │    chat(messages) → raw text       │             │ │
  │            │    call = parseToolCall(raw)       │             │ │
  │            │    if call → return tool_use block ├──► done     │ │
  │            │    if looksLikeToolAttempt(raw):   │             │ │
  │            │       append RETRY_NUDGE ──────────┼─────────────┘ │
  │            │    else break (prose is an answer) │               │
  │            └─────────────────┬──────────────────┘               │
  │                              │ no valid call after N attempts   │
  │                   return { type:'text', text: raw }  (fallback) │
  └───────────────────────────────┬────────────────────────────────┘
                                  │ HTTP POST /api/chat (injectable transport)
  ┌─ Provider / transport boundary ────────────────────────────────┐
  │  Ollama :11434   message:{role,content}  (no native tools)      │
  └─────────────────────────────────────────────────────────────────┘
```

The load-bearing parts, by what breaks if you remove each:

- **Outbound schema injection** (`buildSystemText`, lines 133–165). Drop it and
  the model has no idea the tools exist — it answers in prose every time and the
  agent never retrieves anything. This is what makes the text channel carry a
  tool protocol at all.
- **Lenient parse** (`parseToolCall`, lines 168–182). It runs `parseAgentJson`
  (the runtime's tolerant extractor that digs JSON out of prose/code-fences),
  then accepts `tool | name | tool_name` for the name and `arguments | input |
  args` for the args. Drop the leniency and a model that says `"name"` instead
  of `"tool"`, or wraps the JSON in a code fence, fails a call it actually got
  right.
- **The `looksLikeToolAttempt` heuristic** (lines 185–187): a `'{'` in the reply
  is the cheap tell that the model *tried* a tool call and botched it. This is
  the part that decides retry-vs-accept. Without it you face a dilemma: retry on
  *every* non-call and you punish a model that correctly answered in prose
  (burning attempts, latency); retry on *none* and a single malformed brace
  throws the call away. The `'{'` check splits the two cases cheaply.
- **Bounded `maxToolCallAttempts`** (default 2, floored at 1, lines 49, 57). On
  a retry it appends `RETRY_NUDGE` — a corrective message telling the model
  exactly the JSON shape to emit. Drop the bound and a model that never produces
  valid JSON loops forever against your local GPU.
- **Graceful text fallback** (line 91). After the attempts are spent, whatever
  text came back is returned as a `text` block — a real answer, not an error.
  Drop it and a hard question (model genuinely can't form the call) crashes
  instead of degrading to a plain answer.

Optional hardening already in place: the **injectable transport**
(`GemmaChatTransport`, lines 19–25) lets tests feed recorded Ollama responses,
so the entire parse/retry path is testable with zero network.

## Alternatives considered

**1. Cloud-only — use Anthropic/OpenAI native tools, skip local entirely.**
Native tool-calling is more reliable and the code is simpler (no emulation).
*Why it lost:* AptKit's premise is a local-first agent body (buffr runs on a
laptop, no cloud call in the default path). A cloud-only tool story means no
offline operation and a per-call API bill for every agent step. The local
provider is a product requirement, not a nice-to-have.

**2. Wait for a local model with native tool-calling.** Punt the problem; let
the ecosystem ship a tool-native local model and adopt it. *Why it lost:* it's a
bet on someone else's timeline against a real deadline, and it leaves the
contract un-implementable for local in the meantime. Emulation is reversible —
when a tool-native local model lands, the adapter swaps and the contract is
unchanged. Waiting is the more expensive option, not the cheaper one.

**3. Grammar / constrained decoding.** Force the model's output to a JSON
grammar at the token level so the reply is *always* parseable. *Why it lost:*
Ollama's `/api/chat` doesn't expose a portable grammar knob across model
versions, and constrained decoding still doesn't make the model pick the right
tool — it makes the *syntax* valid, not the *choice* correct. It's more
machinery for the easier half of the problem. The prompt-render + lenient-parse
approach handles the same syntax failure with a retry and stays portable.

## Tradeoffs accepted

We chose prompt-rendered emulation, accepting that a weak model's JSON is
fragile — it will sometimes emit malformed or wrong-keyed tool calls. We absorb
that fragility deliberately, at four layers:

- the **retry + `RETRY_NUDGE`** gives the model a second, corrected shot;
- the **lenient parse** accepts key variants and fenced JSON;
- downstream, the retrieval tool's **`minTopK` floor**
  (`packages/retrieval/src/search-knowledge-base-tool.ts:51,81`) stops a weak
  model from starving its own retrieval by passing `top_k: 1`;
- and the tool's **hallucination-tolerant `matchesFilter`** (lines 101–106)
  ignores filter keys absent from a chunk's meta, so a hallucinated filter can't
  silently wipe every result.

That's the honest shape of it: the model is the weak link, so the code around it
is forgiving on purpose. The cost is more defensive code than a frontier
provider needs. The benefit is a local model that actually completes tool-using
agent runs.

## Risks & mitigations

- **Model never produces valid JSON** → bounded attempts + text fallback: the
  run degrades to a plain answer instead of hanging or crashing.
- **Correct prose answer mistaken for a botched call** → `looksLikeToolAttempt`
  only retries when a `'{'` is present; brace-free prose is accepted as the
  answer on the first pass.
- **Tool-use ids collide within a run** → `nextToolUseId` increments a
  per-instance counter (`gemma-<tool>-<n>`, lines 110–114), so each emitted
  block has a unique id the loop can match a result to.
- **Untestable without a live model** → the injectable `GemmaChatTransport`
  feeds recorded responses; the parse/retry logic is covered offline.

## Rollout / migration

Additive. The adapter is a new `ModelProvider` (`@aptkit/provider-gemma`); no
existing agent or contract changed shape. An agent opts in by being constructed
with a `GemmaModelProvider` instead of the Anthropic/OpenAI one — the capstone
RAG agent (`@aptkit/agent-rag-query`) is the first consumer. Default model
`gemma2:9b`, host `http://localhost:11434`, both overridable. When a tool-native
local model arrives, replace the adapter internals; callers and the contract
don't move.

## Open questions

- **No per-call fetch timeout.** The default transport (lines 201–215) honors an
  `AbortSignal` but sets no timeout of its own — a wedged Ollama process can
  hang a call indefinitely until something upstream aborts. The fix is a
  per-call timeout in `defaultHttpTransport`; it isn't there yet.
- **Is the `'{'` heuristic too coarse?** A prose answer that legitimately
  contains a brace (a code snippet, JSON-in-an-explanation) trips a retry it
  shouldn't. Cheap and good enough today; worth revisiting if it shows up in
  eval traces.
- **`maxToolCallAttempts` default of 2** is a guess, not a measured optimum. No
  eval yet ties attempt count to tool-call success rate per model size.
