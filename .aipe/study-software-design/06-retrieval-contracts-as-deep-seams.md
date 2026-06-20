# 06 — Retrieval contracts: the deep-module shape, a second time

**Industry names:** Port / Adapter (hexagonal) · narrow interface over a large
implementation · "deep module" (APOSD) · defensive defaults / robustness
principle.
**Type:** Language-agnostic design pattern.

---

## Zoom out, then zoom in

AptKit grew a RAG package — `@aptkit/retrieval`. The interesting part for *this*
guide is not that it does retrieval; it's that the package author reached for the
exact same design move `ModelProvider` uses (`01`) and applied it twice more:
two tiny interfaces (`EmbeddingProvider`, `VectorStore`) hiding two large,
swappable bodies (an HTTP embedder, a cosine-ranking store).

```
  Zoom out — where the retrieval contracts sit

  ┌─ Capabilities / tools ─────────────────────────────────────────┐
  │  search_knowledge_base tool  →  registered into ToolRegistry    │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ calls
  ┌─ Retrieval pipeline (@aptkit/retrieval) ───▼────────────────────┐
  │  createRetrievalPipeline → index() / query()                    │
  │            depends ONLY on two contracts:                       │
  │  ★ EmbeddingProvider ★          ★ VectorStore ★  ◄── marked     │
  └──────────┬──────────────────────────────────┬───────────────────┘
             │ embed(texts)                      │ search(vector, k)
  ┌─ Adapters ▼──────────────────┐   ┌───────────▼───────────────────┐
  │ OllamaEmbeddingProvider      │   │ InMemoryVectorStore (cosine)   │
  │ (nomic, 768-dim, over HTTP)  │   │ PgVectorStore — later drop-in  │
  └──────────────────────────────┘   │ (lives in buffr, not here)     │
                                     └────────────────────────────────┘
```

**Zoom in.** Same pattern as `01`: **maximise behaviour behind the interface,
minimise the interface itself.** `EmbeddingProvider` is three members
(`id`, `dimension`, `embed`); `VectorStore` is three (`dimension`, `upsert`,
`search`). Behind them sits HTTP transport, cosine math, ranking, and dimension
validation — none of which the pipeline knows about. The question both contracts
answer: *how does the pipeline stay vendor-neutral — nomic today, OpenAI
embeddings tomorrow; in-memory today, pgvector tomorrow — with zero pipeline
edits?* The same answer as `ModelProvider`: nothing above the contract line is
allowed to name a vendor.

---

## Structure pass — layers · axis · seams

**Layers:** tool (`search_knowledge_base`) → pipeline (`index`/`query`) → two
contracts (`EmbeddingProvider`, `VectorStore`) → adapters (Ollama HTTP, in-memory
cosine) → network / process memory.

**Axis — trace "what does this layer know about the storage/embedding vendor?"**

```
  one question down the stack: "does this layer name nomic or in-memory?"

  ┌──────────────────────────────────────┐
  │ search_knowledge_base handler         │  → NO. calls pipeline.query().
  └──────────────────────────────────────┘
      ┌──────────────────────────────────┐
      │ queryKnowledgeBase (pipeline)     │  → NO. calls contract methods only.
      └──────────────────────────────────┘
          ┌──────────────────────────────┐
          │ EmbeddingProvider / VectorStore│ → NO. dimension is a number,
          │ (the interfaces)              │    id is an opaque string.
          └──────────────────────────────┘
              ┌──────────────────────────┐
              │ OllamaEmbeddingProvider   │  → YES. nomic-embed-text, 768,
              │ InMemoryVectorStore       │    cosine, fetch /api/embed.
              └──────────────────────────┘

  the answer flips at the adapter line — same seam shape as ModelProvider (01)
```

**Two load-bearing seams, not one.** The pipeline sits between *two* swap points
at once — the embedder and the store. That's why retrieval gets its own file
instead of folding into `01`: it's the deep-module move composed twice, with a
third constraint stitching the two seams together — the **dimension one-way
door** (below). When two independently-swappable contracts must agree on a
number, who validates the agreement, and when, is itself a design decision.

---

## How it works

