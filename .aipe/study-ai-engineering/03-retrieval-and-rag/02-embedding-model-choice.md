# Embedding model choice — the one-way door

**Industry names:** embedding model selection, embedder choice, vectorizer
selection · *Industry standard*

## Zoom out, then zoom in

Picking an embedding model looks like a config line — `model: 'nomic-embed-text'`
— but it's the single most expensive decision in the retrieval layer to reverse.
Every chunk you index gets frozen into *that model's* coordinate system. Switch
models later and the old vectors are dead weight: you re-embed the entire corpus.
AptKit makes the choice in one constructor, `OllamaEmbeddingProvider`, and then
*enforces* the consequence in `assertWiring` — pair a 768-dim embedder with a
non-768 store and the pipeline throws at construction, not in production.

```
  Zoom out — where the model choice lands in AptKit (packages/retrieval)

  ┌─ The choice: pick ONE embedder, freeze its dimension ─────────────┐
  │  ★ OllamaEmbeddingProvider  id='nomic-embed-text'  dimension=768   │
  │       │                                  ←── THIS CONCEPT          │
  │       ▼  embed(texts) → number[][]  (every vector is 768 long)     │
  └───────┬───────────────────────────────────────────────────────────┘
          │  768-dim vectors
  ┌─ The enforcement: assertWiring (pipeline.ts:22-29) ▼──────────────┐
  │  embedder.dimension === store.dimension  ?  proceed  :  THROW     │
  └───────┬───────────────────────────────────────────────────────────┘
          │  validated wiring
  ┌─ The store: InMemoryVectorStore(768) ▼────────────────────────────┐
  │  holds 768-dim vectors only — assertDimension rejects any other    │
  └────────────────────────────────────────────────────────────────────┘
```

Zoom in: an **embedding model** is the function that decides *what direction
in space* each piece of text points. Two different models — nomic and OpenAI
`text-embedding-3-small` — produce vectors of different length (768 vs 1536) and,
even where lengths happen to match, different *meanings per axis*. There is no
translation between them. You ran the cloud branch of this decision in AdvntrCue:
OpenAI `text-embedding-3`, 1536-dim, hosted. AptKit takes the local branch: nomic,
768-dim, served by Ollama on your own machine. Same decision, opposite default —
and the reason AptKit chose local is the same reason it runs Gemma locally:
privacy, no API key, no per-call cost, no cloud dependency.

## Structure pass

**Layers.** Two stacked decisions. The *capability* layer (which model can even
represent your text well — English vs multilingual vs code vs domain jargon) sits
above the *operational* layer (hosted vs local: latency, cost, privacy, key
management). You pick a model only after both layers agree.

**Axis — what does switching cost?** Trace the single question *what happens if I
change my mind?* down the stack. At the config layer it's a one-line edit. At the
vector layer it's a full re-embed of every chunk you've ever indexed. At the data
layer it's a migration with downtime if the corpus is large. The cost grows by
orders of magnitude the lower you go — that's what "one-way door" means.

**Seam.** The load-bearing seam is the `dimension` field on `EmbeddingProvider`.
It is the single number that has to agree on both sides of the index/query
boundary. AptKit promotes that agreement from "hope the dev got it right" to a
hard runtime invariant: `assertWiring` reads `embedder.dimension` and
`store.dimension` and refuses to build a mismatched pipeline.

## How it works

You already know reversible vs irreversible decisions in code: renaming a local
variable is reversible; changing a public API's wire format is not. Embedding
model choice is the second kind. The model defines the coordinate system, and the
coordinate system is baked into every stored vector — so reversing means
rewriting all the data.

### Move 1 — the mental model

The shape: the model is a coordinate-system author. Pick it once, and every vector
you ever store is written in that system's axes and length. Switching authors
means re-translating every document — which, because there's no translator, means
re-embedding from the original text.

```
  Embedding model choice — the model authors the coordinate system

  text ──► [ nomic ]      ──► 768-dim vector in nomic's space   ●
  text ──► [ OpenAI-3-sm ]──► 1536-dim vector in OpenAI's space ●  (no overlap)
  text ──► [ Voyage code2 ]► 1536-dim vector in Voyage's space  ●  (also no overlap)

       │                                   │
       └─ same input text ────────────────┘
          three models → three INCOMPATIBLE spaces
          a vector from one cannot be compared to a vector from another
```

The brain to hold: vectors are only comparable *within one model's output*. Cross
the model boundary and cosine similarity returns numbers, but they mean nothing.

### Move 2 — the step-by-step walkthrough

**Step 1 — match the model to the text (capability layer).** Run the decision
tree before you touch operational concerns. English/general text with hosted-OK
constraints → OpenAI `text-embedding-3-small`. Multilingual or heavy domain
jargon → Cohere multilingual or a BGE model. Privacy or on-device requirement →
local: nomic-embed-text or sentence-transformers. Code retrieval → a code-tuned
embedder like OpenAI `text-embedding-3-large` or Voyage `code-2`.

