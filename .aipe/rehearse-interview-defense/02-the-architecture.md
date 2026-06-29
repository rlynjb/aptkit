# Chapter 2 — The Architecture

After the pitch lands, the interviewer almost always says "walk me through the architecture." This is the whiteboard moment. You'll stand up, pick up a marker, and have ninety seconds to draw a system that someone who has never seen the code can follow. This chapter teaches you to draw aptkit from memory, top to bottom, and to know in advance where they'll interrupt.

You think visually first — this is your strongest interview moment, not your weakest. Lead with the picture. Draw the layers, then trace one request down through them. Never start with a file.

## The chapter-opening diagram — the system you draw

This is the diagram you reproduce at the whiteboard. Memorize the five bands and the two seams; the boxes inside are detail you fill as you talk.

```
  APTKIT ARCHITECTURE — five layers, two load-bearing seams

  ┌─ STUDIO (apps/studio, React 18 + Vite) ──────────────────────────┐
  │  hash-routed UI · AgentReplayShell replays traces ·              │
  │  RagQueryWorkspace = deterministic in-browser RAG, precision@1   │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │  invoke a capability
  ┌─ AGENTS (6 capabilities) ─────▼──────────────────────────────────┐
  │  recommendation · anomaly-monitoring · diagnostic-investigation  │
  │  query · rubric-improvement · rag-query (capstone)               │
  │  each = prompt package + tool policy + loop config + validator   │
  └───────────────────────────────┬──────────────────────────────────┘
                                  │  runAgentLoop(provider, tools, …)
  ┌─ RUNTIME (packages/runtime) ──▼──────────────────────────────────┐
  │  bounded loop · CapabilityEvent trace · forced synthesis turn    │
  │  ════ SEAM 1: ModelProvider.complete() ══════════════════════    │
  └──────────┬───────────────────────────────────┬────────────────────┘
             │ complete(request)                 │ search_knowledge_base
  ┌─ PROVIDERS ▼─────────────────┐   ┌─ RETRIEVAL ▼─────────────────────┐
  │  gemma (local default,       │   │  ═ SEAM 2: EmbeddingProvider +   │
  │   emulated tool-calling) ★   │   │    VectorStore ═══════════════   │
  │  local guard · fallback      │   │  InMemoryVectorStore (cosine)    │
  │  anthropic · openai (cloud)  │   │  OllamaEmbeddingProvider, 768    │
  └──────────────────────────────┘   └───────────────┬──────────────────┘
                                                     │ same VectorStore
  ┌─ buffr (separate repo, consumes the npm bundle) ──▼────────────────┐
  │  PgVectorStore implements VectorStore over Supabase pgvector+HNSW  │
  │  agents schema in reindb · app_id tenancy · SupabaseTraceSink     │
  └────────────────────────────────────────────────────────────────────┘
```

Notice what carries the weight: the two seam lines (`══`). Everything above seam 1 is a client of the model port; everything in the providers band is an adapter for it. Same story for seam 2 and retrieval. If you can draw the bands and mark the two seams, the rest is narration.

## Question 1 — walk me through the system

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Walk me through the architecture."                     │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Do you have a layered mental model or a pile of files?  │
│   Can you trace one request end-to-end without losing     │
│   the thread? Do you know which boundaries are            │
│   load-bearing and which are incidental? A candidate who  │
│   draws a clean five-band diagram and traces one flow     │
│   through it is signalling they actually designed this.   │
└─────────────────────────────────────────────────────────┘
```

The strong answer is a guided tour down the diagram, following one request. Say this while you draw:

> "I'll trace a RAG query, because it touches every layer. Start at the top — Studio, the React preview UI, or in production a buffr session. It invokes a capability, the rag-query agent.
>
> That agent is a thin composition: a prompt package, a tool policy that allowlists one tool, and a call to `runAgentLoop`. The loop is the runtime. It's bounded — maxTurns is 6 for this agent — and on the last turn it forces a synthesis instruction so the model has to answer from what it found instead of asking for another search.
>
> The loop talks to the model through one contract — `ModelProvider.complete()`. That's the first seam. The default adapter behind it is Gemma over Ollama, running locally. Gemma has no native tool-calling, so the provider emulates it: it renders the tools into the system prompt as JSON, demands a single JSON object back, parses it, and retries once with a corrective nudge if the JSON is malformed.
>
> When the model decides to search, the loop runs the `search_knowledge_base` tool. That crosses the second seam — `EmbeddingProvider` and `VectorStore`. In aptkit the store is in-memory, a cosine scan over an array. In buffr the exact same contract is implemented by `PgVectorStore` over Postgres pgvector with an HNSW index. The agent code doesn't change — buffr swaps the store at wiring time.
>
> The loop emits a `CapabilityEvent` trace the whole way — step, tool_call_start, tool_call_end, model_usage. Studio replays it; buffr persists it to the `agents.messages` table through a trace sink."

That's the whole system in one request. You never listed packages — you followed data down through five bands and named the two seams as you crossed them.

```
  ▸ Don't describe the layers. Trace one request through
    them. The flow IS the architecture; the file list isn't.
