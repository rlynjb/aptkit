# 07 — Backpressure, Bounded Work, and Cancellation

**Industry name:** bounded loop / cooperative cancellation (AbortSignal) · *Industry standard*

This is the load-bearing file for AptKit's runtime. The agent loop is the heart of the system, and two properties make it safe to run against a paid, slow, fallible model API: it's **bounded** (it cannot run forever or spend unbounded tokens), and it's **cancellable** (one `AbortSignal` can stop it cleanly at any await). Get these two right and an agent loop is production-shaped; get them wrong and it's a runaway cost-and-hang machine.

## Zoom out, then zoom in

```
  Zoom out — where bounds and cancellation live

  ┌─ Application layer ──────────────────────────────────────────┐
  │  Agent.propose() — sets maxTurns, maxToolCalls, synthesis     │
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Runtime layer ──────────▼───────────────────────────────────┐
  │  ★ runAgentLoop — the bounded for-loop + signal threading ★  │ ← we are here
  └──────────────────────────┬───────────────────────────────────┘
  ┌─ Provider layer ─────────▼───────────────────────────────────┐
  │  fallback chain + SDK { signal } — cancellation crosses here │
  └───────────────────────────────────────────────────────────────┘
```

Zoom in: *bounded work* means the loop has a hard ceiling on iterations and resource spend, independent of what the model decides. *Cancellation* means an external caller can abort an in-flight run, and the abort actually propagates down to the network call rather than just setting a flag nobody checks. The question: "what stops this loop — by exhaustion, by budget, or by a kill switch — and does the kill switch reach the socket?"

## Structure pass

**Layers.** Agent (sets budgets) → loop (enforces them + checks the signal) → provider/SDK (honors the signal at the wire).

**Axis — "what can stop this loop at each layer?"**

```
  One question down the layers: "what halts execution here?"

  ┌─ agent (config) ────────────┐  sets the budgets: maxTurns=6,
  │                             │  maxToolCalls=4, maxTokens=4096
  └──────────────┬───────────────┘
       ┌─────────▼──────────────────┐ enforces them: loop exits on turn
       │  loop (enforcement)         │ count OR budget; signal.throwIfAborted
       └─────────┬──────────────────┘ at every await boundary
           ┌─────▼────────────────────┐ honors signal: SDK { signal } aborts
           │  provider/SDK (the wire)  │ the actual HTTPS request
           └──────────────────────────┘
```

The "what halts it" answer changes shape down the layers: config *declares* the bounds, the loop *enforces* them and adds the cancellation checkpoints, the SDK *physically* tears down the socket on abort. All three must agree or cancellation is theater.

**Seams.** Two load-bearing seams:
- **The `forceFinal` flag** — the seam between "you may call tools" and "you must answer now." It flips on the last turn or when the tool budget is spent, stripping `tools` from the request so the model *cannot* loop further.
- **The `AbortSignal`** — the single object threaded through every layer. It's the seam where external control crosses into the loop and continues down to the kernel.

## How it works

### Move 1 — the mental model

You know a `for (let i = 0; i < n; i++)` loop with a hard `n` can't run forever, and you know `AbortController` cancels a `fetch`. The agent loop is exactly those two primitives composed: a bounded `for` loop whose body is an awaited model call, with an `AbortSignal` checked at the top of each iteration and passed into the fetch.

```
  The bounded-loop kernel — the thing to reconstruct from memory

  for (turn = 0; turn < maxTurns; turn++) {
    signal.throwIfAborted()                  ← (1) kill switch checkpoint
    forceFinal = (turn === maxTurns-1)       ← (2) last turn → must answer
               || (toolCalls >= maxToolCalls)    OR budget spent → must answer
    response = await model.complete({
      tools: forceFinal ? none : toolSchemas, ← (3) strip tools to force synthesis
      maxTokens, signal })                     ← (4) signal → SDK → socket
    if (no tool_use in response) break        ← (5) natural termination
    for (toolUse of response.toolUses)
      await callTool(..., { signal })          ← (6) signal into each tool too
  }
```

Six parts. Remove any of (1)–(5) and the loop loses a safety property — that's the load-bearing-skeleton test, walked next.

### Move 2 — the load-bearing skeleton