```
  Step 1 — the decision tree (capability first)

  what are you embedding?
       │
       ├─ English / general, hosted OK ──────► OpenAI text-embedding-3-small (1536)
       ├─ multilingual / domain jargon ──────► Cohere multilingual / BGE
       ├─ privacy / on-device / no key ──────► local: nomic / sentence-transformers ★
       └─ code ──────────────────────────────► text-embedding-3-large / Voyage code-2

  ★ AptKit lands here: local, no cloud, no key — same reason Gemma is local
```

The boundary that bites: there is no single "best" embedder. The right one is a
function of *your* text and *your* operational constraints, not a leaderboard.

**Step 2 — commit the dimension, declare it, don't infer it.** Once you pick
nomic, the dimension is 768 and it's fixed. AptKit *declares* it as a literal
(`readonly dimension = 768`) rather than reading it from the first response — so
the wiring check can run at construction, before a single document is indexed,
instead of discovering the mismatch on the first query.

```
  Step 2 — declare the dimension so it's checkable before indexing

  OllamaEmbeddingProvider                InMemoryVectorStore
  ┌────────────────────────┐             ┌────────────────────────┐
  │ id = 'nomic-embed-text'│             │ dimension = 768        │
  │ dimension = 768  ◄─────┼─────────────┼─► must match           │
  └───────────┬────────────┘             └───────────┬────────────┘
              │                                       │
              └────────────► assertWiring ◄───────────┘
                             768 === 768  →  build the pipeline
```

The boundary: the dimension is data, declared up front. That's what lets the
mismatch be a *wiring-time* error instead of a *runtime* corruption.

**Step 3 — let the door slam if you mix.** Wire a 1536-dim embedder to the
768-dim store and `assertWiring` throws immediately with a message that names
both sides and tells you the fix: re-index the corpus with a matching provider.
The one-way door is not a comment in a design doc — it's an executable invariant.

```
  Step 3 — the one-way door, enforced (pipeline.ts:22-29)

  createRetrievalPipeline({ embedder: OpenAI(1536), store: InMemory(768) })
       │
       ▼  assertWiring
   embedder.dimension (1536)  !==  store.dimension (768)
       │
       ▼
   THROW "dimension mismatch: embedder "..." is 1536-dim but store is
          768-dim — re-index the corpus with a matching provider"
       │
       └──► pipeline never constructs → no silently-unsearchable vectors
```

### Move 3 — the principle

An embedding model is an irreversible commitment to a coordinate system, and the
only sound way to handle an irreversible commitment is to make its constraint
explicit and machine-checked at the earliest possible moment. AptKit does both:
it declares the dimension as data and asserts the wiring at construction. The
lesson generalizes past embeddings — when a decision is a one-way door, encode
the door in code so no one can walk back through it by accident.

## Primary diagram

The whole decision and its enforcement in one frame: choose, declare, check, and
the cost of reversing.

```
  Embedding model choice end to end — choose, declare, enforce

  CHOOSE (once)                          ENFORCE (every wiring)
  ┌──────────────────────┐               ┌──────────────────────┐
  │ decision tree:       │               │ assertWiring:        │
  │  text + constraints  │               │  embedder.dimension  │
  │  → nomic (local,768) │               │   === store.dimension│
  └──────────┬───────────┘               └──────────┬───────────┘
             │ declare dimension = 768               │ match? → build
             ▼                                       ▼ mismatch? → THROW
  ┌────────────────────────────────────────────────────────────┐
  │  REVERSING THE CHOICE (the one-way door):                   │
  │   change model → new dimension/space → every stored vector  │
  │   is dead → re-embed the ENTIRE corpus from source text     │
  └────────────────────────────────────────────────────────────┘
                              │
                              ▼  this is why you pick deliberately, once
```

## Implementation in codebase

**Use cases.** The `rag-query` agent picks one embedder — `OllamaEmbeddingProvider`
(nomic, 768) — at startup and uses it for *both* index-time and query-time, so the
two sides share a coordinate system by construction. A future hosted variant (an
`OpenAIEmbeddingProvider` at 1536) would be a sibling adapter; the moment you try
to wire it to the existing 768 store, the pipeline refuses to build — making the
"don't mix models" rule impossible to violate by accident.

**The choice, declared**, `packages/retrieval/src/ollama-embedding-provider.ts:38-58`:

```
  packages/retrieval/src/ollama-embedding-provider.ts  (lines 38-58)

  export class OllamaEmbeddingProvider implements EmbeddingProvider {
    readonly id = 'nomic-embed-text';
    readonly dimension = 768;            ← the choice, frozen as a literal
    private readonly model: string;
    ...
    constructor(options = {}) {
      this.model = options.model ?? 'nomic-embed-text';   ← model default
      this.embedTransport =
        options.embed ?? defaultHttpTransport(            ← injectable: tests
          options.host ?? 'http://localhost:11434');     ←   need NO live Ollama
    }
    async embed(texts, options) {
      options?.signal?.throwIfAborted();                  ← cancel before work
      return this.embedTransport({ model: this.model, texts, ... });
    }
  }
       │
       └─ dimension is DECLARED, not inferred from a response. That's the whole
          trick: it's known before any text is embedded, so the wiring check can
          run at construction. Local-first by default — host points at localhost,
          no key, no cloud — the same posture as the local Gemma model.
```

**The enforcement**, `packages/retrieval/src/pipeline.ts:22-29` — the one-way door
as an executable invariant:

```
  packages/retrieval/src/pipeline.ts  (lines 22-29)

  function assertWiring(wiring: RetrievalWiring): void {
    if (wiring.embedder.dimension !== wiring.store.dimension) {
      throw new Error(
        `dimension mismatch: embedder "${wiring.embedder.id}" is `
        + `${wiring.embedder.dimension}-dim but store is `
        + `${wiring.store.dimension}-dim — re-index the corpus with a `
        + `matching provider`,                 ← the message names the fix
      );
    }
  }
       │
       └─ createRetrievalPipeline calls this at construction (pipeline.ts:74), and
          indexDocument/queryKnowledgeBase call it again on every operation. You
          cannot index unsearchable vectors — the pipeline won't exist if the
          dimensions disagree.
```

## Elaborate

Why is there no translator between embedding spaces? Because each model learns its
axes from scratch during training. Dimension 42 of nomic and dimension 42 of
OpenAI are not "the same feature measured differently" — they're unrelated
learned directions. Even two models with the *same* output length (1536) are
incompatible; matching dimension is necessary but nowhere near sufficient. That's
why AptKit's `assertWiring` only checks dimension: a length match is the *minimum*
bar, and mixing same-length-but-different-model vectors is a bug the dimension
check can't catch — so the discipline of "one embedder for both sides" matters
even where the assert stays quiet.

The hosted-vs-local split is an operational decision layered on top of capability.
Hosted (OpenAI, Cohere, Voyage) buys you stronger general-purpose quality and zero
infra, at the cost of a per-call price, a network hop, an API key to manage, and
your text leaving the machine. Local (nomic, sentence-transformers via Ollama)
buys privacy, zero marginal cost, and offline operation, at the cost of running
the model yourself and generally lower benchmark scores. AptKit picks local
because its whole thesis is "the full pipeline runs on your laptop with no cloud" —
the embedder choice has to match the model choice (local Gemma) or the thesis
leaks.

Adjacent concepts: embeddings ([01-embeddings.md](01-embeddings.md)) is *what* a
vector is; this file is *which* model produces it; vector databases
([04-vector-databases.md](04-vector-databases.md)) is *where* the chosen model's
vectors live and how the same `dimension` seam guards the store.

## Project exercises

*Provenance: Phase 2A — Retrieval foundations (C2.x). No `aieng-curriculum.md`
present; IDs are by-phase convention. **Case A — the choice and its enforcement
already ship (`OllamaEmbeddingProvider` declares `dimension=768`; `assertWiring`
throws on mismatch); these exercises make the one-way door executable.***

### Exercise — add a hosted embedder and trigger the door

- **Exercise ID:** `[B2A.3]` Phase 2A, embedding-model-choice concept
- **What to build:** A second `EmbeddingProvider` —
  `OpenAIEmbeddingProvider` (`text-embedding-3-small`, `dimension = 1536`) behind
  the same transport-injectable shape as `OllamaEmbeddingProvider` (so tests need
  no live API). Then write a test that wires it to the existing 768-dim
  `InMemoryVectorStore` and asserts `createRetrievalPipeline` throws the
  dimension-mismatch error.
- **Why it earns its place:** It proves the embedder is an adapter exactly like
  `ModelProvider`, and it turns the one-way-door *concept* into a passing test —
  the mismatch throw fires on purpose, with the real message from `pipeline.ts:24`.
- **Files to touch:** `packages/retrieval/src/openai-embedding-provider.ts`,
  `packages/retrieval/test/openai-embedding-provider.test.ts`.
- **Done when:** One test proves the new provider satisfies the
  `{ id, dimension, embed() }` contract with an injected transport; a second proves
  `createRetrievalPipeline({ embedder: OpenAI(1536), store: InMemory(768) })`
  throws, and a third proves the same OpenAI embedder wired to an
  `InMemoryVectorStore(1536)` builds cleanly.
