# Agent memory (short-term vs long-term — and which one you actually have)

**Industry names:** conversation memory, working memory vs long-term / retrieval memory · *Industry standard*

## Zoom out, then zoom in

An agent "remembers" in exactly one way that's free: the conversation so far is in
its context window. Everything it asked, every tool result it got back, the whole
turn history — that's its short-term memory, and it lives in a single array. Any
*other* kind of memory — recalling a fact from last week, looking something up in
a vector store — is a separate retrieval system you have to build. AptKit has the
first and not the second, and being honest about that line is the whole lesson.

```
  Zoom out — where agent memory lives

  ┌─ Agent layer ─────────────────────────────────────────────────┐
  │  builds the initial userPrompt + system                        │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ runAgentLoop
  ┌─ Runtime layer (run-agent-loop.ts) ─▼───────────────────────────┐
  │  ★ messages: ModelMessage[]  ← the ENTIRE short-term memory ★    │ ← we are here
  │  grows each turn: assistant reply + tool results appended       │
  └───────────────────────────────┬────────────────────────────────┘
                                   │ (no arrow out to a store)
  ┌─ Long-term memory layer ───────▼────────────────────────────────┐
  │  ✗ NOT PRESENT — no vector DB, no retrieval, no persistence      │
  └──────────────────────────────────────────────────────────────────┘
```

Zoom in: **short-term memory** is the in-context message history — it's automatic,
bounded by the context window, and gone the moment the run ends. **Long-term
memory** is anything retrieved from outside the window — a vector store, a
database of past runs, a knowledge base — fetched and injected on demand. The
question this file answers: what does an AptKit agent actually remember, and where
does that stop? Answer: it remembers everything *within a single run* and nothing
*across* runs.

## Structure pass

**Layers.** Two, and only one of them exists here. The *working-memory* layer (the
`messages` array inside one run) and the *long-term* layer (retrieval across runs)
— which AptKit does not build.

**Axis — lifecycle / how long does a memory live?** Trace it. A fact the model
states this turn lives in `messages` for the rest of the run. The whole `messages`
array lives exactly as long as the `runAgentLoop` call. After `return`, it's
garbage-collected — the next run starts from an empty array. Nothing persists. So
on the lifecycle axis there is a hard cliff at the end of the run, and no layer
catches what falls off it.

```
  One question — "how long does this memory survive?"

  ┌─ within a turn ──┐  → a tool result lives in `messages` rest of run
  └──────────────────┘
  ┌─ within a run ───┐  → the whole `messages` array lives until return
  └──────────────────┘
  ┌─ across runs ────┐  → NOTHING survives — array is GC'd, next run empty
  └──────────────────┘
```

**Seams.** The one seam that *exists* is the append point inside the loop — where
each turn's output and tool results get pushed onto `messages`. The seam that's
*missing* is the retrieval boundary: there's no point where the agent reaches out
to a store to recall something from before this run. That absence is deliberate
and worth naming — adding long-term memory means adding that seam, which is the
retrieval layer from section 03.

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

**What's NOT here: long-term memory.** Bridge from a cache or a database — a
long-term memory agent would, on each new run, *retrieve* relevant past facts (from
a vector store keyed by similarity, or a DB of prior diagnoses) and inject them
into the prompt. AptKit does none of this. There's no embedding store, no
persistence of past runs, no retrieval step. Each run is born blind to every run
before it. Boundary condition (the honest one): if the same anomaly recurs next
week, the agent re-investigates from scratch — it has no recollection that it ever
saw it.

```
  Comparison — what AptKit has vs what it doesn't

  SHORT-TERM (present)              LONG-TERM (absent)
  ──────────────────────           ───────────────────────────
  in-context messages[]            vector store / DB of past runs
  automatic, free-ish              must build retrieval + storage
  scoped to ONE run                spans runs, persists
  GC'd at run end                  durable, queried by similarity
  → run-agent-loop.ts:94           → would be the retrieval layer (§03)
```

### Move 3 — the principle

Be ruthlessly clear about which memory you have. Short-term memory is automatic and
seductive — the model "just remembers" within a run — but it's bounded by the
window, paid for in re-sent tokens, and erased at the run boundary. Long-term
memory is a *separate system* (storage + retrieval + injection) that you build on
purpose, not something an agent grows by itself. Conflating the two is how teams
ship an "agent that remembers" and discover it forgets everything the moment the
request ends. AptKit has short-term only, and says so.

## Primary diagram

The full memory picture: one growing array per run, re-sent each turn, discarded at
the end — with the long-term layer drawn as the explicit gap.

```
  Agent memory — full picture (one layer present, one absent)

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
                                        │ (no retrieval, no write-back)
  ┌─ LONG-TERM MEMORY (not built) ──────▼──────────────────────────────┐
  │  ✗ vector store  ✗ past-run DB  ✗ retrieval  ✗ persistence         │
  │  next run starts from an empty messages[] — blind to all prior runs│
  └──────────────────────────────────────────────────────────────────┘
```

## Implementation in codebase

**Use cases.** Every agent run — monitor, diagnose, recommend, query — has exactly
this memory: a `messages` array that accumulates the turn-by-turn investigation and
vanishes when the run returns. The recommendation agent's *recovery turn* is the
clearest tell that there's no persistence: when the final answer won't parse, it
can't just "recall" the evidence — it has to *repackage* the tool-call results into
a fresh prompt by hand, because the original `messages` array isn't a queryable
memory, it's a transient local variable.

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

There is no `import` of any vector DB, embedding client, or persistence layer
anywhere in the runtime — the absence is the design, not an oversight. Grep the
runtime for a memory store and you find the message array and nothing else.