You already know the `ModelProvider` shape from `01`: one narrow interface, a
huge hidden body, vendor knowledge trapped below the seam. Retrieval is the same
move — but with a twist `01` doesn't have. Two contracts share a fact (`dimension`),
and that shared fact is exactly the kind of thing APOSD warns leaks across module
boundaries. Watch how the pipeline handles it.

### Move 1 — the shape: two necks, one shared constraint

```
  the retrieval deep-module shape

   pipeline sees:        ┌─ EmbeddingProvider ─┐   ┌─ VectorStore ──────┐
                         │ id  dimension       │   │ dimension          │
                         │ embed(texts)        │   │ upsert / search    │
                         └─────────┬───────────┘   └─────────┬──────────┘
  ════════════════════ seam ═══════╪═══════════════════════╪══════════ seam ═══
                         ┌─────────▼──────┐        ┌─────────▼──────────┐
                         │ HTTP to Ollama │        │ cosine over a Map  │
                         │ nomic 768-dim  │        │ rank, slice top-k  │
                         └────────────────┘        └────────────────────┘
                                  │                          │
                                  └──── must agree on ───────┘
                                       `dimension` (the one-way door)
```

The interface is small; the bodies are large; and the one fact both bodies must
share — the embedding dimension — is promoted to a *visible field on each
contract* so the pipeline can check it. That promotion is the design choice.

### Move 2 — the parts

**The two contracts are deliberately three members each.** `EmbeddingProvider` is
`{ id, dimension, embed }`; `VectorStore` is `{ dimension, upsert, search }`. No
"nomicModelName", no "indexName", no cosine knob. Anything one vendor needs that
isn't in this list gets absorbed by the adapter — the same boundary condition as
`ModelProvider`. The break point is identical: the day a store needs a parameter
no other store can fake, you either widen the contract (shallower) or hide it in
the adapter.

**The dimension one-way door — a leak turned into a guard.** Here's the part to
study. A corpus embedded at 768 dimensions *cannot* be searched by a query
embedded at some other dimension — the cosine math is meaningless across
dimensions. That's a fact known to *both* the embedder and the store: a classic
APOSD information leak, knowledge that lives in two modules and forces them to
agree. The pipeline doesn't let that agreement stay implicit.

```
  where the shared fact gets checked — fail at wiring time, not query time

  ┌─ createRetrievalPipeline(wiring) ──────────────────────────────┐
  │  assertWiring:  embedder.dimension === store.dimension ?       │
  │     no  ──► throw "dimension mismatch ... re-index the corpus" │  ← loud,
  │     yes ──► return { index, query }                            │    immediate
  └────────────────────────────────────────────────────────────────┘
        │
        └─ checked again inside the store on every upsert/search:
           vector.length === this.dimension ? else throw

  two checks, same invariant: once at wiring (config bug),
  once per vector (runtime corruption). Both fail loudly.
```

The decision: a dimension mismatch is a *wiring bug*, not a runtime input, so it
fails the instant you wire the pipeline — not silently at query time when ranking
quietly returns garbage. The store double-checks each vector's length too, so a
hand-built adapter that lies about its dimension still can't corrupt ranking
unnoticed. This is APOSD's "define errors out of existence" inverted into "make
the un-recoverable error impossible to miss."

**The search tool hardens the seam against weak callers.** The
`search_knowledge_base` tool wraps the pipeline's `query` for the model to call,
and it makes two robustness decisions the pipeline itself doesn't:

```
  two defenses inside the tool handler

  caller (a possibly-weak local model) sends:
     top_k: 1            ──►  topK = max(requestedTopK, minTopK)
        │                       └─ a minTopK floor (default 1, set higher to
        │                          stop a weak model starving its own retrieval)
        ▼
     filter: {hallucinated: "x"}  ──►  matchesFilter ignores keys ABSENT
                                       from a chunk's meta, so a made-up filter
                                       key can't wipe every result to zero
```

Both are the *robustness principle* (be liberal in what you accept): the tool
assumes the model on the other side may be weak — a small local Gemma, not
Claude — and refuses to let a bad `top_k: 1` or a hallucinated filter key
silently destroy retrieval. The floor and the absent-key-tolerant filter are
complexity the tool *pulls down* so no prompt has to coach the model around them.
→ this is the `pull-complexity-downward` lens (audit Lens 5) applied to a tool
boundary.

