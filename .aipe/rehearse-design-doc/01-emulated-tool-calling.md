# RFC: Emulated tool-calling for the local Gemma provider

## 1. Summary

Gemma-over-Ollama has no native tool-calling API, so `GemmaModelProvider` **renders tool schemas into the system prompt and parses a JSON tool-call back out of the model's text** — turning a vendor that can't take a `tools` array into one that satisfies the same `ModelProvider` contract as Anthropic and OpenAI. Bounded retries, a corrective nudge, and a graceful text fallback keep a weak model's sloppy JSON from breaking the agent loop.

Lives in `packages/providers/gemma/src/gemma-provider.ts`.

## 2. Context / problem

The whole repo is built on one seam: every model rides `ModelProvider.complete(request) → ModelResponse`, where `ModelResponse.content` is an array of `text` and `tool_use` blocks (`packages/runtime/src/model-provider.ts`, lines 20, 48–58). The agent loop, the tool registry, the trace events — all of it assumes a provider can return a `ModelToolUseBlock`. That's how Anthropic and OpenAI providers work: you hand the SDK a `tools` array, it hands you back a structured tool-call.

Gemma running on local Ollama (`POST /api/chat`, no key, no TLS, `:11434`) doesn't have that API. There's no `tools` field on the request and no structured tool-call on the response — just a `message.content` string (`OllamaChatResponse`, lines 11–16). So either the local provider can't participate in tool-using agents at all, or it has to *fake* the contract everyone else implements natively.

The forcing function: the capstone `@aptkit/agent-rag-query` composes Gemma + the `search_knowledge_base` tool through `runAgentLoop`. For that to be agentic retrieval — the model *decides* when to search — the local provider has to emit `tool_use` blocks. Without emulation, the local default can't do RAG, and "runs with no cloud call" stops being true.

## 3. Goals & non-goals

**Goals**
- A local provider that satisfies `ModelProvider` including `tool_use` output, so it drops into `runAgentLoop` unchanged.
- Survive a weak model's malformed JSON without crashing the loop.
- Stay testable without a running Ollama — recorded responses must be injectable.

**Non-goals**
- Multi-tool / parallel tool-calls in one turn. The parser returns a single `{name, input}` (`parseToolCall`, lines 168–182).
- Matching frontier-model tool-call *reliability*. Emulation is a competence floor, not parity.
- A per-call network timeout. Cancellation is via `AbortSignal` only (see Open questions).

## 4. The decision

Two halves of one trick: **outbound**, fold the tool schemas into the system text and demand a bare JSON object; **inbound**, leniently parse the model's text back into a `ModelToolUseBlock`, retrying with a nudge if it fumbled.

```
  Emulated tool-calling — the two halves

  ┌─ Service layer: GemmaModelProvider.complete() ──────────────────────┐
  │                                                                     │
  │  request.tools[]  ──► buildSystemText()                             │
  │  (ModelTool[])         "You can call the following tools: <JSON>    │
  │                         respond with ONLY {"tool":..,"arguments"..}"│
  │                              │                                      │
  └──────────────────────────────┼──────────────────────────────────────┘
                                  │ hop 1: messages[] (system + turns)
                                  ▼
  ┌─ Provider layer: Ollama HTTP :11434 ────────────────────────────────┐
  │  POST /api/chat   {model, messages, stream:false}                   │
  │  (no `tools` field exists)        │                                 │
  └────────────────────────────────────┼────────────────────────────────┘
                                  │ hop 2: { message: { content: "..." } }
                                  ▼
  ┌─ Service layer: inbound parse ──────────────────────────────────────┐
  │  raw = response.message.content                                     │
  │       │                                                             │
  │       ▼                                                             │
  │  parseToolCall(raw) ── valid? ──► return [{type:'tool_use', ...}]   │
  │       │ null                                                        │
  │       ▼                                                             │
  │  looksLikeToolAttempt(raw)?  (contains '{')                         │
  │       │ yes → append RETRY_NUDGE, loop (≤ maxToolCallAttempts)      │
  │       │ no  → it's a real prose answer                              │
  │       ▼                                                             │
  │  return [{type:'text', text: raw}]   ← graceful fallback           │
  └─────────────────────────────────────────────────────────────────────┘
```

The kernel — name each part by what breaks if you remove it:

- **`buildSystemText()` (lines 133–165)** — renders each tool as `{name, description, input_schema}` JSON into the system message with the instruction "respond with ONLY a single JSON object." *Remove it:* the model never knows the tools exist; emulation is gone.
- **`parseToolCall()` (lines 168–182)** — runs the raw text through `parseAgentJson` (the same lenient extractor the runtime uses), then accepts `tool`/`name`/`tool_name` for the name and `arguments`/`input`/`args` for the input. *Remove it:* every reply is treated as prose; the model can never call a tool.
- **The retry loop (lines 62–89)** — up to `maxToolCallAttempts` (default 2, floored at 1) when tools were requested. On a retry it appends `RETRY_NUDGE` (lines 35–37). *Remove it:* one bad JSON emission and the tool-call is silently lost as text.
- **`looksLikeToolAttempt()` (lines 185–187)** — the `'{'` heuristic. Only retry if the model *tried* to emit JSON; plain prose is a legitimate answer, not a failure. *Remove it:* you burn a retry (and a model round-trip) every time the model correctly answers in words.
- **Graceful text fallback (line 91)** — when retries are spent or the reply is prose, return a `text` block. *Remove it:* a flaky local model throws instead of degrading to "here's my best text answer."