**(1) The cancellation checkpoint — `signal.throwIfAborted()` at the top of every turn.** *What breaks if removed:* an aborted run keeps spending model calls until natural termination. Cancellation only takes effect at await boundaries (cooperative), so this checkpoint is where a between-turns abort is noticed. Because there's no synchronous hot loop, checking once per turn (plus inside each await) is sufficient — the loop is never busy long enough to ignore an abort.

**(2) The turn ceiling — `turn < maxTurns`.** *What breaks if removed:* the loop runs until the model voluntarily stops emitting tool calls, which a confused or adversarial model may never do. This is the hard iteration budget — the single most-forgotten part of an agent loop, and the one that separates "I built an agent" from "I built a *bounded* agent."

**(3) The tool-call budget + `forceFinal` — `maxToolCalls` and stripping tools.** *What breaks if removed:* the model can keep requesting tools right up to the turn ceiling, never producing an answer; you hit `maxTurns` with no result. `forceFinal` flips when the budget is spent OR it's the last turn, and *removes `tools` from the request entirely* — so the model physically cannot request another tool and must synthesize. This is the part that converts "ran out of turns with nothing" into "ran out of budget, then answered."

```
  forceFinal — the synthesis forcing function

  normal turn:   complete({ tools: [getMetric, ...] }) ← model MAY call tools
  forceFinal:    complete({ tools: undefined,           ← model CANNOT call tools
                            system: system + synthesisInstruction })
       │                              │
       │                              └─ "You have NO more tool calls available.
       │                                  ...output your final answer."
       └─ triggered by turn === maxTurns-1 OR toolCalls.length >= maxToolCalls
```

**(4) The signal into `model.complete`.** *What breaks if removed:* an abort between turns is caught, but an abort *during* a slow model call isn't — the in-flight HTTPS request runs to completion before the next checkpoint notices. Passing `signal` into the SDK lets the abort tear down the actual socket mid-flight.

**(5) Natural termination — `break` when no `tool_use`.** *What breaks if removed:* the loop always runs the full `maxTurns` even when the model answered on turn 1. This is the common case (model gathers data, then answers) and the early exit is what keeps a simple run cheap.

**(6) Hardening, not skeleton: the recovery turn.** After the loop, if `parseResult` returns null (the model's final text wasn't valid structured output), an optional `recoveryPrompt` runs *one more* `model.complete` with a strict "conclude now, output only the answer" system prompt. This is layered hardening — the loop is already correct without it; recovery just salvages a malformed final answer. It still checks the signal first and re-throws aborts.

**The nested bounded loop — `GemmaModelProvider.complete` has its own.** The agent loop isn't the only bounded loop anymore. Because Gemma2 has no native tool-calling, the Gemma provider emulates it: it renders tools into the system prompt, asks for JSON, and if the reply is a *botched* tool call, re-asks with a corrective nudge — a bounded retry loop *inside a single `model.complete()`*. The same two safety properties apply one level down.

```
  Two bounded loops now nest — outer agent loop, inner parse-retry

  runAgentLoop  for turn 0..maxTurns:          ← OUTER bound (turns)
    await model.complete(...)                  │
      └─ GemmaProvider.complete:               │
           for attempt 0..maxToolCallAttempts: ← INNER bound (attempts, default 2)
             signal.throwIfAborted()           ← INNER cancel checkpoint
             raw = await chat({ signal })      ← localhost HTTP, signal → socket
             if parseToolCall(raw): return     ← natural termination
             if looksLikeToolAttempt(raw):     ← only retry a BOTCHED call
               continue (append RETRY_NUDGE)   │  (plain prose is a real answer)
             break                             │
```

*What bounds it:* `maxToolCallAttempts` (default 2, floored at 1 — `gemma-provider.ts:49`) caps how many times Gemma is re-asked before the provider gives up and returns the raw text as a plain `text` block. Remove it and a model that *always* emits malformed JSON loops forever inside one `complete()` call — the outer turn ceiling wouldn't save you, because the run never returns to the outer loop. *What makes it cancellable:* `signal.throwIfAborted()` runs once before the loop and again at the top of every attempt (`gemma-provider.ts:53,63`), and the `signal` is threaded into the `chat` transport down to the localhost `fetch` (`:69-74`, `:203-214`). The "throws if already aborted" test proves the pre-loop checkpoint (`test/gemma-provider.test.ts:126-136`). The one subtlety worth naming: the loop only retries when `looksLikeToolAttempt(raw)` is true (the reply contains a `{`) — plain prose is treated as a real answer and breaks immediately, so a model that simply chose to answer in words doesn't burn its retry budget (`:85-88`).