**The recovery turn proves there's no recall**,
`packages/agents/recommendation/src/recommendation-agent.ts:103-124`:

```
  recommendation-agent.ts  (lines 108-114, buildRecoveryPrompt)

  const evidence = toolCalls
    .map((call, index) =>
      `Query ${index+1}: ${call.toolName} …\nResult: ${JSON.stringify(payload)…}`)
    .join('\n\n');
       │
       └─ to "remember" what it found, the recovery path manually rebuilds
          the evidence string from the toolCalls records. If the agent had
          a memory it could query, this hand-repackaging wouldn't exist —
          it'd recall. It doesn't; it reconstructs from the run's records.
```

## Elaborate

The short-term/long-term split mirrors human cognition (working memory vs
long-term memory) and the framework world has standard names for both: "conversation
buffer" memory (the array) vs "vector store retriever" memory (the embedding DB).
The genuinely hard part is always the long-term side — chunking, embedding,
indexing, retrieval, relevance, and injecting recalled facts without blowing the
window. That hard part *is RAG* (retrieval-augmented generation), and AptKit
doesn't exercise it. Calling the message array "memory" is fine; calling it
long-term memory is the mistake to avoid.

The reason AptKit can get away with short-term only: its agents are single-shot
investigations (scan, diagnose, recommend) where everything needed is fetchable via
tools *within* the run. The moment you wanted "remember the merchant's preferences
across sessions" or "don't re-flag an anomaly you already reported," you'd need the
retrieval layer — and that's a section-03 (RAG) build, not an agent-loop tweak.

Adjacent concepts: the loop whose `messages` array *is* the memory
(`03-react-pattern.md`), the context window that bounds how much short-term memory
fits (`../02-context-and-prompts/01-context-window.md`), and the retrieval layer a
long-term memory would need (section 03 — RAG).

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

### Exercise — add long-term memory via the retrieval layer (Case B)

- **Exercise ID:** `[B4.8]` Phase 4, long-term-memory concept (depends on §03 RAG)
- **What to build:** A `PastAnomalyStore` that persists each run's reported
  anomalies with an embedding, and a retrieval step that, before a new monitor run,
  fetches similar prior anomalies and injects "already reported recently:" into the
  prompt — so the agent stops re-flagging the same thing.
- **Why it earns its place:** This is the honest gap: AptKit has no cross-run
  memory. Building it correctly *requires* the retrieval layer (embed → store →
  similarity query → inject) from section 03 — which is exactly why it's a Case B
  exercise, not a loop tweak. Demonstrates you know long-term memory is a separate
  system.
- **Files to touch:** a new `packages/agents/anomaly-monitoring/src/past-store.ts`,
  an embedding provider in `packages/providers/*`,
  `packages/agents/anomaly-monitoring/src/monitoring-agent.ts` (inject recall),
  matching tests.
- **Done when:** Re-running the monitor on an unchanged workspace surfaces a
  previously-reported anomaly as "already reported" instead of re-flagging it.
- **Estimated effort:** `1–2 days`

## Interview defense

**Q: Does your agent have memory?**
"Short-term, yes; long-term, no — and the distinction is the whole answer:"

```
  short-term: messages[] — within ONE run, GC'd at the end (have it)
  long-term:  vector store / past-run DB — across runs (DON'T have it)
```

"Short-term memory is just the `messages` array in `run-agent-loop.ts:94` — it
accumulates the turn history and gets re-sent every turn, which is why the model
appears to remember within a run. The moment the run returns, it's gone. There's no
vector store, no persistence, no retrieval — so each run starts blind to every prior
run. If I needed cross-run memory I'd build the retrieval layer; that's RAG, not an
agent-loop change."
*Anchor: short-term is an array; long-term is a system you build on purpose.*

**Q: How do you know there's no long-term memory — couldn't it be implicit?**
"The recovery turn is the proof. When the final answer won't parse, the agent
*manually rebuilds* the evidence from the `toolCalls` records
(`recommendation-agent.ts:108`). If it had a memory it could query, it would
recall, not reconstruct. Hand-repackaging the run's own records is what you do when
there's no store to ask."
*Anchor: reconstruction-from-records is the fingerprint of having no recall.*

## Validate

- **Reconstruct:** From memory, write the three lines that *are* AptKit's
  short-term memory: declare the array, push the assistant turn, push the tool
  results. Check against `run-agent-loop.ts:94, 124, 189`.
- **Explain:** Why do input tokens climb each turn even though the user only asked
  one question? (Because the whole growing `messages` array is re-sent every turn —
  short-term memory is paid for in re-send; `run-agent-loop.ts:103-109`.)
- **Apply:** The same revenue-drop anomaly happens two weeks running. Does the
  monitor remember reporting it last time? (No — `messages` was GC'd at the end of
  the first run; the second run starts from an empty array and re-flags it. Closing
  that gap is exercise `[B4.8]`.)
- **Defend:** Why is "add long-term memory" a section-03 RAG task and not a tweak to
  `runAgentLoop`? (Because it needs storage + embedding + similarity retrieval +
  injection — a whole retrieval layer the loop doesn't have a seam for; the loop
  only knows the transient `messages` array.)

## See also

- [03-react-pattern.md](03-react-pattern.md) — the loop whose `messages` array IS the memory
- [../02-context-and-prompts/01-context-window.md](../02-context-and-prompts/01-context-window.md) — the finite container short-term memory fills
- [06-error-recovery.md](06-error-recovery.md) — the recovery turn that rebuilds evidence by hand
- [../03-retrieval-and-rag/](../03-retrieval-and-rag/) — the retrieval layer a long-term memory needs
