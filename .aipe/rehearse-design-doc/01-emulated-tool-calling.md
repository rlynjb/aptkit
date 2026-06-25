# RFC 01 — Emulate native tool-calling inside the Gemma provider

**Summary:** Because the default model (local Gemma2:9b over Ollama) has no native tool-calling, `GemmaModelProvider` emulates it — rendering tool schemas into the system prompt outbound and parsing a lenient JSON tool call inbound — so the rest of the system sees the same `ModelToolUseBlock` shape a frontier model would return, behind the unchanged `ModelProvider` contract.

---

## Context / problem

The default provider is local Gemma2:9b, served by Ollama at `localhost:11434` over `POST /api/chat`. That's a deliberate constraint — the default path makes zero cloud calls (cost), nothing leaves the machine (privacy), and open weights force you to understand the parts a cloud SDK hides (learning). buffr, the deployment target, is a laptop runtime, so local-default is a product requirement, not a preference.

The problem is a capability gap. Anthropic and OpenAI hand you a `tools` array on the way in and a structured `tool_use` block on the way back. Gemma gives you neither — it's a text-in, text-out chat model. But the rest of the system is already written against the frontier shape: `packages/runtime/src/model-provider.ts` defines `ModelToolUseBlock` as `{ type: 'tool_use', id, name, input }`, and the agent loop, the tool registry, and every consumer expect exactly that. So either the default model can't call tools — which kills the whole point of an agent — or the gap gets closed somewhere.

> ┃ The constraint isn't "Gemma is weaker." It's "Gemma
> ┃ can't even physically emit the shape the system runs
> ┃ on." That's a structural gap, not a quality gap — and
> ┃ structural gaps you close in an adapter.

---

## Goals & non-goals

**Goals**
- A local model can drive tool calls without any consumer knowing it's local.
- The emulation is invisible above the provider seam — `ModelToolUseBlock` in, `ModelToolUseBlock` out.
- Fully testable with no network (recorded Ollama responses).
- A weak model that botches the JSON degrades gracefully — no crash, no infinite loop.

**Non-goals**
- Not trying to make Gemma's JSON *reliable* — only to tolerate its unreliability.
- Not building a general grammar/constraint engine — the system prompt + lenient parse is the whole mechanism.
- Not changing the `ModelProvider` contract to accommodate Gemma. The emulation lives entirely inside the adapter; the contract stays vendor-neutral.
- Not handling streaming. The contract is request/response.

The load-bearing non-goal is the third one: **the contract does not bend for Gemma.** That's what keeps swapping to a native-tool model a one-line change instead of a refactor.

---

## The decision

The shape: outbound, Gemma's lack of a `tools` array is faked by writing the tools into the system text and demanding a single JSON object back; inbound, that messy text is parsed leniently into the canonical block, with a bounded retry when it looks like a botched attempt and a graceful exit to plain text when it doesn't.

```
  EMULATED TOOL-CALLING — inside GemmaModelProvider

  ┌─ Caller (agent loop) ───────────────────────────────────┐
  │  ModelRequest { messages, tools: ModelTool[] }           │
  └───────────────────────────────┬─────────────────────────┘
                                  │ same contract as Anthropic/OpenAI
  ┌─ Provider adapter (the seam) ─▼─────────────────────────┐
  │                                                          │
  │  OUTBOUND  buildSystemText():                            │
  │    render each tool's JSON schema into system text       │
  │    + "respond with ONLY a single JSON object             │
  │       {tool, arguments}, no prose"                       │
  │                          │                               │
  └──────────────────────────┼───────────────────────────────┘
                            │ POST /api/chat  (Ollama)
  ┌─ Provider (Ollama, localhost:11434) ▼───────────────────┐
  │  Gemma2:9b → text (maybe JSON, maybe prose, maybe junk)  │
  └──────────────────────────┬───────────────────────────────┘
                            │ raw text back
  ┌─ Provider adapter (the seam) ▼──────────────────────────┐
  │  INBOUND  parseToolCall():                               │
  │    parseAgentJson(raw)   ← tolerant of fences/prose      │
  │    map  tool|name|tool_name  → name                      │
  │         arguments|input|args → input                     │
  │                                                          │
  │    ┌──────────────┬───────────────┬──────────────────┐  │
  │    │ valid call?  │ looks like a  │ plain prose?     │  │
  │    │   → emit     │ botched try?  │   → return as    │  │
  │    │ tool_use     │ (has a '{')   │   text block     │  │
  │    │ block        │  → RETRY_NUDGE│   (graceful exit)│  │
  │    │              │  bounded by   │                  │  │
  │    │              │ maxToolCall-  │                  │  │
  │    │              │ Attempts (2)  │                  │  │
  │    └──────────────┴───────────────┴──────────────────┘  │
  └───────────────────────────────┬─────────────────────────┘
                                  │ ModelToolUseBlock | ModelTextBlock
  ┌─ Caller ──────────────────────▼─────────────────────────┐
  │  identical to what Anthropic would have returned         │
  └──────────────────────────────────────────────────────────┘
```