**Cancellation propagation — the full chain.** The same `AbortSignal` threads through every layer. This is what makes cancellation *real* rather than a flag:

```
  AbortSignal propagation — external control → kernel

  caller ──signal──► runAgentLoop
                       │ throwIfAborted() each turn
                       ├──signal──► model.complete (loop)
                       │              └─ FallbackModelProvider
                       │                   │ throwIfAborted() each provider
                       │                   ├──signal──► AnthropicProvider
                       │                   │              └─ SDK { signal } ─► fetch ─► socket
                       │                   └─ on abort: re-throw, do NOT fall back
                       └──signal──► callTool (each tool)
       │
       └─ abort fires → throwIfAborted throws → propagates up → run rejects.
          The fallback chain explicitly does NOT treat an abort as a
          provider failure to retry (that would defeat cancellation)
```

The subtle, correct detail: `FallbackModelProvider` checks `isAbortError(error) || request.signal?.aborted` and *re-throws* instead of falling back. Without that, aborting a run would just trigger the fallback provider — you'd cancel Anthropic and accidentally call OpenAI. The abort short-circuits the entire chain.

**Cancellation's new dead end — the embedding call.** The cancellation chain is end-to-end for the *model* path, but the new RAG retrieval path has a gap. `OllamaEmbeddingProvider.embed` is built correctly — it accepts an `AbortSignal` via `EmbedCallOptions`, checks `throwIfAborted()`, and threads the signal to the localhost `fetch` (`ollama-embedding-provider.ts:50-57`). But nobody hands it one. The agent's signal reaches `runAgentLoop` → `callTool` → the `search_knowledge_base` handler → `pipeline.query` → `embedder.embed(query)` — and `pipeline.query` calls `embed([query])` with no options arg (`pipeline.ts:56`), so the signal is dropped at the pipeline seam. The plumbing exists on the provider but the wiring stops at the pipeline. Concretely: abort a RAG run while it's embedding the query, and the model call would tear down but an in-flight embedding HTTP request would run to completion. It's a one-line fix (thread `signal` through `RetrievalPipeline.query` → `embed`), and it's the mirror image of the *correct* model-path wiring.

**Same gap, one seam earlier — `@aptkit/memory`.** `conversation-memory.ts` reuses the exact embed-then-search execution the RAG pipeline does, and it drops the signal even *sooner*: `recall(query, k?)` and `remember(turn)` take no options/signal argument at all (`conversation-memory.ts:36-38`). So there's no parameter to thread a signal through even if the caller had one — the `search_memory` tool handler `await`s `memory.recall(query, topK)` with no signal (`memory-tool.ts:52`), and inside `recall` the `await embedder.embed([query])` and `await store.search(...)` both run signal-less. The agent's kill switch reaches the model call, but a memory-recall run that's mid-embed against Ollama (or mid-search against a slow `PgVectorStore`) can't be aborted — it finishes as an orphan, same as the RAG embed gap. The fix is the same shape but slightly larger: add a `{ signal }` option to the `ConversationMemory` contract, then thread it into `embed`/`search`. Until then, memory recall is the second signal dead end, and it's the one with no plumbing at all to thread.

**Backpressure — the honest gap.** "Bounded work" has a sibling, *backpressure* — slowing the producer when the consumer can't keep up. AptKit has it on the *read* side (the pull-based async generator in `06`/`03`) but **not** on the *write* side (`res.write` ignores `drain`). And there's **no timeout** on the awaited model call — nor on the new local Gemma/embed `fetch` calls (`gemma-provider.ts:203-214`, `ollama-embedding-provider.ts:62-74`) — the only way to bound a hung request is the external signal. So both loops are bounded in *iterations and budget* but not in *wall-clock time per call*.

### Move 2.5 — current state vs future state

