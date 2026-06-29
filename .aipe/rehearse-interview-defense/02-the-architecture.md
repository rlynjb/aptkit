# Chapter 2 — The Architecture

After the pitch, someone hands you a marker and says "walk me through the
system." This chapter is about drawing aptkit from scratch, at a whiteboard,
in ninety seconds, with confidence — and knowing exactly where they'll
interrupt and what to say when they do.

The trick is that you don't draw everything. You draw the *layers* and the
*two contracts*, because those are the load-bearing joints. If you can draw
the bands top to bottom and name what flows between them, you can answer
almost any architecture follow-up by pointing at the picture instead of
reaching for it in your head.

## The chapter-opening diagram — the whiteboard you redraw

This is the diagram you reproduce live. Practice drawing it until you can do
it in under ninety seconds: six bands, two contracts marked with stars, the
deployment seam at the bottom.

```
THE APTKIT REQUEST FLOW — draw these bands, mark the two contracts

  ┌─ UI LAYER · apps/studio (React 18 + Vite) ──────────────────────┐
  │  RagQueryWorkspace · AgentReplayShell · DocPage                 │
  │  static GitHub Pages — no backend server                        │
  └────────────────────────────────┬─────────────────────────────────┘
                                   │  invokes a capability
  ┌─ AGENT LAYER · packages/agents/* (6) ──▼───────────────────────────┐
  │  rag-query-agent.ts: injectProfile → registry → runAgentLoop      │
  │  capability = prompt pkg + tool policy + loop config + validator  │
  └────────────────────────────────┬─────────────────────────────────┘
                                   │  runAgentLoop(...)
  ┌─ RUNTIME · packages/runtime/run-agent-loop.ts ──▼──────────────────┐
  │  for turn < maxTurns:                                              │
  │    model.complete({system, messages, tools})  ★ CONTRACT 1 ★      │
  │    if tool_use → callTool → push result → loop                    │
  │    if last turn → drop tools, append synthesisInstruction         │
  │  emits CapabilityEvent trace (step/tool_call/usage/error)         │
  └──────────────┬─────────────────────────────────┬──────────────────┘
       complete() │                                 │ search_knowledge_base
  ┌─ PROVIDERS ───▼──────────────┐    ┌─ RETRIEVAL ──▼────────────────────┐
  │  gemma (LOCAL DEFAULT,       │    │  pipeline: embed → store.search   │
  │   emulated tool-calling,     │    │  ★ CONTRACT 2 ★                   │
  │   :11434, no key)            │    │  VectorStore + EmbeddingProvider  │
  │  anthropic · openai          │    │  InMemoryVectorStore (cosine)     │
  │  fallback chain · local guard│    │  nomic-embed-text, 768-dim        │
  └──────────────────────────────┘    └───────────────┬───────────────────┘
                                                      │ same VectorStore contract
  ┌─ DEPLOYMENT SEAM ─────────────────────────────────▼────────────────────┐
  │  buffr (separate repo): PgVectorStore implements VectorStore over       │
  │  Supabase pgvector + HNSW; agents schema; SupabaseTraceSink persists    │
  │  the CapabilityEvent trace to agents.messages. one-line store swap.     │
  └───────────────────────────────────────────────────────────────────────┘
```

That's the system. Six bands, data flowing down through `complete()` and
`search_knowledge_base`, and the deployment seam where buffr slots in. Now
let's walk the request end to end.