That diagram is the whole decision: the gap is closed in two halves inside one adapter, and the caller above the seam never learns the difference.

**Outbound** — `buildSystemText` (gemma-provider.ts) serializes each `ModelTool`'s `name`, `description`, and `inputSchema` into the system text, then appends the instruction: *"When a tool is needed, respond with ONLY a single JSON object, no prose: `{"tool": "<tool name>", "arguments": { ...arguments... }}`."* The `tools` array a frontier API would take becomes prose Gemma can read.

**Inbound** — `parseToolCall` runs the raw reply through `parseAgentJson`, which is tolerant of code fences and surrounding prose, then maps `obj.tool ?? obj.name ?? obj.tool_name` into `name` and `obj.arguments ?? obj.input ?? obj.args` into `input`. The three aliases each side absorb the ways a weak model rephrases the contract.

**Robustness** — three guards, named by what breaks without them:
- `maxToolCallAttempts` (default 2) bounds the retry loop. Without it, a model that structurally can't emit JSON loops forever.
- `RETRY_NUDGE` is appended as a user message on the second attempt — a corrective "your previous reply was not a valid tool call, respond with ONLY…". Without it, the retry asks the same question and gets the same junk.
- `looksLikeToolAttempt` gates the retry on the cheap tell — the text contains a `{`. Without it, plain prose (a legitimate text answer) would be treated as a failed tool call and burn a retry; with it, prose returns immediately as a real `ModelTextBlock`. That's the graceful exit.

> ┃ The boundary condition is the whole craft here:
> ┃ distinguish "tried to call a tool and failed" from
> ┃ "answered in prose on purpose." A '{' is the tell.
> ┃ Get that wrong and every chat reply costs a retry.

**Testability** — the `chat` option injects a `GemmaChatTransport`, so tests feed recorded `OllamaChatResponse` objects and exercise the full outbound-render → inbound-parse → retry path with zero network. The default transport (`defaultHttpTransport`) is only reached in production.

---

## Alternatives considered

Three real options were on the table. Each lost for a stated reason — this is the "design it twice" written down.

**(a) Cloud-only frontier model with native tools (Anthropic/OpenAI).**
The zero-effort path: native `tools` in, native `tool_use` out, no emulation. It lost because it kills the three reasons the default is local — cost (every call bills), privacy (data leaves the laptop), and learning (the SDK hides exactly the mechanism worth understanding). For buffr, a laptop runtime, cloud-default is the wrong default outright. Cloud stays available as a *fallback* behind the same contract, but it can't be the floor.

**(b) Wait for a local model with native tool-calling.**
Defer the problem until a local 9B-class model ships reliable native tools. It lost because none existed reliably at that class when this was built, and the bigger cost is coupling: waiting ties the roadmap to upstream model releases you don't control. The emulation ships now and stays useful even after such a model exists, because it lives behind a swappable seam.

