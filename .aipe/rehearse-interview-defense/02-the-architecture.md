# Chapter 2 — The architecture

## Opening hook

In the first ten minutes of every senior interview, someone uncaps a marker, slides a whiteboard toward you, and says "walk me through what you built." This chapter is about doing that in ninety seconds without rambling — and then surviving the eight follow-up jabs that come while you're still drawing.

Here's the good news for you specifically: you think in pictures first, and this app *is* a picture. AptKit is layers stacked top to bottom, with two clean contracts running through the middle that everything plugs into. You don't have to memorize a script. You have to be able to redraw five boxes, name the two contracts, and trace one request down through them and back up. Do that and the architecture question is yours. The whole chapter trains that one motion: draw, then walk a request, then defend the seams.

## The chapter-opening diagram

This is the diagram you redraw at the whiteboard — six bands top to bottom, with the two contracts (`ModelProvider`, `VectorStore`) drawn as the horizontal seams everything else snaps onto.

```
  APTKIT — the whiteboard, top to bottom

  ┌─ UI layer ─────────────────────────────────────────────────────┐
  │  apps/studio  (React 18 + Vite)                                 │
  │  reads a CapabilityEvent[] trace, replays each turn visually    │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ trace events (NDJSON when streamed)
  ┌─ Agent layer ─────────────────▼─────────────────────────────────┐
  │  packages/agents/*   rag-query · query · recommendation · ...   │
  │  one agent = prompt package + tool policy + loop config         │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ runAgentLoop(...)
  ┌─ Runtime layer ───────────────▼─────────────────────────────────┐
  │  runAgentLoop  (bounded: maxTurns / maxToolCalls)               │
  │  emits CapabilityEvent trace · InMemoryToolRegistry.callTool    │
  │                                                                 │
  │   ═══ ModelProvider.complete() ═══   ← seam #1 (model)          │
  └───────────────┬──────────────────────────────────┬──────────────┘
                  │                                   │ search_knowledge_base
  ┌─ Provider ────▼─────────────┐    ┌─ Retrieval ────▼──────────────┐
  │ anthropic · openai          │    │ packages/retrieval            │
  │ fallback · local · gemma    │    │  ═ VectorStore ═  ← seam #2    │
  └───────────────┬─────────────┘    │  ═ EmbeddingProvider ═        │
                  │ HTTP             │  InMemoryVectorStore (cosine) │
  ┌─ External ────▼─────────────┐    └───────────────┬───────────────┘
  │ Anthropic · OpenAI          │                    │ embed / search
  │ Ollama (:11434, Gemma)      │◄───────────────────┘
  └─────────────────────────────┘
        evals (packages/evals) cross-cut every layer: live run → trace
        → artifact → score → promote to fixture → deterministic replay
```

Everything below is just walking that picture: down the bands, across the two seams, and back up with a grounded answer.

```
  ┃ "Five boxes, two contracts. If you can draw that and
  ┃  trace one request through it, you own the architecture
  ┃  question — the rest is just labeling the arrows."
```

## The body — questions and defenses

### Question 1 — "Walk me through the architecture."