**Gemma's tool-call emulation — the same hiding move, one layer over.** Worth
naming alongside retrieval because it's the *reason* the search tool hardens
itself. `GemmaModelProvider` (`@aptkit/provider-gemma`) implements the same
`ModelProvider` interface from `01`, but Ollama's Gemma has **no native tools
array**. The adapter hides that entirely: it renders the tool schemas into the
system prompt, demands a JSON tool call back, parses the messy reply into a
`tool_use` content block, and retries with a corrective nudge if the model botches
the JSON. Above the seam, `runAgentLoop` sees a normal tool-using provider; below
it, there's a whole emulation the loop never learns about. Same deep-module
contract, an unusually large body behind it.

### Move 3 — the principle

**When a design move works once, the strongest signal a codebase can send is
using it again — deliberately, recognisably, with the same shape.** Retrieval
didn't invent a new abstraction style; it copied `ModelProvider`'s deep-module
move and applied it to two new seams, then added one honest twist: the shared
`dimension` fact, which *could* have leaked silently across two modules, is
promoted to a checked invariant that fails loud at wiring time. The lesson
generalises past RAG: when two swappable modules must agree on a fact, make the
fact a visible field and check it at the cheapest, earliest, loudest point —
config time beats query time.

---

## Primary diagram

```
  Retrieval — the full picture

  ┌─ Tool layer ───────────────────────────────────────────────────┐
  │  search_knowledge_base  (minTopK floor · absent-key-tolerant     │
  │                          filter · citation snippet)              │
  └───────────────────────────────┬─────────────────────────────────┘
                                  │ pipeline.query(query, k)
  ┌─ Pipeline (vendor-neutral) ───▼─────────────────────────────────┐
  │  index: doc → chunk → embed → upsert                            │
  │  query: q → embed → search → ranked hits                        │
  │  assertWiring: embedder.dimension === store.dimension (1-way door)│
  └──────────┬───────────────────────────────────┬──────────────────┘
             │ embed(texts)                       │ upsert / search(vec, k)
   ┌─ EmbeddingProvider ─┐               ┌─ VectorStore ──────────────┐
   │ OllamaEmbedding     │               │ InMemoryVectorStore        │
   │ nomic · 768 · HTTP  │               │ cosine over Map · top-k    │
   └─────────┬───────────┘               │ PgVectorStore → in buffr   │
             │ POST /api/embed           └────────────┬───────────────┘
             ▼                                        ▼
        Ollama (localhost:11434)              process memory / (pgvector)
```

---

## Implementation in codebase

**Use cases in this repo.** A host app indexes documents
(`createRetrievalPipeline(...).index(doc)`), then exposes retrieval to an agent by
registering `createSearchKnowledgeBaseTool(pipeline)` into an
`InMemoryToolRegistry` and selecting it with `filterToolsForPolicy` — exactly the
tool-policy seam `04`/audit Lens 4 describe. The in-memory store is the
"build the whole RAG loop with zero cloud" path; `PgVectorStore` is the
production drop-in and lives in the **buffr** repo, behind the same `VectorStore`
contract, so no pipeline code changes when you swap it.

**The two contracts — `packages/retrieval/src/contracts.ts:22-37`:**

```
  export type EmbeddingProvider = {
    id: string;                        ← opaque label, like ModelProvider.id
    dimension: number;                 ← the shared fact, promoted to a field
    embed(texts: string[]): Promise<number[][]>;
  };

  export type VectorStore = {
    dimension: number;                 ← same fact on the other side of the seam
    upsert(chunks: VectorChunk[]): Promise<void>;
    search(vector: number[], k: number): Promise<VectorHit[]>;
  };                                   └─ three members each; bodies hidden below
```

Promoting `dimension` to a field on *both* types is what makes `assertWiring`
possible. Without it the agreement would be implicit and the mismatch would
surface as silently-wrong rankings.

**The one-way door — `packages/retrieval/src/pipeline.ts:22-29`:**

