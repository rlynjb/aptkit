# Agent memory (short-term vs long-term — and where each one lives now)

**Industry names:** conversation memory, working memory vs long-term / retrieval memory · *Industry standard*

## Zoom out, then zoom in

An agent "remembers" in exactly one way that's free: the conversation so far is in
its context window. Everything it asked, every tool result it got back, the whole
turn history — that's its short-term memory, and it lives in a single array. Any
*other* kind of memory — recalling a fact from last week — is a separate retrieval
system. The update worth leading with: **AptKit now ships that second system too.**
`@aptkit/memory` (`createConversationMemory`) is retrieval-based long-term memory —
embed an exchange, store it, recall it by similarity. So this file is no longer
"we only have short-term"; it's "here are both layers, here's the seam between
them, and here's which one is wired into the live agent loop vs. which one is a
shipped-but-not-yet-auto-called engine."

```
  Zoom out — where agent memory lives (BOTH layers now exist)

  ┌─ Agent layer ─────────────────────────────────────────────────┐
  │  builds the initial userPrompt + system                        │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ runAgentLoop
  ┌─ Runtime layer (run-agent-loop.ts) ─▼───────────────────────────┐
  │  ★ messages: ModelMessage[]  ← the ENTIRE short-term memory ★    │ ← we are here
  │  grows each turn: assistant reply + tool results appended       │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ remember(turn) / recall(query)  ← NEW seam
  ┌─ Long-term memory layer (packages/memory) ─▼─────────────────────┐
  │  ★ createConversationMemory: embed exchange → upsert tagged       │
  │    'memory' → recall by similarity. RAG over the agent's OWN past.│
  │  Shipped + unit-tested in aptkit; the runtime that calls          │
  │  remember() per turn + the durable store live in buffr.           │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: **short-term memory** is the in-context message history — automatic,
bounded by the context window, gone the moment the run ends. **Long-term memory**
is anything retrieved from outside the window — fetched and injected on demand.
The sharp line now: short-term is *automatic* (the loop grows the `messages` array
for free); long-term is a *system you call* (`remember` writes a row, `recall`
searches for it). AptKit has both — but they're at different maturity. Short-term
is live in every agent run. Long-term is shipped as an engine (`@aptkit/memory`,
tested) but **not yet auto-called** by any aptkit agent loop; the runtime that
invokes `remember` after each turn lives in buffr. The question this file answers:
what does an AptKit agent remember about *itself*, where does short-term stop, and
what does the new long-term engine add when you wire it in?

## Structure pass

**Layers.** Two, and **both** now exist — at different maturity. The
*working-memory* layer (the `messages` array inside one run, live in every agent)
and the *long-term* layer (`@aptkit/memory`, retrieval across runs — shipped and
tested, but not yet auto-called by an aptkit loop).

**Axis — lifecycle / how long does a memory live?** Trace it. A fact the model
states this turn lives in `messages` for the rest of the run. The whole `messages`
array lives exactly as long as the `runAgentLoop` call — after `return`, it's
garbage-collected. That's the cliff. The long-term layer is what *catches* what
falls off it: call `remember(turn)` before the run ends and that exchange becomes
a durable vector row that `recall` can fetch in a future run. So on the lifecycle
axis there are now two regimes — automatic-but-transient (the array) and
durable-but-must-be-written (the memory store).

```
  One question — "how long does this memory survive?"

  ┌─ within a turn ──┐  → a tool result lives in `messages` rest of run
  └──────────────────┘
  ┌─ within a run ───┐  → the whole `messages` array lives until return
  └──────────────────┘
  ┌─ across runs ────┐  → array is GC'd … UNLESS remember(turn) wrote it to
  └──────────────────┘     the memory store, where recall() can fetch it later
