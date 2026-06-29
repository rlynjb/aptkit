# 00 — Overview: the design shape at a glance

One page to orient before the audit. The job of every module-level design
decision in aptkit is to keep complexity from leaking across boundaries. Here's
the whole repo through that single lens, then the four contracts everything
hangs off.

```
  aptkit — modules as bands, contracts as the seams between them

  ┌─ Agents (composition layer) ───────────────────────────────────────┐
  │  RagQueryAgent · recommendation · diagnostic · query · monitoring   │
  │  each = prompt package + tool policy + loop config + validator      │
  └───────────────┬──────────────────────────┬──────────────────────────┘
                  │ runAgentLoop(...)          │ filterToolsForPolicy(...)
  ┌─ Runtime ─────▼──────────────┐  ┌─ Tools ──▼───────────────────────┐
  │  runAgentLoop · structured   │  │  ToolRegistry · ToolPolicy        │
  │  generation · usage ledger   │  │  search_knowledge_base · search_  │
  │  ── emits ──► CapabilityEvent│  │  memory                           │
  └──────┬───────────────┬───────┘  └──────────────┬────────────────────┘
         │ complete()    │ emit()                   │ pipeline.query()
  ┌─ Providers ▼──┐  ┌─ Trace sink ▼──┐  ┌─ Retrieval ▼─────────────────┐
  │ Gemma (emul.) │  │ in-memory (st.) │  │ EmbeddingProvider+VectorStore│
  │ Anthropic     │  │ SupabaseSink    │  │ InMemoryVectorStore · nomic  │
  │ fallback·guard│  │  (buffr)        │  │ ◄── @aptkit/memory reuses ───┤
  └───────────────┘  └─────────────────┘  └──────────────────────────────┘

  the four narrow contracts (the seams):
    ModelProvider.complete()        — runtime/src/model-provider.ts:54
    VectorStore + EmbeddingProvider — retrieval/src/contracts.ts:22-37
    CapabilityTraceSink.emit()      — runtime/src/events.ts:26
```

## What to notice first

**The interfaces are tiny and the bodies are big.** `complete()` is one method.
`VectorStore` is three. `emit()` is one. Behind each sits real machinery —
Gemma's tool-call emulation, cosine ranking and pgvector, NDJSON streaming or
Supabase rows. That ratio (big body ÷ small interface = depth) is the repo's
whole design strategy, and it mostly holds.

**The best evidence is reuse you can't see from one file.**
`@aptkit/memory`'s `remember`/`recall` are literally the RAG index and query
paths pointed at the same `EmbeddingProvider`/`VectorStore` contracts — zero new
infrastructure (`conversation-memory.ts:60`). A contract that a second,
unplanned consumer can adopt unchanged was drawn at the right boundary. That's
the single strongest design signal in aptkit.

## What's weak (named bluntly, fixed constructively)

1. **The `VectorStore` contract has no metadata filter**, so two modules
   independently re-implement "over-fetch `k*4` then filter client-side" — the
   search tool (`search-knowledge-base-tool.ts:88`) and memory
   (`conversation-memory.ts:94`). Same decision, two places. Fix: add `filter?`
   to `search`; push the work down into each store.

2. **`minTopK` defaults to off** (`search-knowledge-base-tool.ts:51`). The guard
   that stops a weak local model from starving its own retrieval is opt-*in*.
   Fix: make the safe value the default; let callers opt out.

3. **The trace seam is wired twice across two repos** with no shared sink — an
   in-memory array in `apps/studio/vite.config.ts:540` and `SupabaseTraceSink`
   in buffr. The interface held, but the observability story is split and aptkit
   ships no reference implementation. Fix: a `CollectingTraceSink` (and maybe an
   NDJSON sink) in `@aptkit/runtime`.

## Where each design move is walked deep

| if you want to understand… | read |
| --- | --- |
| why one 3-method contract carries five providers | `01-deep-provider-module.md` |
| how Gemma fakes tool-calling without leaking it | `02-emulation-hidden-behind-complete.md` |
| why the pipeline never names a vendor, and memory reuses it | `03-contract-as-the-product.md` |
| how the search tool defines model-hallucination errors out of existence | `04-guard-rails-as-information-hiding.md` |
| the one clean seam that's wired twice (the honest weakness) | `05-injectable-trace-seam.md` |
| how an agent is assembled from four smaller parts | `06-capability-as-composition.md` |

Then `audit.md` for the full 8-lens walk and the red-flag checklist.