This is the opener. It's not really a question — it's a test of whether you have a mental model or a pile of files.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Walk me through your system architecture."       │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you have a layered mental model, or do you     │
│   list files? Can you name the boundaries, not      │
│   just the boxes? Do you lead with structure        │
│   (layers + contracts) or drown them in detail?     │
│   A senior names the seams; a junior names the      │
│   folders.                                          │
└─────────────────────────────────────────────────────┘
```

Here's how you say it. Draw the six bands as you talk — your hand moving is half the signal.

> "AptKit is a TypeScript monorepo of reusable agent capabilities, and it's six layers top to bottom. At the top is Studio — a React and Vite app under `apps/studio` that reads a trace and replays an agent run visually. Below that are the agents in `packages/agents` — `rag-query`, `query`, `recommendation`, and a few more. Each agent is just three things composed: a prompt package, a tool policy, and an agent-loop config.
>
> Underneath the agents is the runtime — `runAgentLoop` in `packages/runtime/src/run-agent-loop.ts`. That's the engine. It's a bounded loop: it calls the model, runs any tools the model asked for, feeds the results back, and repeats until the model stops or it hits a turn or tool-call budget. As it runs, it emits a `CapabilityEvent` trace — that's what Studio reads.
>
> The runtime never talks to a vendor SDK directly. It talks to one contract: `ModelProvider.complete()`, defined in `packages/runtime/src/model-provider.ts`. That's the first seam. Below it sit the provider adapters — `anthropic`, `openai`, `gemma`, a `fallback` chain, and a `local` context-window guard — and each one wraps an external LLM: Anthropic's API, OpenAI's, or a local Ollama server running Gemma on port 11434.
>
> Cutting across all of that is retrieval, in `packages/retrieval`. It's the same idea applied to RAG: two contracts, `EmbeddingProvider` and `VectorStore`, with vendor-neutral logic on top. The agents reach retrieval as a *tool* the model can call — `search_knowledge_base` — not as bespoke control flow. And evals in `packages/evals` cross-cut everything: every run produces a trace, the trace becomes an artifact, the artifact gets scored, and good ones get promoted to fixtures for deterministic replay."

That's ninety seconds. Notice what carries the weight: the two contracts. You mention every layer, but you *spend* your words on `ModelProvider.complete()` and `VectorStore` — because those are the architecture. The layers are just where they live.

```
        ▸ The layers are the boxes. The contracts are the
          architecture. Lead with the seams everything plugs
          into, not the folder names.
```

#### Strong vs weak — the architecture walk

The failure mode here is the file tour. Watch the difference.

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "So there's a runtime        │ "It's six layers, but the    │
│ package, and a tools         │ spine is two contracts.      │
│ package, and a context       │ Everything talks to          │
│ package, and then agents,    │ ModelProvider.complete()     │
│ and providers — anthropic,   │ for the model and to         │
│ openai, gemma — and a        │ VectorStore for retrieval.   │
│ retrieval package, and       │ runAgentLoop drives the      │
│ evals, and a studio app...   │ model through that first     │
│ there's a lot of packages."  │ seam; retrieval reaches the  │
│                              │ agent as a tool through the  │
│                              │ second. Swap either adapter  │
│                              │ and nothing above the seam   │
│                              │ changes."                    │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ It's a `ls` of the repo.     │ Names the load-bearing       │
│ Fifteen package names with   │ structure first (two         │
│ no structure. The            │ contracts), then hangs the   │
│ interviewer can't tell what  │ layers off it. Shows you     │
│ depends on what, what's      │ understand *why* the         │
│ load-bearing, or whether     │ boundaries exist, not just   │
│ you understand the design    │ that they do.                │
│ or just memorized the tree.  │                              │
└──────────────────────────────┴──────────────────────────────┘
```

### Question 2 — "Walk me through one request, end to end."