```

**Seams.** Two now. The append point inside the loop — where each turn's output
and tool results get pushed onto `messages` — is the short-term seam. The new
seam is the **retrieval boundary**: `remember(turn)` on the way out (persist this
exchange) and `recall(query)` on the way in (fetch relevant past exchanges). That
seam used to be the named *absence*; `@aptkit/memory` fills it. Its *mechanics*
(embed → store → similarity-search) are the retrieval lens —
[../03-retrieval-and-rag/13-conversation-memory.md](../03-retrieval-and-rag/13-conversation-memory.md)
owns that. This file owns the *taxonomy*: which layer is which, and that the
loop's `messages` array is short-term only.

## How it works

You already know a chat transcript: each message you send and each reply stacks up,
and the model "remembers" earlier messages only because they're re-sent every time.
Agent short-term memory is exactly that transcript, plus tool requests and tool
results stacked in as messages too. There's no magic — "memory" is just an array
you keep re-sending.

### Move 1 — the mental model

```
  Short-term memory = the messages array, re-sent every turn

  messages = [
    { user:      "Run the anomaly checklist…" },     ← turn 0 input
    { assistant: [tool_use get_metric_timeseries] }, ← model's request
    { user:      [tool_result {…revenue down 12%}] },← OBSERVATION appended
    { assistant: [tool_use get_segments] },          ← next request
    { user:      [tool_result {…}] },                ← appended
    …
  ]
        │ every turn, the WHOLE array is re-sent to the model
        ▼
  the model "remembers" turn 0 only because turn 0 is still in the array
```

The model is stateless between calls. It doesn't carry anything forward on its own.
The *array* carries everything forward, and you re-send it. Delete the array and
the model is amnesiac — that's the load-bearing part.

### Move 2 — the moving parts

**The accumulator.** Bridge from an append-only log — `messages` starts with one
user message and only ever grows. Each turn: the model's full response (text +
tool-use blocks) is pushed as an `assistant` message; the tool results are pushed
as the next `user` message. Nothing is ever removed or rewritten. Boundary
condition: it grows unbounded within the run — there's no summarization or
compaction, so a long investigation just keeps stacking context until the budget
(or the window) stops it.

```
  Pattern — the accumulator grows, never shrinks

  start:  [user prompt]
  turn n: push assistant(response)         ← what the model said/requested
          push user(tool_results)          ← what the tools returned
  …
  end of run: array discarded (GC)         ← memory cliff: nothing persists
```

**The re-send.** Bridge from a stateless HTTP API — the provider keeps no
server-side session (in AptKit's model), so every `model.complete` call ships the
entire `messages` array again. The model's "recall" of turn 0 at turn 5 is purely
that turn 0 is still in the payload. Boundary condition: re-sending the whole
history every turn is why input tokens climb each turn — short-term memory is not
free, it's paid for in input tokens on every call.

```
  Layers-and-hops — re-send the whole array each turn

  ┌─ runtime loop ─┐  hop (every turn): complete({ messages: WHOLE array })
  │  messages[]    │ ──────────────────────────────────────────────────►┐
  └────────────────┘                                                     │
        ▲                                                       ┌─ provider ─┐
        │  hop: response.content appended back                  │  stateless │
        └───────────────────────────────────────────────────── └────────────┘
  cost note: array grows → input tokens grow → each turn costs more
```

**Long-term memory: now a separate system you call.** Bridge from a cache or a
database — a long-term-memory agent, before or after a run, *retrieves* relevant
past exchanges (from a vector store keyed by similarity) and injects them. AptKit
now has the engine for this: `@aptkit/memory`'s `remember(turn)` embeds an
exchange and stores it; `recall(query)` searches it back. The difference from
short-term is the one to hold: short-term is *automatic* — the loop grows
`messages` whether you ask it to or not. Long-term is *opt-in* — nothing is
remembered unless you call `remember`, and nothing is recalled unless you call
`recall`. Boundary condition (the honest one): no aptkit agent loop calls
`remember` on its own *yet* — the engine is shipped and tested, but the runtime
that invokes it per turn lives in buffr. So today, if the same anomaly recurs next
week, the agent still re-investigates from scratch — not because the machinery is
missing, but because it isn't wired into the loop in this repo.

```
  Comparison — short-term (live) vs long-term (engine shipped, not auto-called)

  SHORT-TERM (live in every run)   LONG-TERM (@aptkit/memory)
  ──────────────────────           ───────────────────────────
  in-context messages[]            vector store of past exchanges
  AUTOMATIC, free-ish              OPT-IN: you call remember()/recall()
  scoped to ONE run                spans runs, persists (when wired)
  GC'd at run end                  durable, queried by similarity
  → run-agent-loop.ts:94           → packages/memory/conversation-memory.ts
                                     (mechanics: §03/13-conversation-memory.md;
                                      the per-turn runtime lives in buffr)
