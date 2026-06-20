# Embedding Batch and Top-K Floor

*Industry names: request batching / amortized round-trip, retrieval depth
floor. Type: Industry standard (batching) + Project-specific (the minTopK
guard).*

## Zoom out, then zoom in

Two small perf controls sit on either end of the retrieval pipeline. On the
**index side**, embedding many chunks of one document is a *single* HTTP
call to Ollama, not one call per chunk — round-trips are amortized. On the
**query side**, a `minTopK` floor stops a weak local model from starving
its own retrieval by asking for `top_k: 1`. The first is a throughput win;
the second is a quality/cost tradeoff found live (Gemma self-selected
`top_k: 1` and missed half of a multi-part question).

```
  Zoom out — the two controls bracket the pipeline

  ┌─ Index side ────────────────────────────────────────────┐
  │  indexDocument → chunkText → ★ embed(ALL chunks) ★        │ ← one HTTP call
  │                              one round-trip, not N        │   for N chunks
  └────────────────────────────┬─────────────────────────────┘
                               │   vectors → store.upsert
  ┌─ Query side ───────────────▼─────────────────────────────┐
  │  search_knowledge_base → ★ topK = max(asked, minTopK) ★   │ ← floor the
  │  → pipeline.query → linear scan (see 07)                  │   retrieval depth
  └──────────────────────────────────────────────────────────┘
```

Zoom in: batching is `OllamaEmbeddingProvider.embed(texts[])` taking an
*array* and POSTing it once. The floor is one `Math.max(requestedTopK,
minTopK)` in the tool handler. Both are cheap lines with outsized effect on
the system's cost and answer quality.

## The structure pass

**Layers:** index path (chunk → embed → upsert) and query path (embed query
→ scan → floor top-k). Two ends of one pipeline.

**Axis — round-trips and retrieved-chunk count per operation.** Hold it
constant and watch where each control bites.

```
  Axis = "round-trips / chunks fetched" — two seams, two controls

  index seam:                          query seam:
  ┌─ N chunks ─┐  embed   ┌─ Ollama ─┐ ┌─ model asks ─┐ floor ┌─ scan ──┐
  │ chunk[0..N]│ ══════►  │ 1 POST   │ │ top_k: 1     │ ════► │ fetch 4 │
  │            │ (batched)│ N vectors│ │ (starves)    │(floor)│ (honest)│
  └────────────┘          └──────────┘ └──────────────┘       └─────────┘
       │ control: batch                     │ control: minTopK
       └─ amortize the HTTP round-trip       └─ defend answer completeness
```

The **index seam** is `embed(texts[])` — the contract takes an array, so
batching is the natural shape, not an optimization bolted on. The **query
seam** is the tool handler's `top_k` resolution — where a model-chosen
value gets floored before it reaches the scan.

## How it works

### Move 1 — the mental model

Batching is the same instinct as a SQL `IN (...)` instead of N separate
`SELECT`s, or a single `fetch` with a batched payload instead of N fetches
in a loop: one round-trip carrying many items beats many round-trips
carrying one each. The floor is a `Math.max` clamp — the mirror of the
`Math.min` you'd use to cap a page size, except it raises a too-small value
instead of lowering a too-large one.

```
  The two kernels

  BATCH (index side):                FLOOR (query side):
  embed([c0, c1, ..., cN])           topK = max(requestedTopK, minTopK)
       │  one POST                          │
       ▼                                    ▼
  [v0, v1, ..., vN]                   never fetch fewer than minTopK,
  N vectors, 1 round-trip             no matter what the model asked
```

### Move 2 — the walkthrough

**Batched embedding — one call for a whole document.** Bridge from a
`Promise.all` you'd reach for to parallelize N fetches: batching is better
still — it's *one* request, so there's one round-trip latency and one set
of HTTP/TLS overhead, not N. `indexDocument` chunks the doc into an array,
then hands the *entire array* to `embed` in a single call. The Ollama
`/api/embed` endpoint takes `input: texts[]` and returns
`embeddings: number[][]` — N vectors from one POST.

```
  indexDocument — chunk once, embed once

  texts = chunkText(doc.text)        ← e.g. a 3000-char doc → ~6 chunks
  vectors = await embed(texts)       ← ONE POST, returns 6 vectors
                                        (not 6 POSTs)
  chunks = texts.map((t, i) => ({ id: `${doc.id}#${i}`, vector: vectors[i], ... }))
  store.upsert(chunks)