### Question 1 — "Walk me through what happens on a request"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Walk me through the architecture. What happens   │
│    when a user asks a question?"                    │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Can you trace one request end to end without      │
│   getting lost? Do you know where the boundaries    │
│   are? Can you stay at the right altitude — not     │
│   too vague, not lost in a single function?         │
└─────────────────────────────────────────────────────┘
```

Here's the walk. I trace one question through the RAG agent, top to bottom,
naming the contract every time I cross a boundary:

> "A question comes into the rag-query agent. First it builds the system
> prompt — `injectProfile` in `packages/agents/rag-query/rag-query-agent.ts`
> folds a profile into the template. Then it hands off to `runAgentLoop` in
> the runtime.
>
> The loop is bounded — it runs up to `maxTurns`, default eight. Each turn it
> calls `model.complete()`. That's my first contract, `ModelProvider` — the
> runtime never names a vendor, it just calls `complete()`. By default that's
> the local Gemma provider talking to Ollama on port 11434.
>
> If the model decides it needs to search, it emits a `search_knowledge_base`
> tool call. The loop runs the tool, which hits the retrieval pipeline:
> embed the query with nomic at 768 dimensions, search the `VectorStore` —
> that's my second contract — get back ranked hits with citations, feed them
> to the model as a tool result. The model loops again with the evidence.
>
> Here's the part I'm proud of: on the *last* turn, the loop drops the tools
> entirely and appends a synthesis instruction telling the model it has no
> more tool calls — so it's forced to answer with what it has instead of
> spinning forever asking to search again. That's the `forceFinal` branch in
> `run-agent-loop.ts`.
>
> The whole way through, the loop emits a `CapabilityEvent` trace. In aptkit
> that streams as NDJSON for Studio to replay. In buffr, a `SupabaseTraceSink`
> persists it to the `agents.messages` table. Same trace, two sinks."

That walk crosses every boundary and names the contract at each one. The
interviewer can interrupt anywhere and I'm already standing at the box.

```
┃ The whole system hangs off two contracts:
┃ complete() for models, VectorStore for retrieval.
┃ Name them every time you cross the boundary.
```

### Question 2 — "Why is the agent loop bounded? Why the forced synthesis?"

```
┌─────────────────────────────────────────────────────┐
│ THEY ASK                                            │
│   "Why cap the loop at maxTurns? What's the         │
│    forced-synthesis turn for?"                      │
│                                                     │
│ WHAT THEY'RE TESTING                                │
│   Do you understand the failure mode of an agent    │
│   loop — that a weak model will loop forever asking │
│   for one more tool call and never answer? Did you  │
│   design for that or get lucky?                     │
└─────────────────────────────────────────────────────┘
```

> "An agent loop's failure mode is non-termination — the model keeps deciding
> it needs one more search and never synthesizes an answer. A local Gemma is
> especially prone to this. So the loop is bounded two ways: a hard
> `maxTurns` ceiling and an optional `maxToolCalls` budget.
>
> But just stopping isn't enough — if you cut the model off mid-loop you get
> a tool call as the final output, not an answer. So on the last turn the
> loop flips a `forceFinal` flag: it passes `tools: undefined` so the model
> *can't* call a tool, and it appends a synthesis instruction —
> `buildSynthesisInstruction` literally says 'You have NO more tool calls
> available... Do not say you need more queries.' That forces a real answer
> out of whatever evidence it gathered. The empty-frontier termination of an
> agent loop, if you like — it's the part people forget to build."

That last line — naming the part people forget — is the senior signal. Lots
of people build an agent loop. Fewer remember that *the loop needs a forced
exit that still produces an answer*, not just a stop.

### Strong vs weak — the architecture walk

```
┌──────────────────────────────┬──────────────────────────────┐
│ WEAK WALK                    │ STRONG WALK                  │
├──────────────────────────────┼──────────────────────────────┤
│ "So there's a frontend, and  │ "A question hits the agent,  │
│  it talks to the agents, and │  which calls runAgentLoop.   │
│  the agents use the LLM, and │  Each turn calls complete()  │
│  there's a vector database   │  — that's the ModelProvider  │
│  for the RAG, and it all     │  contract, vendor-neutral.   │
│  kind of connects through    │  If it searches, it crosses  │
│  the runtime."               │  the VectorStore contract.   │
│                              │  Last turn forces synthesis."│
├──────────────────────────────┼──────────────────────────────┤
│ Why it's weak:               │ Why it works:                │
│ "kind of connects" is the    │ Names the boundary and the   │
│ tell. No named boundaries,   │ contract at every hop. The   │
│ no contracts, no direction.  │ interviewer can interrupt at │
│ The interviewer can't probe  │ any box and you're standing  │
│ because there's nothing      │ at it. Direction of flow is  │
│ specific to grab.            │ explicit.                    │
└──────────────────────────────┴──────────────────────────────┘
```

The weak walk uses the word "connects" three times. That word is where
architecture answers go to die — it means "I know these things are related
but I can't name the relationship." Name the relationship: it's a contract, a
call, a tool result. Direction and boundary, every hop.

### Where they'll interrupt — the follow-up tree

```
You finish the request walk.
      │
      ├─► IF THEY ASK "where does state live?"
      │     Conversation memory (packages/memory) and the
      │     vector corpus live in the VectorStore. In aptkit
      │     that's in-memory; in buffr it's Postgres. The
      │     runtime itself is stateless per loop. → Ch04.
      │
      ├─► IF THEY ASK "what if the model returns garbage?"
      │     parseAgentJson tolerates messy output; the gemma
      │     provider has parse-retry; structured generation
      │     retries on validation failure. → Ch05.
      │
      ├─► IF THEY ASK "why is memory not wired into an agent?"
      │     Honest: packages/memory reuses the retrieval
      │     contracts but no aptkit agent consumes it yet —
      │     buffr's chat runtime is the only consumer. It's
      │     built, not wired. → Ch06.
      │
      └─► IF THEY ASK "draw the deployment"
            buffr consumes the published bundle, implements
            VectorStore as PgVectorStore over Supabase
            pgvector+HNSW, adds SupabaseTraceSink. → Ch03.