- **Estimated effort:** `1–4hr`

### Exercise — make the decision tree a config-driven factory

- **Exercise ID:** `[B2A.4]` Phase 2A, embedding-model-choice (selection logic)
- **What to build:** A `selectEmbedder({ text, hostedOk, privacy, code })` factory
  that returns the right `EmbeddingProvider` per the decision tree (local nomic for
  privacy; hosted OpenAI for general English; etc.), and pairs it with a store of
  the matching dimension so `assertWiring` always passes for a correct selection.
- **Why it earns its place:** It encodes the capability/operational decision tree
  as code instead of tribal knowledge, and forces you to keep embedder dimension
  and store dimension in lockstep — the seam this whole file is about.
- **Files to touch:** `packages/retrieval/src/select-embedder.ts`,
  `packages/retrieval/test/select-embedder.test.ts`.
- **Done when:** A table-driven test maps each constraint combination to the
  expected provider id and dimension, and proves the returned wiring never throws
  in `assertWiring`.
- **Estimated effort:** `1–4hr`

## Interview defense

**Q: Why is choosing an embedding model a "one-way door," and how do you keep that
mistake from reaching production?**

```
  pick model ──► dimension + coordinate space frozen into every vector
       │
       ▼  change model later
   old 768-dim vectors  ✗  cannot be compared to new 1536-dim vectors
       │
       ▼
   re-embed the ENTIRE corpus from source text   ← the cost of reversing
       │
   guard: assertWiring throws at construction on dimension mismatch
```

"Picking the embedder fixes the dimension and the coordinate system for every
vector you ever store. There's no translator between two models' spaces — even
matching lengths don't make them comparable. So switching means re-embedding the
whole corpus from the original text, which is a migration, not a config change. I
keep the mistake out of production by declaring the dimension as data and checking
it at wiring time: in AptKit, `assertWiring` in `pipeline.ts:22-29` throws at
construction if the embedder and store disagree, so you can't index vectors the
store can never search."
*Anchor: the model authors the coordinate system; reversing means re-embedding
everything; the dimension check makes that constraint executable.*

**Q: AptKit uses local nomic instead of hosted OpenAI. Defend the choice.**
"It's an operational decision layered on capability. AptKit's thesis is that the
whole pipeline runs locally with no cloud — Gemma for generation, nomic for
embeddings. Local nomic gives privacy, zero per-call cost, no API key, and offline
operation, which matches that thesis. Hosted OpenAI would score higher on general
benchmarks but breaks the no-cloud posture and adds a key plus a network hop. If
the requirement flips to top-end English quality with hosted-OK, the decision tree
sends you to `text-embedding-3-small` — and because the embedder is an adapter
behind the contract, swapping it is a one-file change plus a store at the matching
dimension."
*Anchor: capability picks the family, operations pick hosted-vs-local; AptKit's
no-cloud thesis forces local.*

## Validate

- **Reconstruct:** From memory, write the wiring guard:
  `if (embedder.dimension !== store.dimension) throw`. Check it against
  `pipeline.ts:22-29` — including that the message tells you to re-index with a
  matching provider.
- **Explain:** Why does `OllamaEmbeddingProvider` *declare* `dimension = 768` as a
  literal instead of reading it from the first embed response? (So the value is
  known before any text is embedded, which lets `assertWiring` run at construction
  — `pipeline.ts:74` — instead of failing on the first query. See the literal at
  `ollama-embedding-provider.ts:40`.)
- **Apply:** A teammate swaps `nomic-embed-text` for OpenAI `text-embedding-3-small`
  by editing one line but leaves the corpus and store untouched. Searches return
  but ranking is nonsense. What happened, and what's the fix? (The store still
  holds old 768-dim nomic vectors; if the store dimension wasn't also changed,
  `assertWiring` throws — the intended outcome. If they *also* bumped the store to
  1536 without re-indexing, vectors are mixed-model and meaningless. Fix: re-embed
  the whole corpus with the new model into a fresh 1536 store.)
- **Defend:** `assertWiring` only checks `dimension` equality, yet two
  *different* models can both be 1536-dim. Why is the check still worth having, and
  where does it stop helping? (It catches the most common, cheapest-to-make
  mistake — a length mismatch — at construction time. It cannot catch
  same-length-different-model mixing; that's why the discipline "one embedder for
  both index and query" still matters beyond the assert. See the comment at
  `contracts.ts:21`.)

## See also

- [01-embeddings.md](01-embeddings.md) — what a vector is, before you choose who makes it
- [03-chunking-strategies.md](03-chunking-strategies.md) — what text you feed the chosen model
- [04-vector-databases.md](04-vector-databases.md) — where the chosen model's vectors live, behind the same dimension seam
- [11-rag.md](11-rag.md) — the full pipeline the chosen embedder feeds