```

## Where they'll interrupt — the follow-up tree

Interviewers interrupt the architecture walk. Knowing where lets you welcome it instead of losing your place.

```
  You're tracing the RAG query and cross seam 1 (the model port).
        │
        ├─► IF THEY ASK "why a port and not just call Anthropic?"
        │     "So the loop never names a vendor. The same loop runs
        │      against Gemma locally, the fallback chain, or a cloud
        │      SDK — they're all adapters for one contract. Memory
        │      later proved this: it's a second consumer of the
        │      retrieval ports with zero new infrastructure."
        │
        ├─► IF THEY ASK "how does Gemma do tool calls without support?"
        │     "It doesn't — I emulate it. Tools go into the system
        │      prompt as JSON, the model returns one JSON object, I
        │      parse it into a tool_use block, retry once on bad JSON.
        │      packages/providers/gemma/src/gemma-provider.ts."
        │
        └─► IF THEY ASK "what stops the loop running forever?"
              "A hard turn budget — the for-loop caps at maxTurns, and
               the last turn forces a synthesis instruction so the model
               answers instead of asking for another tool call. Bounded
               by construction, not by hoping the model stops."
```

The forced synthesis turn is the part interviewers don't expect you to have. Naming it — "the last turn forces a synthesis instruction so the model can't just keep asking for more searches" — signals you built the loop, not read about one.

## Question 2 — what's the relationship between aptkit and buffr

```
┌─────────────────────────────────────────────────────────┐
│ THEY ASK                                                  │
│   "Why is there a second repo? Why not one codebase?"     │
│                                                           │
│ WHAT THEY'RE TESTING                                      │
│   Do you understand the difference between a library and  │
│   a deployment? Can you defend a boundary that costs you  │
│   something (two repos, a publish step) on the grounds    │
│   of what it buys (the core stays deployment-agnostic)?   │
└─────────────────────────────────────────────────────────┘
```

> "AptKit is the library — it's deployment-agnostic on purpose. It ships an in-memory vector store and a local model so it runs with zero infrastructure, but it makes no decision about where data lives. Buffr is one deployment: a laptop runtime that consumes the published bundle, `@rlynjb/aptkit-core`, and fills the durable slot. It implements `PgVectorStore` against the same `VectorStore` contract, brings the `agents` schema in a shared Postgres, and persists traces. The swap is one line — buffr injects its store where aptkit would use the in-memory one. The cost is a publish step and a version contract between the repos. What it buys is that aptkit's core never imports app-specific product logic, which is the entire reason the monorepo exists."

## When you don't know — the internals of the index

```
╔═══════════════════════════════════════════════════════════╗
║ WHEN YOU DON'T KNOW                                        ║
║                                                           ║
║   You mention buffr's HNSW index and they ask: "Walk me   ║
║   through how HNSW actually works internally — the layer  ║
║   construction, the search descent."                      ║
║                                                           ║
║   You picked HNSW on pgvector's defaults. You understand  ║
║   it's an approximate-nearest-neighbor graph and why you  ║
║   need it (the in-memory scan is linear), but you haven't ║
║   tuned its internals or studied the multi-layer skip-    ║
║   list construction.                                      ║
║                                                           ║
║   Say:                                                    ║
║   "I haven't gone deep into HNSW's internal layer         ║
║    construction — I picked it on pgvector's defaults      ║
║    because I knew I needed approximate nearest-neighbor    ║
║    once the corpus outgrew a linear scan, and the recall  ║
║    held up on my corpus. What I do understand is the      ║
║    tradeoff it's making: it trades exact results for      ║
║    sublinear search. If you want to go into the layer     ║
║    graph, I'd be learning it with you — where would you   ║
║    start?"                                                ║
║                                                           ║
║   What this signals: you know what the structure BUYS     ║
║   (sublinear ANN) and why you reached for it, you're      ║
║   honest about the depth limit, and you invite the        ║
║   interviewer to teach. All three read as senior.         ║
║                                                           ║
║   Do NOT say:                                             ║
║   "It's a graph that connects nearby vectors and you      ║
║    sort of hop around to find close ones."                ║
║   Vague hand-waving in territory you don't own is the     ║
║   surest way to fail. Name the limit instead.            ║
╚═══════════════════════════════════════════════════════════╝
```

## What you'd change

If you were drawing this fresh, you'd make the trace seam explicit in the architecture from day one. Right now the `CapabilityEvent` trace is emitted by the loop and consumed two ways — Studio replays it, buffr persists it through `SupabaseTraceSink` — but there's no formal "trace sink" port in aptkit's core the way there's a model port and a vector port. Buffr defines `CapabilityTraceSink` on its side. Lifting that into a third contract in the core would make the observability seam a first-class part of the diagram instead of an implicit one. It works as-is, but a third named seam would be more honest about what's actually swappable.

## One-page summary

**Core claim:** Trace one request down five bands (Studio → agents → runtime → providers + retrieval → buffr) and mark the two seams (model port, retrieval ports) as you cross them. The flow is the architecture.

**Questions covered:**
- *"Walk me through the architecture."* → Trace a RAG query top to bottom; name the two seams; name the forced synthesis turn and the bounded loop.
- *"Why two repos?"* → Library (deployment-agnostic) vs deployment (buffr fills the durable slot via the same VectorStore contract); cost is a publish step, buy is a core that never imports product logic.
- *"How does HNSW work internally?"* → Name what it buys (sublinear ANN), own the depth limit, invite the interviewer in.

**Pull quotes:**
- Don't describe the layers. Trace one request through them. The flow is the architecture.
- The forced synthesis turn is the part they don't expect you to have. Name it.

**What you'd change:** Lift the trace sink into a third named contract in aptkit's core so the observability seam is first-class, not implicit.