Once you've drawn the static picture, they want to see it move. Pick the `rag-query` agent — it's the capstone and it touches both contracts.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Pick a real request and trace it end to end."    │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand control flow, or just the box   │
│   diagram? Who decides what happens next — your     │
│   code or the model? Where does retrieval enter —   │
│   as a prompt splice or as a tool call? Where does  │
│   the loop stop, and why doesn't it run forever?    │
└─────────────────────────────────────────────────────┘
```

This is the answer. Trace your finger down the bands and back up as you say it.

> "I'll trace a question through the `rag-query` agent. The user asks something like 'what frameworks have I shipped?' — that comes in as the `userPrompt`.
>
> First the agent builds its system prompt. In `packages/agents/rag-query/src/rag-query-agent.ts`, the constructor calls `injectProfile` to splice the user's profile — their `me.md` text — into a system template, then renders it. So the model knows *who* it's assisting before it sees the question.
>
> Then the agent grants tools. It calls `filterToolsForPolicy` with `ragQueryToolPolicy`, and that policy is a one-tool allowlist — `allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME]`. Least privilege. This agent can search the knowledge base and do nothing else, even if the registry holds more tools.
>
> Now it hands off to `runAgentLoop` with `maxTurns: 6` and `maxToolCalls: 4`. Turn one: the loop calls `model.complete()`. The model here is the Gemma provider. Gemma has no native tool-calling, so the provider *emulates* it — `buildSystemText` renders the tool's JSON schema into the system prompt and tells the model 'respond with only a JSON object if you want a tool.' Gemma replies with `{"tool": "search_knowledge_base", "arguments": {"query": "..."}}`. The provider's `parseToolCall` decodes that JSON into a real `tool_use` block. If the JSON is malformed, it appends a `RETRY_NUDGE` and asks once more before giving up.
>
> The loop sees a `tool_use`, so it calls `InMemoryToolRegistry.callTool`. That runs the retrieval query path in `packages/retrieval`: embed the query into a 768-dim vector with the Ollama nomic embedder, cosine-search the `InMemoryVectorStore`, rank, and return the top-k chunks — each with a citation built from its `docId` and text. Those chunks go back into the loop as a `tool_result`.
>
> Turn two: the loop calls the model again, now with the retrieved chunks in the conversation. Gemma reads them, grounds its answer, and cites the sources. No more `tool_use` blocks — just text — so the loop breaks and returns the final answer. And it's bounded: if the model kept asking to search, `maxToolCalls: 4` and `maxTurns: 6` would force a final synthesis turn instead of looping forever."

That's the whole motion. The thing to land hard: **the model decides when to search; your code decides when to stop.** That split is the agentic pattern.

```
  REQUEST FLOW — one rag-query, end to end (label every hop)

  ┌─ Agent ──────────────────────────────────────────────────────┐
  │ injectProfile → system prompt                                 │
  │ filterToolsForPolicy(ragQueryToolPolicy) → [search_knowledge] │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ hop 1: runAgentLoop(system, question, [tool])
  ┌─ Runtime: runAgentLoop ───────▼───────────────────────────────┐
  │ turn 1 ─ hop 2: model.complete(messages, tools)               │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ hop 3: emulated tool-call request
  ┌─ Provider: gemma ─────────────▼───────────────────────────────┐
  │ buildSystemText renders tool into system → Gemma emits JSON   │
  │ parseToolCall → ModelToolUseBlock   (hop 4: tool_use back up) │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ hop 5: callTool("search_knowledge_base")
  ┌─ Retrieval ───────────────────▼───────────────────────────────┐
  │ embed(query)→768d → InMemoryVectorStore.search (cosine) →     │
  │ ranked chunks + citations   (hop 6: tool_result back up)      │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ hop 7: turn 2 — model.complete(+ chunks)
  ┌─ Provider: gemma ─────────────▼───────────────────────────────┐
  │ grounds + cites → text only, no tool_use                      │
  └───────────────────────────────┬───────────────────────────────┘
                                  │ hop 8: loop breaks (no tool_use)
                          ┌────────▼────────┐
                          │ bounded final   │
                          │ answer returned │
                          └─────────────────┘
```

```
        ▸ Retrieval isn't spliced into the prompt. The model
          *calls* it. That one word — "calls" — is the whole
          difference between a RAG script and an agent.
```

### Question 3 — "How does this run in production? Where does the database come in?"

This is the seam question, and it's the one your portfolio answers beautifully. AptKit has no SQL database in it at all — the durable store lives in the companion repo, buffr. The whole point is that the swap is one line.

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "There's no real database here. How does this     │
│    actually run against persistent data?"           │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Did you design for substitution on purpose, or    │
│   did it just happen to be in-memory? Can you name   │
│   the exact contract the swap rides on? Do you       │
│   understand the difference between the library and  │
│   its deployment?                                    │
└─────────────────────────────────────────────────────┘
```