```

The boundary that bites: the response array is positional — `vectors[i]`
must line up with `texts[i]`. The code relies on Ollama returning
embeddings in input order (it does). If a future transport reordered or
dropped one, the `vectors[i]!` non-null assertion would silently mis-pair a
chunk with the wrong vector — a correctness bug disguised as a perf
shortcut. Worth knowing the assumption is load-bearing.

**The top-k floor — defending retrieval depth from the model.** Here's the
live finding. A strong model picks a sensible `top_k`. Gemma, running
locally, self-selected `top_k: 1` — it retrieved one chunk and confidently
answered half of a two-part question ("what do I use for embeddings, *and*
how do I take my coffee"), missing the second half entirely because the one
chunk it fetched only covered the first. The fix isn't to fight the model's
JSON; it's to floor the value it asks for.

```
  Floor the model's top_k — query handler

  requestedTopK = (args.top_k > 0) ? args.top_k : defaultTopK   ← 5 default
  topK = max(requestedTopK, minTopK)        ← minTopK=4 in ask.ts
                                               so top_k:1 → fetched 4
  hits = await pipeline.query(query, fetchK)

  trade: a few extra chunks scanned + a few more tokens in context,
         bought: the second half of the answer stops going missing
```

The cost of the floor is real and small: you scan and return up to
`minTopK` chunks even when the model wanted one, so the linear scan does the
same O(n) work (it scans all n regardless) but *returns* more, and those
extra chunks become extra input tokens on the next model turn. The benefit
is answer completeness. That's the tradeoff, named: **a few extra retrieved
chunks and tokens, in exchange for not letting a weak model starve its own
context.** `minTopK` defaults to 1 (no floor); `ask.ts` sets it to 4.

**The filter over-fetch — a second, related depth control.** When a
metadata filter is present, the handler over-fetches `topK * 4` before
filtering down to `topK` (`search-knowledge-base-tool.ts:88`), so the
post-filter can still return a full page. Same family of move: fetch a bit
more up front so a downstream narrowing doesn't leave you short.

### Move 3 — the principle

Two principles, one per control. **Batching:** amortize the fixed cost of a
round-trip across many items — the win scales with how many items share the
trip. **The floor:** when a model controls a perf/quality knob (here,
retrieval depth), don't trust it to pick well — clamp it to a floor that
defends the outcome you care about. A weak model will under-fetch to look
decisive; the floor makes its laziness harmless.

## Implementation in codebase

**Use cases.** Batching runs on every `pipeline.index(doc)` —
`indexDocument` embeds all of a document's chunks at once. The floor runs on
every `search_knowledge_base` call when `minTopK > 1` is configured;
`ask.ts` sets `minTopK: 4` precisely because of the live Gemma under-fetch.

```
  packages/retrieval/src/ollama-embedding-provider.ts  (lines 50–57)

  async embed(texts: string[], options?): Promise<number[][]> {
    options?.signal?.throwIfAborted();
    return this.embedTransport({ model, texts, ... });   ← texts[] in, one call
  }
  // defaultHttpTransport (lines 62–74):
  body: JSON.stringify({ model, input: payload.texts })  ← Ollama takes the
  return json.embeddings ?? [];                             whole array; returns
                                                            embeddings[] back
       │
       └─ `texts` is an ARRAY and the POST sends it whole — N chunks, 1
          round-trip. The pipeline (indexDocument:40) passes every chunk of
          a doc at once, so a 6-chunk doc costs one embed call, not six.
```

```
  packages/retrieval/src/pipeline.ts  (lines 37–47)

  const texts = chunkText(doc.text);          ← N chunks
  const vectors = await wiring.embedder.embed(texts);   ← ONE batched call
  const chunks = texts.map((text, i) => ({
    id: `${doc.id}#${i}`, vector: vectors[i]!, ...       ← positional pairing:
  }));                                                     vectors[i] ↔ texts[i]
       │
       └─ the `vectors[i]!` assertion assumes the embed response preserves
          input order. Load-bearing: a reorder would mis-pair vectors.