```
  Phase A (now)                          Phase B (if needed)
  ─────────────────────────────────      ──────────────────────────────────
  bounds: maxTurns, maxToolCalls,         add: per-call timeout via
          maxTokens, MAX_TOOL_RESULT        Promise.race([complete, timeout])
  cancel: external AbortSignal only       add: AbortSignal.timeout(ms) wired
  no per-call deadline                      into the same signal path (free —
                                            the plumbing already exists)
```

What doesn't have to change: the entire signal-threading chain already accepts an `AbortSignal`, so adding a deadline is `AbortSignal.timeout(ms)` composed with the caller's signal — no new plumbing, just a composed signal at the top.

### Move 3 — the principle

A loop that calls an LLM needs *two independent* safety properties: a hard ceiling it can't argue its way past (bounds), and a kill switch that reaches the wire (cancellation). Bounds protect you from the model's behavior; cancellation protects you from the model's latency. AptKit nails both — multiple orthogonal budgets plus a signal threaded to the socket — and the one missing piece (a per-call deadline) is a one-line composition away because the signal plumbing is already universal.

## Primary diagram

```
  Bounded loop + cancellation — the complete machine

  caller: signal ──────────────────────────────────────────────┐
                                                                │
  ┌─ runAgentLoop ───────────────────────────────────────────▼─┐
  │  for turn in 0..maxTurns:           ← BOUND 1: turn ceiling │
  │    signal.throwIfAborted()          ← CANCEL checkpoint     │
  │    forceFinal = lastTurn || toolCalls>=maxToolCalls         │
  │                                     ← BOUND 2: tool budget  │
  │    response = await complete({                              │
  │       tools: forceFinal? none : schemas, ← forces synthesis │
  │       maxTokens,                    ← BOUND 3: output cap   │
  │       signal })  ──────────────────► fallback → SDK{signal} │
  │    if no tool_use: break            ← natural termination   │
  │    for toolUse: await callTool(...,{signal}) ← serial+cancel│
  │  truncate(result, 16KB)             ← BOUND 4: per-result   │
  │  [optional recovery turn]           ← hardening             │
  └─────────────────────────────────────────────────────────────┘
       bounded: turns·tools·tokens·result-size
       cancel: signal → loop → fallback(re-throw) → SDK → socket
       gap: no per-call timeout · no write backpressure
```

## Implementation in codebase

**Use cases.** Every agent run is bounded by this loop. The recommendation agent sets the tightest budgets (6 turns, 4 tools) because it's the deepest reasoner; cancellation matters most when a Studio user navigates away mid-replay or a request is torn down — the signal stops the paid model calls instead of letting them finish unwatched.

**Code side by side.**

The bounded loop with the cancellation checkpoint and `forceFinal`:

```
  packages/runtime/src/run-agent-loop.ts (lines 98–135)

  for (let turn = 0; turn < maxTurns; turn += 1) {  ← BOUND: hard turn ceiling
    signal?.throwIfAborted();                        ← CANCEL: per-turn checkpoint
    const budgetSpent =
      maxToolCalls !== undefined && toolCalls.length >= maxToolCalls; ← BOUND: tool budget
    const forceFinal = turn === maxTurns - 1 || budgetSpent;          ← synthesis trigger
    const response = await model.complete({
      system: forceFinal && synthesisInstruction
        ? `${system}\n\n${synthesisInstruction}` : system,            ← "no more tools" nudge
      messages,
      tools: forceFinal ? undefined : toolSchemas,   ← STRIP tools → model must answer
      maxTokens,                                      ← BOUND: output cap
      signal,                                         ← CANCEL: into the SDK
    });
    ...
    const toolUses = toolUsesFromContent(response.content);
    if (toolUses.length === 0) { finalText = text; break; }  ← natural termination
```

The fallback chain re-throwing aborts instead of retrying:

```
  packages/providers/fallback/src/fallback-provider.ts (lines 50–65)

  for (let index = 0; index < this.providers.length; index += 1) {
    request.signal?.throwIfAborted();              ← CANCEL: before each provider
    try {
      const response = await provider.complete(request);
      return { ...response, model: ... };
    } catch (error) {
      if (isAbortError(error) || request.signal?.aborted) throw error; ← do NOT fall back on abort
      attempts.push(...);                          ← real failures → try next provider
    }
  }
       │
       └─ the abort check is what stops cancellation from accidentally
          triggering the fallback provider (the bug this guards against)
```