> "AptKit is the library — it's deliberately deployment-agnostic. There's no SQL database in the repo. The in-memory store, `InMemoryVectorStore`, ranks by cosine over a JavaScript array. That's the 'build the whole pipeline with zero cloud' adapter.
>
> The durable version lives in the companion repo, buffr. It has a `PgVectorStore` class — in `src/pg-vector-store.ts` — that implements the exact same `VectorStore` contract: `dimension`, `upsert`, `search`. Instead of a cosine scan over an array, it runs a pgvector query against a Postgres `agents.chunks` table, app-id-keyed for tenancy.
>
> And because they share the contract, the swap is genuinely one line. In buffr's `ask` command, the wiring is `new PgVectorStore({ pool, ... })` where aptkit would write `new InMemoryVectorStore(768)`. The pipeline, the tool, the agent, the loop — none of it changes. It's the same `RagQueryAgent` imported straight from the published `@rlynjb/aptkit-core` package. buffr also adds a `SupabaseTraceSink` that persists each turn into `agents.messages`, so the trajectory I can replay in Studio in aptkit becomes a durable, queryable trajectory in buffr."

That last point is the one that makes interviewers nod: **where state lives is itself a seam.** In aptkit the loop is stateless — the trace is held in memory and handed to Studio. In buffr the same trace flows into a `CapabilityTraceSink` implementation that writes to Postgres. Same contract, two homes.

```
  THE LIBRARY / DEPLOYMENT SEAM — one contract, two stores

   ┌─ aptkit (library) ─────────┐   ┌─ buffr (deployment) ───────┐
   │ import RagQueryAgent        │   │ import RagQueryAgent         │
   │   from @aptkit/* (workspace)│   │   from @rlynjb/aptkit-core   │
   │                             │   │   (npm)                      │
   │ store =                     │   │ store =                      │
   │   new InMemoryVectorStore   │   │   new PgVectorStore({pool})  │
   │     (768)                   │   │   → pgvector, agents.chunks  │
   │ ══ VectorStore ══           │   │ ══ VectorStore ══  (same!)   │
   │                             │   │                              │
   │ trace → in-memory →         │   │ trace → SupabaseTraceSink →  │
   │   Studio replay             │   │   agents.messages (durable)  │
   └─────────────────────────────┘   └──────────────────────────────┘
            same contract, the only diff is which adapter you `new`
```