```
  function assertWiring(wiring: RetrievalWiring): void {
    if (wiring.embedder.dimension !== wiring.store.dimension) {  ← the shared invariant
      throw new Error(
        `dimension mismatch: embedder "${...}" is ${...}-dim `   ← names both sides
        + `but store is ${...}-dim — re-index the corpus ...`);  ← tells you the fix
    }
  }
        │
        └─ called from createRetrievalPipeline AND from indexDocument/
           queryKnowledgeBase, so even direct (non-pipeline) callers can't
           skip it. Without it, a 768-dim corpus searched by a 1536-dim query
           returns plausible-looking but meaningless rankings — the worst kind
           of bug (silent, wrong, not crashing).
```

**The per-vector recheck — `packages/retrieval/src/in-memory-vector-store.ts:36-42`:**

```
  private assertDimension(vector: number[], label: string): void {
    if (vector.length !== this.dimension) {                ← second line of defense
      throw new Error(`dimension mismatch: ${label} has length ...`);
    }
  }                                                        └─ runs on every upsert
                                                              AND every search vector
```

Two checks for one invariant: `assertWiring` catches the config bug once;
`assertDimension` catches a lying adapter on every vector. Belt and suspenders for
the one error that can't be recovered from.

**The weak-caller defenses —
`packages/retrieval/src/search-knowledge-base-tool.ts:51, 81, 101-106`:**

```
  const minTopK = Math.max(1, options.minTopK ?? 1);          ← line 51: floor config
  ...
  const topK = Math.max(requestedTopK, minTopK);              ← line 81: floor applied
  ...
  function matchesFilter(hit, filter): boolean {
    return Object.entries(filter).every(([key, value]) =>
      !(key in hit.meta) || hit.meta[key] === value);         ← line 105: absent key
  }                                                              ignored, not excluding
        │
        └─ a weak model that asks for top_k: 1 still gets minTopK results;
           a hallucinated filter key {textContains:"x"} matches every chunk
           (because no chunk HAS that key) instead of wiping the result set.
           Both turn a likely model mistake into a non-event.
```

**Gemma's emulation —
`packages/providers/gemma/src/gemma-provider.ts:52-92, 133-165`:**

```
  async complete(request): Promise<ModelResponse> {
    const wantsTool = Boolean(request.tools?.length);
    const maxAttempts = wantsTool ? this.maxToolCallAttempts : 1;  ← retry budget
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const messages = attempt === 0 ? base : [...base, RETRY_NUDGE];  ← corrective nudge
      const raw = (await this.chat(...)).message?.content ?? '';
      if (wantsTool) {
        const call = parseToolCall(raw);                       ← messy text → tool_use
        if (call) return this.toResponse([{ type: 'tool_use', ... }], ...);
        if (looksLikeToolAttempt(raw)) continue;               ← only retry botched JSON
      }
      break;
    }
    return this.toResponse([{ type: 'text', text: raw }], ...);  ← plain prose = real answer
  }
        │
        └─ buildSystemText (line 133) renders the tools INTO the prompt because
           Gemma has no native tools array. The whole emulation lives below the
           ModelProvider seam — runAgentLoop never knows the tools weren't native.
```

---

## Elaborate

This is the **Port/Adapter** (hexagonal) pattern again, the same one `01` walks
for `ModelProvider` — which is the point. The reusable lesson isn't "retrieval
needs an interface"; it's that a codebase with a *house style* for swappable
dependencies (narrow contract, vendor in the adapter, identity as an opaque
field) gets cheaper to extend every time it reuses that style. A reader who
learned `ModelProvider` in `01` can read all of `@aptkit/retrieval` in five
minutes because the shape is identical.

The one genuinely new idea here over `01` is the **shared-fact invariant**.
`ModelProvider` has no equivalent of `dimension` — no number two adapters must
agree on. Retrieval does, and the design promotes that number to a visible field
and checks it at wiring time. That's APOSD's information-leakage chapter answered
constructively: when knowledge *must* live in two modules, don't pretend it
doesn't — surface it and validate the agreement at the cheapest point.