The signal reaching the actual HTTPS request:

```
  packages/providers/anthropic/src/anthropic-provider.ts (lines 28–39)

  const response = await this.client.messages.create(
    { model, max_tokens: request.maxTokens ?? 4096, ... },
    request.signal ? { signal: request.signal } : undefined, ← signal → SDK → fetch → socket
  );
       │
       └─ this is where cancellation becomes physical: aborting tears down
          the in-flight request rather than waiting for it to finish
```

The agent setting the budgets:

```
  packages/agents/recommendation/src/recommendation-agent.ts (lines 77–93)

  const { parsed } = await runAgentLoop({
    ...
    signal: runOptions.signal,                     ← caller's kill switch
    maxTurns: 6,                                    ← tightest turn budget in the repo
    maxToolCalls: 4,                                ← tool budget → forces synthesis early
    synthesisInstruction: buildSynthesisInstruction(
      'Stop querying now and output your final answer. ...'), ← the forced-answer prompt
    parseResult: (text) => tryParseRecommendations(text, this.taxonomy),
    recoveryPrompt: (toolCalls) => buildRecoveryPrompt(...), ← hardening: salvage bad output
  });
```

The nested bounded-and-cancellable retry loop inside the Gemma provider:

```
  packages/providers/gemma/src/gemma-provider.ts (lines 52–92)

  async complete(request) {
    request.signal?.throwIfAborted();              ← CANCEL: before the loop
    const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1; ← BOUND: attempt ceiling
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      request.signal?.throwIfAborted();            ← CANCEL: every attempt
      const messages = attempt === 0 ? base
        : [...base, { role: 'user', content: RETRY_NUDGE }]; ← corrective re-ask
      lastResponse = await this.chat({ ..., signal: request.signal }); ← CANCEL → socket
      if (wantsTool) {
        const call = parseToolCall(raw);
        if (call) return this.toResponse([tool_use ...]); ← natural termination
        if (looksLikeToolAttempt(raw)) continue;   ← retry ONLY a botched call
      }
      break;                                        ← prose answer → stop, don't burn budget
    }
    return this.toResponse([{ type: 'text', text: raw }]); ← give up → raw text
  }
       │
       └─ same shape as the outer loop one level down: a hard attempt ceiling
          plus a signal checkpoint per iteration, threaded to the localhost fetch
```

## Elaborate

The bounded-loop-plus-cancellation pattern is the canonical safe shape for any "call an external system in a loop until done" — it predates LLMs (think a polling loop with a max-attempts cap and a cancel token). It's worth noticing the pattern is now *self-similar* in this repo: the same kernel (hard iteration ceiling + per-iteration signal checkpoint + signal threaded to the wire) appears at two nesting depths — the outer `runAgentLoop` turn loop and the inner `GemmaModelProvider` parse-retry loop. The inner one exists for a different reason (Gemma's lack of native tool-calling forces a re-ask-until-valid-JSON loop) but reaches for the identical safety primitives. When the same mechanism reappears at two levels, that's the signal it's load-bearing, not incidental. What's specific to agent loops is `forceFinal`: a normal retry loop just gives up at the ceiling, but an agent loop must *produce an answer* at the ceiling, so it strips the tools and changes the prompt to force synthesis rather than returning empty. That's the move that separates a toolbox-call loop from a usable agent. The cancellation design — one `AbortSignal` threaded everywhere, with the fallback chain explicitly *not* treating abort as a retryable failure — is textbook cooperative cancellation done right. The reasoning *shape* of this loop (ReAct: reason → act → observe, with forced synthesis) is `study-agent-architecture`'s territory; this file owns the *control-flow and safety* half. The gaps (no per-call timeout, no write backpressure) are the realistic next steps, both cheap given the existing signal plumbing.

## Interview defense

**Q: "What stops this agent loop from running forever?"**

```
  turn < maxTurns ──────► hard iteration ceiling (6 for recommendation)
  toolCalls >= maxToolCalls ─► tool budget → forceFinal
  forceFinal → tools=undefined ─► model CAN'T call tools, MUST answer
  no tool_use → break ──► natural early exit
```