```

The third branch is the honest one. If you claim memory is "integrated" and
they open the agents folder, you're caught. "It's built and reuses the
retrieval contracts, but only buffr's chat runtime consumes it — no aptkit
agent wires it yet" is precise and costs you nothing.

```
╔════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                     ║
║                                                         ║
║   They ask about HNSW internals: "How does the HNSW     ║
║   index actually find nearest neighbors? What's the     ║
║   graph construction cost?"                             ║
║                                                         ║
║   You used HNSW in buffr's Postgres index. You did      ║
║   NOT tune it or study its internals — you took the     ║
║   pgvector default and the numbers held.                ║
║                                                         ║
║   Say:                                                  ║
║   "I haven't gone deep on HNSW's graph construction or  ║
║    the layer-probability math. I used it as the         ║
║    pgvector default in buffr because it's the standard  ║
║    ANN index for cosine similarity, and at my corpus    ║
║    size the recall and latency were fine — my own       ║
║    in-memory store does a brute-force cosine scan and   ║
║    even THAT was acceptable. If you want to dig into     ║
║    HNSW's internals, walk me through where you'd start." ║
║                                                         ║
║   What this signals: you know what HNSW is FOR and why  ║
║   you reached for it, you're honest that you took the   ║
║   default, and you anchor it to a real tradeoff (brute  ║
║   force was fine at your scale). All senior signals.    ║
║                                                         ║
║   Do NOT say:                                           ║
║   "It builds a graph of nodes and navigates to close    ║
║    ones, it's hierarchical so it's fast..." — vague     ║
║   gesturing at internals you don't own is worse than    ║
║   the honest deferral.                                  ║
╚════════════════════════════════════════════════════════╝
```

```
        ▸ "Connects" is where architecture answers die.
          Name the relationship: a contract, a call, a
          tool result.
```

## What you'd change

If I were redrawing this architecture today, I'd make the trace sink a
first-class seam from the start. Right now the trace is a `CapabilityEvent`
union emitted by the loop, and aptkit streams it as NDJSON while buffr
persists it with `SupabaseTraceSink`. That works, but the sink boundary grew
organically — buffr added persistence after the fact. I'd define a
`TraceSink` contract in the runtime next to `ModelProvider` and `VectorStore`
so observability is one of the named seams, not an afterthought. It's the
same move I already made for models and retrieval; the trace deserved it too.

## One-page summary — Chapter 2

```
CORE CLAIM
  Draw six bands top to bottom, mark the TWO contracts
  (complete(), VectorStore), name the boundary at every hop.
  Never say "connects."

QUESTIONS COVERED
  Q: Walk me through a request.
     A: question → injectProfile → runAgentLoop → complete()
        [contract 1] → maybe search_knowledge_base [contract 2]
        → loop → last turn forces synthesis → CapabilityEvent trace.
  Q: Why bounded + forced synthesis?
     A: Non-termination is the loop's failure mode. maxTurns caps
        it; forceFinal drops tools + appends synthesisInstruction
        so it answers instead of looping. The forgotten part.
  Q: Where does state live? / model returns garbage? / memory?
     A: VectorStore (in-mem vs Postgres); parse-retry +
        structured-gen retry; memory built but only buffr wires it.

PULL QUOTES
  ▸ The whole system hangs off two contracts.
  ▸ "Connects" is where architecture answers die.

WHAT YOU'D CHANGE
  Promote the trace sink to a named TraceSink contract beside
  ModelProvider and VectorStore — observability as a real seam.
```