```

```
  packages/retrieval/src/search-knowledge-base-tool.ts  (lines 51, 80–89)

  const minTopK = Math.max(1, options.minTopK ?? 1);     ← floor (default 1 = off)
  ...
  const requestedTopK = (args.top_k > 0) ? args.top_k : defaultTopK;
  const topK = Math.max(requestedTopK, minTopK);         ← clamp UP to the floor
  const fetchK = filter ? topK * 4 : topK;               ← over-fetch when filtering
  let hits = await pipeline.query(query, fetchK);
       │
       └─ `Math.max(requestedTopK, minTopK)` is the live fix: Gemma asked
          top_k:1, the floor of 4 (ask.ts) kept retrieval from starving the
          multi-part answer. Cost: a few more chunks → a few more tokens.
```

A single live observation worth recording, not a benchmark: in one observed
`ask.ts` run a Gemma tool-call turn took roughly 7 seconds locally. Treat
that as an anecdote about local-inference latency on this machine, not a
measured number — there's no benchmark harness, no percentile, no repeated
sampling. It's the order-of-magnitude reminder that the **model turn, not
the embed call or the scan, dominates wall-clock** in this pipeline (the
embed call and the O(n) scan over a 3-doc corpus are sub-millisecond next to
a multi-second local Gemma turn).

## Elaborate

Batching is the universal latency amortization move — it shows up as
GraphQL query batching, DataLoader, SQL multi-row inserts, and provider
*batch APIs* (OpenAI's `/v1/batch`, Anthropic's Message Batches) that trade
latency for throughput and a discount. AptKit batches at the embedding
layer but **not** at the model layer — each agent turn is still one
`complete()` call (see audit lens 6). The top-k floor is a specific case of
a general agent-design lesson: when you hand a model control over a
resource knob (retrieval depth, max tokens, tool budget), bound it in code
rather than trusting the model's self-selected value — the same instinct
behind `maxTurns`/`maxToolCalls` in **01-turn-and-tool-budget.md**.

## Interview defense

**Q: Why batch the embeddings instead of embedding each chunk as you go?**

One round-trip amortizes the fixed HTTP/TLS/inference-setup cost across all
N chunks of a document. The `embed` contract takes an array precisely so
batching is the default shape, not a bolt-on. A 6-chunk doc costs one POST,
not six.

```
  6 chunks, 6 POSTs   ──►   6 chunks, 1 POST
  6× round-trip cost        1× round-trip cost
```

Anchor: *amortize the fixed round-trip cost across the batch.*

**Q: What's the minTopK floor for — isn't top_k the model's call?**

It's a guard against a weak local model starving its own retrieval. Live:
Gemma self-selected `top_k: 1` and missed half a two-part question. The
floor (`Math.max(requestedTopK, minTopK)`) clamps the depth up so retrieval
stays honest regardless of what the model asks. The cost is a few extra
chunks and tokens; the buy is answer completeness.

Anchor: *when the model controls a perf/quality knob, floor it in code —
don't trust it to under-fetch responsibly.*

## Validate

1. **Reconstruct:** write the two kernels from memory — `embed(texts[])` as
   one round-trip, and `topK = max(requested, minTopK)`. Check against
   `ollama-embedding-provider.ts:50-57` and
   `search-knowledge-base-tool.ts:80-81`.
2. **Explain:** why is `vectors[i]!` in `pipeline.ts:43` load-bearing, and
   what assumption does it make about the batched response?
3. **Apply:** a 50-doc corpus, each doc ~10 chunks. How many embed
   round-trips does indexing cost, and why? (50 — one per `pipeline.index`
   call; chunks within a doc are batched.)
4. **Defend:** the model asked `top_k: 1` and the answer is incomplete. Two
   fixes are on the table — prompt-engineer the model to ask for more, or
   floor it in code. Which, and why? (Floor it: deterministic, doesn't fight
   the model's JSON, can't regress under a model swap.)

## See also

- **07-linear-vector-scan.md** — the scan that consumes the batched vectors
  on index and returns the floored top-k on query.
- **01-turn-and-tool-budget.md** — the same "bound a model-controlled knob
  in code" instinct, applied to turns and tool calls.
- **02-token-cost-ledger.md** — where the extra tokens the floor admits show
  up in the spend.
- **audit.md** lens 6 (caching-batching-and-backpressure) — batching is
  exercised at the embed layer, not the model layer.