Answer: "Four independent bounds. The turn ceiling caps iterations. The tool-call budget and `forceFinal` strip the tools and force a synthesis turn so it can't loop on tool calls. Natural termination breaks early when the model answers. And `maxTokens` caps each response. The most-forgotten one is the hard turn ceiling — without it a confused model loops indefinitely." Anchor: `run-agent-loop.ts:98–135`. The load-bearing part people forget: `forceFinal` *stripping the tools*, not just nudging the prompt.

**Q: "I abort a run mid-model-call. What actually happens — and what's the bug you avoided?"**

```
  abort fires → signal.aborted = true
    → SDK's fetch tears down the socket (signal passed in)
    → throws AbortError
    → FallbackProvider sees isAbortError → RE-THROWS (does not fall back)
    → runAgentLoop rejects
  bug avoided: without the re-throw, abort would trigger the fallback provider
```

Answer: "The signal is wired into the SDK, so the in-flight HTTPS request is torn down, not just flagged. The error propagates up. Crucially, the fallback chain checks for an abort and re-throws instead of retrying — otherwise cancelling the primary would accidentally call the fallback provider." Anchor: `anthropic-provider.ts:38`, `fallback-provider.ts:65`.

**Q: "What's missing?"** A per-call deadline. The loop bounds iterations and tokens but not wall-clock time per `model.complete` — a hung request relies on the external signal. Fix: `AbortSignal.timeout(ms)` composed with the caller's signal, which the existing plumbing accepts for free.

## Validate

1. **Reconstruct:** Write the six-part bounded-loop kernel from memory; name what breaks if each part is removed.
2. **Explain:** Why does `forceFinal` set `tools: undefined` instead of just adding a prompt? (To make tool-calling *physically impossible*, not merely discouraged — `run-agent-loop.ts:107`.)
3. **Apply:** A model hangs for 90 seconds on one call. What stops it today, and what would you add? (Only the external signal today; add a composed `AbortSignal.timeout` — the plumbing exists.)
4. **Defend:** Explain why the fallback chain must re-throw aborts, and what bug occurs if it doesn't (`fallback-provider.ts:65`).
5. **Apply (nested loop):** Gemma emits malformed tool-call JSON on every attempt. What stops `complete()` from looping forever, and why wouldn't the outer `maxTurns` save you? (`maxToolCallAttempts`, `gemma-provider.ts:49,62`; the outer ceiling can't help because the run hasn't returned to the outer loop yet.)
6. **Defend (cancellation gap):** Trace the agent's `AbortSignal` from `runAgentLoop` to the embedding HTTP call and name where it's dropped (`pipeline.ts:56` calls `embed([query])` with no options — the provider accepts a signal but the pipeline never passes one).
7. **Defend (second cancellation gap):** Why is `@aptkit/memory`'s gap worse than the embed-path gap? (Neither `recall` nor `remember` takes a signal arg at all — `conversation-memory.ts:36-38` — so there's no seam to thread one through; the embed path at least has a provider that accepts a signal. `memory-tool.ts:52` calls `recall` signal-less.)

## See also

- `02-processes-threads-and-tasks.md` — why the tool loop is sequential (and how cancellation survives a fan-out).
- `03-event-loop-and-async-io.md` — why cancellation only fires at await boundaries.
- `06-filesystem-streams-and-resource-lifecycle.md` — the write-side backpressure gap.
- `03-event-loop-and-async-io.md` — the new unbounded synchronous span (`InMemoryVectorStore.search`).
- `.aipe/study-agent-architecture/` — the reasoning shape (ReAct, forced synthesis) of this same loop, and the Gemma tool-call emulation behind the nested retry loop.
- `04-shared-state-races-and-synchronization.md` — `@aptkit/memory`'s counter `Map`, the second new piece of mutable state.
- `.aipe/study-ai-engineering/` *(when generated)* — the RAG pipeline (chunk → embed → store → search) whose execution this file bounds, and the episodic-memory recall that reuses it.
- `.aipe/study-distributed-systems/` *(when generated)* — the fallback chain as partial-failure handling.