#### Strong vs weak — the database question

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK ANSWER                  │ STRONG ANSWER                │
├──────────────────────────────┼──────────────────────────────┤
│ "Right now it's in-memory    │ "AptKit is the library, so   │
│ but I'd swap in a real       │ it ships in-memory on         │
│ database later. It wouldn't  │ purpose. The durable store    │
│ be hard, I'd just hook up    │ is PgVectorStore in buffr,    │
│ Postgres."                   │ which implements the same     │
│                              │ VectorStore contract against  │
│                              │ pgvector. The swap is one     │
│                              │ line — new PgVectorStore       │
│                              │ instead of new                 │
│                              │ InMemoryVectorStore — because  │
│                              │ both satisfy the same three   │
│                              │ methods. I've run it live      │
│                              │ end to end."                  │
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ "It wouldn't be hard" is a   │ Names the contract            │
│ promise, not a design. It    │ (VectorStore), names both    │
│ signals the seam doesn't     │ implementations, and proves   │
│ actually exist yet and       │ the seam is real by pointing  │
│ you're hoping it'll be easy. │ at the one-line swap that     │
│                              │ already runs.                │
└──────────────────────────────┴──────────────────────────────┘
```

### Where they'll interrupt — and what to say

Interviewers don't let you finish the clean walk. They jab mid-sentence. Here are the three jabs you'll get on this diagram and the one-line answers that hold ground.

**"Why provider-neutral? Isn't that over-engineering?"**
> "It's one contract — `ModelProvider.complete()`. The runtime depends on that interface, never a vendor SDK. The payoff is concrete: I develop against local Gemma for free with no API key, and the same agent runs against Anthropic or OpenAI by swapping the adapter — no change above the seam. The `fallback` provider is literally a chain of adapters behind the same contract. That's not speculative flexibility; I use both ends today."

**"Why is retrieval a tool? Why not just stuff the chunks into the prompt?"**
> "Because then the model can't decide *whether* it needs to search. A prompt-splice retrieves once, always, before the model thinks. Making it a tool means the model calls `search_knowledge_base` when it judges the question needs grounding, can search again with a refined query, and the loop bounds it at four calls. That's the agentic pattern — the model owns the *when*, my loop owns the *budget*."

**"Where does state live? Is the loop stateful?"**
> "The loop in aptkit is stateless — it builds a `messages` array per run and the trace is held in memory, then handed to Studio. There's no session store in the library. State lives one layer out: in buffr the same trace flows into `SupabaseTraceSink`, which persists every turn to `agents.messages`. So the library stays a pure function of its inputs; the deployment decides durability."

```
        ▸ When they interrupt, answer in one sentence and put
          your finger back on the diagram. The interruption is a
          test of whether you can hold the thread — so hold it.
```

#### Follow-up decision tree — after the request walk

Once you've traced the request, the conversation forks. Walk these branches now so none of them catch you cold.

```
  "Walk me through one request."
        │
        ▼
  You trace rag-query through both contracts.
        │
        ├─► IF THEY ASK "what if Gemma returns garbage JSON?"
        │     The provider's parseToolCall returns null, the loop
        │     appends RETRY_NUDGE, asks once more. If it's still
        │     bad, it falls through to treating the reply as plain
        │     text — a real answer, not a crash. maxToolCallAttempts
        │     caps the retries.
        │
        ├─► IF THEY ASK "what stops the loop running forever?"
        │     Two budgets: maxTurns (6) and maxToolCalls (4). On the
        │     last turn the loop drops the tools array and injects a
        │     synthesisInstruction — "you have NO more tool calls,
        │     answer now." Forced final turn. Name this one; it's
        │     the part people forget.
        │
        ├─► IF THEY ASK "how does Studio know what happened?"
        │     The loop emits CapabilityEvent trace events — step,
        │     tool_call_start, tool_call_end, model_usage. Studio
        │     reads that array (NDJSON when streamed) and replays
        │     each turn. The trace IS the observability surface.
        │
        └─► IF THEY ASK "what if a weak model asks for top_k: 1?"
              The tool has a minTopK floor. A weak local model
              passing top_k:1 would starve a multi-part question;
              minTopK clamps it up so retrieval doesn't self-sabotage.