```

### Move 3 — the principle

Be ruthlessly clear about which memory you have. Short-term memory is automatic and
seductive — the model "just remembers" within a run — but it's bounded by the
window, paid for in re-sent tokens, and erased at the run boundary. Long-term
memory is a *separate system* (storage + retrieval + injection) that you call on
purpose, not something an agent grows by itself. Conflating the two is how teams
ship an "agent that remembers" and discover it forgets everything the moment the
request ends. AptKit now has both systems — but they're different in kind:
short-term is wired into the loop and automatic; long-term (`@aptkit/memory`) is an
engine you opt into by calling `remember`/`recall`, and the loop that calls it on
every turn lives in buffr, not here.

## Primary diagram

The full memory picture: one growing array per run (short-term), and the separate
opt-in store (`@aptkit/memory`) that catches what falls off the run-end cliff —
drawn as built but not yet auto-called by the loop in this repo.

```
  Agent memory — full picture (short-term live, long-term shipped-not-wired)

  ┌─ ONE RUN (runAgentLoop) ─────────────────────────────────────────┐
  │  messages = [user prompt]              ← short-term memory born    │
  │     │                                                             │
  │  turn 0..N:                                                       │
  │     complete({ messages })  ──► re-send WHOLE array each turn      │
  │     push assistant(response)                                      │
  │     push user(tool_results)            ← memory grows             │
  │     │                                                             │
  │  return ──► messages GC'd               ← MEMORY CLIFF             │
  └────────────────────────────────────┬──────────────────────────────┘
                  remember(turn) catches│it (opt-in; not auto-called in aptkit)
  ┌─ LONG-TERM MEMORY (@aptkit/memory) ─▼──────────────────────────────┐
  │  ✓ vector store of exchanges  ✓ recall by similarity  ✓ persistent │
  │  remember: embed exchange → upsert tagged 'memory'                 │
  │  recall:   embed query → search → filter kind → top-k             │
  │  (engine + tests in aptkit; the per-turn runtime + durable store   │
  │   in buffr — so today the loop above doesn't call it on its own)   │
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every agent run — monitor, diagnose, recommend, query — has exactly
this short-term memory: a `messages` array that accumulates the turn-by-turn
investigation and vanishes when the run returns. The recommendation agent's
*recovery turn* is the clearest tell that the loop doesn't reach for a queryable
memory: when the final answer won't parse, it can't "recall" the evidence — it
*repackages* the tool-call results into a fresh prompt by hand, because the
`messages` array is a transient local variable, not a store. The long-term side
now exists as `@aptkit/memory`, but no agent loop in this repo calls it on its own
yet — so the loops still behave exactly as a short-term-only system would.

**The entire short-term memory**, `packages/runtime/src/run-agent-loop.ts:94`:

```
  packages/runtime/src/run-agent-loop.ts  (lines 94, 124, 189)

  const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
       │  ← line 94: short-term memory is born, one local array
       …
  messages.push({ role: 'assistant', content: response.content });
       │  ← line 124: the model's reply (text + tool_use) appended
       …
  messages.push({ role: 'user', content: toolResults });
       │  ← line 189: tool results appended as the next observation
       └─ that's all of it. No store, no persistence, no retrieval. When
          runAgentLoop returns, `messages` goes out of scope and is GC'd.
```

There is no `import` of any vector DB, embedding client, or memory store inside the
*runtime* — the loop is short-term only by design. The long-term engine lives in a
separate package the runtime doesn't depend on:

```
  packages/memory/src/conversation-memory.ts  (lines 74-106) — the long-term layer

  async remember(turn) {                              ← persist one exchange
    const text   = format(turn);                      ← Q/A → embeddable line
    const [vector] = await embedder.embed([text]);
    await store.upsert([{ id: `memory:${turn.conversationId}:${n}`,
      vector, meta: { kind: 'memory', conversationId, text } }]);  ← tagged row
  }
  async recall(query, k = 5) {                         ← fetch relevant past turns
    const hits = await store.search(await embedder.embed([query])[0],
                                    Math.max(k*4, 20));  ← over-fetch …
    return hits.filter(h => h.meta?.kind === 'memory').slice(0, k);  ← … then filter
  }
       │
       └─ this is the write-back-and-recall loop that used to be the named gap.
          The mechanics (why over-fetch, the kind tag, shared-vs-dedicated store)
          are the RETRIEVAL lens — ../03-retrieval-and-rag/13-conversation-memory.md.
          What's still true: the agent LOOP doesn't call these yet (buffr does).
```

**The recovery turn proves the loop doesn't recall**,
`packages/agents/recommendation/src/recommendation-agent.ts:103-124`:

```
  recommendation-agent.ts  (lines 108-114, buildRecoveryPrompt)

  const evidence = toolCalls
    .map((call, index) =>
      `Query ${index+1}: ${call.toolName} …\nResult: ${JSON.stringify(payload)…}`)
    .join('\n\n');
       │
       └─ to "remember" what it found, the recovery path manually rebuilds
          the evidence string from the toolCalls records. The memory engine
          now exists, but this loop doesn't query it — it reconstructs from the
          run's own records. Wiring recall in here is exactly the open exercise.
```

## Elaborate

The short-term/long-term split mirrors human cognition (working memory vs
long-term memory) and the framework world has standard names for both: "conversation
buffer" memory (the array) vs "vector store retriever" memory (the embedding DB).
The genuinely hard part is always the long-term side — embedding, indexing,
retrieval, relevance, and injecting recalled facts without blowing the window. That
hard part *is RAG* (retrieval-augmented generation) — and AptKit now *does* exercise
it for memory: `@aptkit/memory` is RAG with the conversation as the corpus, ~100
lines over the document-RAG contracts. Calling the message array "memory" is fine;
calling it long-term memory is still the mistake to avoid — long-term is the
separate `@aptkit/memory` system, not the array.

Why the analytics agents can still get away with short-term only at runtime: they're
single-shot investigations (scan, diagnose, recommend) where everything needed is
fetchable via tools *within* the run. The moment you want "remember the merchant's
preferences across sessions" or "don't re-flag an anomaly you already reported," you
call `remember`/`recall` from `@aptkit/memory` — and that's now a wiring task
(inject memory, call it around the loop), not a from-scratch retrieval build. The
build is done; the integration into an aptkit loop is the remaining step (it's live
in buffr).

Adjacent concepts: the loop whose `messages` array *is* the short-term memory
(`03-react-pattern.md`), the context window that bounds how much short-term memory
fits (`../02-context-and-prompts/01-context-window.md`), and the long-term engine's
mechanics — RAG over past turns
(`../03-retrieval-and-rag/13-conversation-memory.md`).

## Project exercises

*Provenance: Phase 4 — Agents and tool use (C4.x). No `aieng-curriculum.md`
present; IDs are by-phase convention.*

### Exercise — bound short-term memory growth (Case A)

- **Exercise ID:** `[A4.7]` Phase 4, agent-memory concept
- **What to build:** Add optional history compaction to `runAgentLoop`: when
  `messages` exceeds a configured turn count, summarize the oldest tool results
  into a single synthetic observation message, keeping recent turns verbatim.
- **Why it earns its place:** Short-term memory grows unbounded today; on long
  investigations that re-sends an ever-larger array (cost) and risks the window.
  Compaction is the standard fix and shows you understand the cost of re-send.
- **Files to touch:** `packages/runtime/src/run-agent-loop.ts`,
  `packages/runtime/test/run-agent-loop.test.ts`.
- **Done when:** A long fixture run keeps recent turns intact, replaces old ones
  with a summary, and input-token growth flattens; a test proves the array stops
  growing linearly.
- **Estimated effort:** `1–4hr`

### Exercise — wire @aptkit/memory into the monitor loop (Case A)

- **Exercise ID:** `[A4.8]` Phase 4, long-term-memory concept (uses `@aptkit/memory`)
- **What to build:** Give the monitoring agent a `ConversationMemory` (from
  `createConversationMemory`, a dedicated store). After each run, `remember` the
  reported anomalies; before a new run, `recall` similar prior anomalies and inject
  "already reported recently:" into the prompt — so the agent stops re-flagging the
  same thing. No retrieval layer to build: the engine ships.
- **Why it earns its place:** This is the gap closed. The hard part (embed → store →
  similarity query → filter) is now `@aptkit/memory`; the remaining work is the
  *integration* — inject memory, call `remember`/`recall` around the loop. It
  demonstrates you understand long-term memory is a separate system you *call*, and
  that wiring it is the last mile, not the whole build.
- **Files to touch:** `packages/agents/anomaly-monitoring/src/monitoring-agent.ts`
  (construct a `ConversationMemory`, call `remember` post-run and `recall`
  pre-prompt), matching tests. Reuse `@aptkit/retrieval`'s embedder +
  `InMemoryVectorStore`; no new provider.
- **Done when:** Re-running the monitor on an unchanged workspace surfaces a
  previously-reported anomaly as "already reported" instead of re-flagging it, proven
  by a test that fails if the `recall` injection is removed.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Does your agent have memory?**
"Both layers exist — and the distinction between them is the whole answer:"

```
  short-term: messages[] — within ONE run, GC'd at the end (automatic, live)
  long-term:  @aptkit/memory — embed exchange → store → recall by similarity
              (opt-in: you call remember()/recall(); engine shipped + tested)
```

"Short-term memory is the `messages` array in `run-agent-loop.ts:94` — it
accumulates the turn history and gets re-sent every turn, which is why the model
appears to remember within a run. It's automatic and gone the moment the run
returns. Long-term is a *separate system*: `@aptkit/memory`'s `remember`/`recall` —
RAG with the conversation as the corpus. The honest nuance: the engine is shipped
and unit-tested, but no aptkit agent loop calls it on its own yet — the runtime
that invokes `remember` per turn lives in buffr. So at runtime in this repo the
agents still behave short-term-only; the machinery to fix that is built and waiting
to be wired."
*Anchor: short-term is an automatic array; long-term is a system you call —
@aptkit/memory is RAG over the conversation.*

**Q: How do you know the loop has no recall today — couldn't it be implicit?**
"The recovery turn is the proof. When the final answer won't parse, the agent
*manually rebuilds* the evidence from the `toolCalls` records
(`recommendation-agent.ts:108`). If the loop queried the memory engine it would
recall, not reconstruct. Hand-repackaging the run's own records is what you do when
the loop isn't calling a store — even though the store now exists in the repo."
*Anchor: reconstruction-from-records is the fingerprint of having no recall.*

## Validate

- **Reconstruct:** From memory, write the three lines that *are* AptKit's
  short-term memory: declare the array, push the assistant turn, push the tool
  results. Check against `run-agent-loop.ts:94, 124, 189`.
- **Explain:** Why do input tokens climb each turn even though the user only asked
  one question? (Because the whole growing `messages` array is re-sent every turn —
  short-term memory is paid for in re-send; `run-agent-loop.ts:103-109`.)
- **Apply:** The same revenue-drop anomaly happens two weeks running. Does the
  monitor remember reporting it last time? (Not today — `messages` was GC'd and no
  loop calls `recall` yet. But the engine to fix it ships: wire `@aptkit/memory`'s
  `remember`/`recall` into the loop — exercise `[A4.8]`.)
- **Defend:** Is "add long-term memory" still a from-scratch RAG build? (No longer —
  `@aptkit/memory` IS that RAG layer, ~100 lines over the document-RAG contracts.
  What's left is *wiring*: inject the memory, call `remember` after the run and
  `recall` before it. The loop only knows the transient `messages` array; the store
  is a separate package it doesn't depend on yet.)

## See also

- [03-react-pattern.md](03-react-pattern.md) — the loop whose `messages` array IS the short-term memory
- [../02-context-and-prompts/01-context-window.md](../02-context-and-prompts/01-context-window.md) — the finite container short-term memory fills
- [06-error-recovery.md](06-error-recovery.md) — the recovery turn that rebuilds evidence by hand
- [../03-retrieval-and-rag/13-conversation-memory.md](../03-retrieval-and-rag/13-conversation-memory.md) — the long-term engine's mechanics: RAG over past turns
- the **buffr** repo — the runtime that calls `remember` per turn + the durable memory store