**(c) Constrained decoding / grammar-forced JSON.**
Force the model to emit syntactically valid JSON at the decode level — the "correct" answer in the limit. It lost on cost-of-access: the Ollama `/api/chat` path didn't expose grammar constraints simply, and the lenient-parse-plus-nudge approach was cheaper to build and good enough in practice. This one is explicitly *deferred, not rejected* — see Open questions.

```
  WHERE A REVIEWER PUSHES — "constrained decoding is the right answer"

  Don't defend lenient parsing as superior. Concede the point and
  scope it: "Grammar-forced JSON is more correct. It lost on
  cost-of-access — Ollama didn't expose it simply — so I shipped the
  cheaper mechanism that's good enough against a real weak model, and
  I named constrained decoding as the upgrade path in open questions."
  That gets the yes; arguing it's better does not.
```

---

## Tradeoffs accepted

We chose to run tools on a weak local model, accepting that its JSON is fragile. That fragility is owned, not waved away — it's bounded by three layers:

- The retry + lenient parse inside the provider absorb the *common* failures (fences, prose wrapping, key aliasing).
- Two downstream guards in `packages/retrieval/src/search-knowledge-base-tool.ts` absorb the *consequences* of a weak model's bad tool arguments: `minTopK` floors the requested `top_k` so the model can't starve its own retrieval by asking for one chunk, and `matchesFilter` is written so a hallucinated filter key can't wipe every result — a key only excludes hits that *have* that key with a different value, so an invented `{textContains: "x"}` is ignored rather than fatal.

The cost is real: a frontier model would need none of this. We pay extra adapter code and two defensive guards to make a weak model behave. The buy is a default path that runs free, offline, and private.

---

## Risks & mitigations

```
  RISK                              MITIGATION
  ────                              ──────────
  Model structurally can't emit     maxToolCallAttempts (default 2) bounds
  JSON → burns retries forever      the loop; it falls back to text, not a hang

  Prose answer mistaken for a       looksLikeToolAttempt gates retry on a '{';
  failed tool call → wasted retry   prose returns immediately as a text block

  Weak model passes bad tool args   minTopK floor + hallucination-tolerant
  → starved or wiped retrieval      matchesFilter, downstream in the tool

  No per-call timeout on the fetch  UNMITIGATED — a wedged Ollama daemon hangs
                                    the call. Named as an open question.
```

The fourth row is the honest one: `defaultHttpTransport` passes the request `signal` through to `fetch`, so an *aborted* request is honored, but there is no per-call timeout. A wedged daemon that accepts the connection and never responds will hang. Naming it is the staff move.

---

## Rollout / migration

This shipped behind the existing `ModelProvider` contract, so rollout was a non-event for callers — the agent loop already spoke `ModelProvider.complete()`, and `GemmaModelProvider implements ModelProvider`. Nothing above the seam changed.

The migration story that matters is the *exit*: the day a local native-tool model (or a cloud frontier model) is preferred, the swap is one line at the wiring site, because the emulation lives entirely inside `GemmaModelProvider`. `FallbackModelProvider` (also a `ModelProvider`) can even put Gemma first and a cloud model behind it, so the swap can be incremental rather than a cutover.

> ┃ The framing that gets the yes on rollout: "the
> ┃ emulation is contained in one adapter, so adopting a
> ┃ native-tool model later is a one-line swap, not a
> ┃ migration." A reviewer worried about being stuck on
> ┃ Gemma hears that and relaxes.

---

## Open questions

- **Per-call timeout.** Should `defaultHttpTransport` add a timeout (e.g. wrap `fetch` in an `AbortController` with a deadline) so a wedged Ollama daemon fails fast instead of hanging? Today only explicit abort is honored. This is the most concrete gap.
- **Constrained decoding later.** If Ollama exposes grammar constraints cleanly, is it worth replacing the lenient-parse-plus-nudge with grammar-forced JSON? It would shrink the retry path to near-zero — but only earns its place if Gemma's JSON failures become a measured problem, which they currently aren't.
- **Attempt budget tuning.** Is `2` the right default for `maxToolCallAttempts`, or should it scale with how often the nudge actually recovers a call in practice? Undecided — no data collected yet.