```

## When you don't know

You haven't built RAG at large scale, and you haven't run pgvector under sustained load. If they push into the internals of approximate-nearest-neighbor indexes — HNSW graph construction, IVF lists, recall-vs-latency tuning — that's past your depth. AptKit's `InMemoryVectorStore` is an exact linear cosine scan, not an ANN index. Own that cleanly.

```
╔═══════════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                            ║
║                                                               ║
║   They ask: "How does your vector search scale? What ANN      ║
║   index are you using — HNSW, IVF? How do you tune recall     ║
║   against latency?"                                           ║
║                                                               ║
║   Say:                                                        ║
║   "My InMemoryVectorStore is an exact linear cosine scan —    ║
║    O(n) over every chunk. It's correct, not fast, and it's    ║
║    deliberate: aptkit is a library that demonstrates the      ║
║    pipeline with zero infrastructure. The durable store in    ║
║    buffr is pgvector, which I'd configure with an HNSW index  ║
║    for production scale. I haven't tuned HNSW's recall/        ║
║    latency tradeoff myself — I've used it on defaults. If     ║
║    you want to dig into how the ef_search parameter trades    ║
║    recall for speed, walk me through what you'd want me to    ║
║    reason about and I'll think it through with you."          ║
║                                                               ║
║   What this signals: you know exactly what your code does     ║
║   (linear scan), you know what production would need (ANN     ║
║   index), and you're honest about the boundary of your        ║
║   hands-on depth without faking it.                           ║
║                                                               ║
║   Do NOT say:                                                 ║
║   "It uses cosine similarity which is, like, optimized,       ║
║    and pgvector handles the scaling part automatically."      ║
║   "Optimized" with no mechanism and "handles it               ║
║   automatically" are the two phrases that tell a senior       ║
║   interviewer you've never looked under the hood.             ║
╚═══════════════════════════════════════════════════════════════╝
```

The move here is the same one that runs through this whole book: be precise about what you built (linear cosine scan, one-line swap, two contracts), and be precise about where your depth ends (ANN index tuning). Precision on both sides reads as senior. Vagueness on either reads as a tell.

## What you'd change

If you were drawing this architecture fresh today, the one thing you'd reconsider is the trace transport. Right now Studio reads a `CapabilityEvent[]` array in memory, and buffr persists the same events to `agents.messages` — two consumers of the same trace, wired separately. You'd factor the trace into a single streaming `CapabilityTraceSink` boundary from the start, so that in-memory replay, NDJSON streaming, and Postgres persistence are all just adapters behind one contract — exactly the way `ModelProvider` and `VectorStore` already are. The architecture got the model seam and the storage seam right early; the observability seam grew in second, and you can see the seam in the wiring. That's the honest answer to "what would you redo": make the trace a first-class contract on day one, not a shape that hardened after the fact.

## One-page summary

**Core claim:** AptKit is six layers stacked top to bottom (Studio → Agents → Runtime → Providers → Retrieval → External LLMs), but the architecture *is* two contracts — `ModelProvider.complete()` and `VectorStore` — that everything plugs into. Lead with the seams; the layers just say where they live.

**Questions covered:**

- **"Walk me through the architecture."** → Six layers, but the spine is two contracts. Studio reads a trace; agents = prompt + policy + loop config; `runAgentLoop` drives the model through `ModelProvider.complete()`; retrieval reaches agents as a tool through `VectorStore`. (`packages/runtime/src/model-provider.ts`, `run-agent-loop.ts`)
- **"Trace one request end to end."** → `rag-query`: `injectProfile` builds the system prompt → `filterToolsForPolicy` grants only `search_knowledge_base` → `runAgentLoop` → Gemma emits an emulated JSON tool-call (`parseToolCall`) → `InMemoryToolRegistry.callTool` runs embed → cosine search → ranked chunks with citations → next turn grounds and cites → loop breaks, bounded by `maxTurns: 6` / `maxToolCalls: 4`.
- **"Where's the database? How does it run in production?"** → aptkit is the library (in-memory, zero-cloud); buffr is the deployment. `PgVectorStore` implements the same `VectorStore` contract against pgvector. The swap is one line; the agent is imported unchanged from `@rlynjb/aptkit-core`.
- **Interruptions:** provider-neutral = one contract, dev on free local Gemma; retrieval-as-tool = model owns *when*, loop owns *budget*; state = stateless loop in aptkit, trajectory persisted to `agents.messages` in buffr.

**Pull quotes:**

```
  ┃ "Five boxes, two contracts. Draw that and trace one
  ┃  request through it, and you own the architecture question."

  ▸ Retrieval isn't spliced into the prompt. The model calls it.

  ▸ Where state lives is itself a seam: stateless loop in the
    library, durable trajectory in the deployment.
```

**What you'd change:** Make the trace a first-class streaming `CapabilityTraceSink` contract from day one — the model seam and storage seam landed early, the observability seam hardened second.