Adjacent reading: the `search_knowledge_base` robustness work is the same
*pull-complexity-downward* instinct the runtime defaults show (audit Lens 5,
`runAgentLoop`'s `maxTurns`/`maxTokens` defaults) — pushed to a tool boundary
because the caller here is an unreliable model, not a programmer. And the chunker
(`chunker.ts`) is a small deep module of its own: fixed-size char windows with
overlap, hidden behind `chunkText(text)`, with a documented reason (deterministic,
tokenizer-free) and an explicit "a smarter splitter is a later drop-in; the
contracts above it don't change."

---

## Interview defense

**Q: "You already have `ModelProvider` as your deep module. Why is retrieval a
separate pattern and not just 'more of the same'?"**

Because it composes the move twice and adds a constraint `ModelProvider` doesn't
have. The pipeline sits between *two* independently-swappable contracts at once,
and those two contracts share a fact — the embedding dimension — that has to
agree or ranking silently breaks. `ModelProvider` has no shared-fact problem; a
single adapter answers a single call. Retrieval's design decision is what to do
with that shared fact: promote it to a visible field on both contracts and check
it at wiring time, so a mismatch is a loud config error, not a quiet
wrong-answer bug.

```
  one contract (01)          two contracts + a shared fact (here)
  ┌────────────┐             ┌────────────┐     ┌────────────┐
  │ Model      │             │ Embedding  │ ◄─► │ VectorStore│
  │ Provider   │             │ dimension ─┼─────┼─ dimension │
  └────────────┘             └────────────┘  must agree
   no agreement needed        assertWiring checks it, loudly, at config time
```

**Anchor:** "Two narrow contracts, one shared `dimension` they must agree on, and
the pipeline fails loud at wiring time instead of returning silently-wrong
rankings — that's the leak turned into a guard."

**Q: "The search tool ignores filter keys a chunk doesn't have. Isn't that
wrong — shouldn't a filter exclude non-matching chunks?"**

It's deliberate, and it's the robustness principle. The caller is a model, often a
weak local one, that hallucinates filter keys. If an absent key *excluded* chunks,
a single made-up `{textContains: "x"}` would wipe every result to zero — a
silent retrieval failure that looks like an empty knowledge base. By ignoring keys
no chunk has, a hallucinated filter degrades to a no-op instead of a wipe. Same
instinct as the `minTopK` floor: assume the caller is weak, and pull the
defense down into the tool so no prompt has to coach around it. The honest cost:
a *legitimate* filter key that's simply misspelled also silently no-ops rather
than erroring — acceptable when the alternative is zero results from a confident
model.

---

## Validate

1. **Reconstruct:** write `EmbeddingProvider` and `VectorStore` from memory. Three
   members each; one shared field. Check against
   `packages/retrieval/src/contracts.ts:22`.
2. **Explain:** why does `assertWiring` run at `createRetrievalPipeline` time
   *and* the store re-check on every vector? What bug does each catch that the
   other misses? (`pipeline.ts:22`, `in-memory-vector-store.ts:36`.)
3. **Apply:** you swap `InMemoryVectorStore` for buffr's `PgVectorStore`. Which
   files in *this* repo change? (Answer: none in `@aptkit/retrieval` — the store
   is constructor-injected behind the contract; only the wiring at the app edge
   changes.)
4. **Defend:** a teammate wants the `search_knowledge_base` filter to *strictly*
   exclude on any unmatched key. Argue both sides, then pick — strict matching is
   correct for a trusted caller, but the caller here is a model, so the
   absent-key-tolerant version (`search-knowledge-base-tool.ts:105`) trades
   strictness for not letting a hallucinated key zero out retrieval.

---

## See also

- `01-model-provider-deep-module.md` — the original deep-module move this file
  reuses; read it first.
- `02-provider-decorator-stack.md` — the wrappers over `ModelProvider`; Gemma is
  a *peer adapter* to those, with an unusually large emulation body.
- `05-bundle-as-public-surface.md` — `@aptkit/retrieval` and `@aptkit/provider-gemma`
  are now both re-exported by `@rlynjb/aptkit-core`, so these contracts joined the
  public surface.
- `audit.md` Lens 2 (deep modules), Lens 5 (pull complexity downward — the
  minTopK floor and runtime defaults), Lens 6 (errors — the dimension fail-loud).
- `.aipe/study-ai-engineering/` and `.aipe/study-system-design/` — the RAG
  pipeline as an AI mechanic and as an architecture seam (different altitudes).
- APOSD ch. 4 (deep modules), ch. 5 (information hiding — the shared-fact leak),
  ch. 10 (define errors out — inverted here into fail-loud).