Optional hardening on top of that kernel: the **injectable `chat` transport** (`GemmaChatTransport`, lines 19–25; constructor line 48) — defaults to `defaultHttpTransport`, but tests feed recorded `OllamaChatResponse` objects so the provider runs with no Ollama process.

## 5. Alternatives considered

**A. Cloud-only frontier model with native tools (Anthropic/OpenAI).** The path of least resistance — `tools` array in, structured tool-call out, no parsing. *Why it lost:* it kills the local-default goal. Every run becomes a paid API call with a key requirement and a network dependency; you can't demo or develop offline. The repo deliberately keeps a no-cloud default. Flip condition: if reliability mattered more than locality (a production-grade tool-using agent), the frontier provider already exists in the repo and wins.

**B. Wait for a local model with native tool-calling.** Punt — keep Gemma text-only until Ollama exposes a structured tool API. *Why it lost:* it's a bet on someone else's roadmap to unblock your capstone agent. The emulation is ~50 lines; waiting is unbounded. You don't block a shippable feature on an external "soon."

**C. Constrained / grammar decoding (force the model to emit valid JSON at the token level).** Strongest *correctness* story — the model literally can't produce malformed JSON. *Why it lost:* Ollama's `/api/chat` doesn't expose grammar constraints in the path this provider uses, and it couples emulation to a decoding feature that the injectable-transport test seam doesn't model. The lenient-parse-plus-retry approach gets most of the benefit with none of the coupling.

## 6. Tradeoffs accepted

We chose prompt-rendered emulation, accepting that **a weak model's JSON is fragile** — Gemma will sometimes wrap the object in prose, add a trailing comment, or invent a filter argument. That's the cost, and it's owned, not apologized for. The mitigation isn't one guard, it's a chain: lenient `parseAgentJson` extraction, the bounded retry with a corrective nudge, and — critically — **two downstream guards in the retrieval layer that assume the model is unreliable**:

- `search_knowledge_base` floors `top_k` at `minTopK` (`packages/retrieval/src/search-knowledge-base-tool.ts`, line 81) so a model that asks for `top_k: 0` still gets results.
- `matchesFilter` (lines 101–106) only excludes a hit that *has* the filter key with a different value — a hallucinated filter like `{textContains: "x"}` is ignored rather than wiping every result.

The emulation is brittle by nature; the system is built to tolerate the brittleness downstream.

## 7. Risks & mitigations

```
  Risk → guard

  malformed JSON tool-call    ─► parseAgentJson lenient extract + RETRY_NUDGE
  model answers in prose       ─► looksLikeToolAttempt skips the wasted retry
  retries exhausted            ─► graceful text-block fallback (no throw)
  hallucinated filter args     ─► matchesFilter ignores unknown keys
  model asks for top_k:0       ─► minTopK floor
  Ollama process down / hangs  ─► AbortSignal only — NO per-call timeout (open)
```

The one risk with no guard is a hung Ollama call with no `signal` passed: `complete()` checks `request.signal?.throwIfAborted()` (lines 53, 63) but there's no internal `fetch` timeout in `defaultHttpTransport` (lines 201–215). A wedged local server blocks the turn indefinitely.

## 8. Rollout / migration

Nothing to migrate — this is additive. Gemma is one more `ModelProvider` adapter; it ships inside the `@rlynjb/aptkit-core` bundle as `@aptkit/provider-gemma` and slots into `runAgentLoop` exactly like the cloud providers. No existing caller changes: an agent that wired Anthropic keeps working; pointing it at Gemma is a one-line provider swap. The injectable transport means tests and fixtures keep running with zero Ollama dependency.

## 9. Open questions

- **No per-call fetch timeout.** Should `defaultHttpTransport` wrap `fetch` in an `AbortController` with a deadline, or stay caller-driven via `signal`? Today a hung Ollama hangs the turn.
- **Single tool-call per turn.** `parseToolCall` returns one call. If a local model ever wants to fan out two tools in a turn, the parser needs to accept an array — currently it rejects arrays outright (line 175).
- **Retry budget is global-ish.** `toolUseCount` increments across calls for id uniqueness (lines 110–114), but `maxToolCallAttempts` is per-`complete()`. Is 2 the right default for a 9B model, or should it scale with model size?

---

**Coach note.** A reviewer's first push is "you're parsing LLM text — that's a hack." The framing that holds: *"It's emulating a contract the frontier providers get natively, behind the same `ModelProvider` interface, so the agent loop doesn't know the difference — and the brittleness is contained by `minTopK` and `matchesFilter` downstream, not papered over."* Lead with the contract, not the parser. The sentence that gets the yes is naming the guard people forget — the `'{'` heuristic that avoids burning a retry on a correct prose answer. That detail says you built it, not just sketched it.
