# @aptkit/retrieval

A from-scratch, provider-agnostic RAG pipeline with swappable embedding and
vector-store adapters.

Package B of the personal-agent system — see `docs/personal-agent-packages.md`.
Nothing is ported from prior work; the design driver is **adaptability**: the
embedding vendor and the vector store are swappable adapters behind contracts,
the same way `ModelProvider` already has local/openai/anthropic side by side.

## The two contracts (the adaptability seam)

```ts
type EmbeddingProvider = { id: string; dimension: number; embed(texts: string[]): Promise<number[][]>; };
type VectorStore = {
  dimension: number;
  upsert(chunks: { id: string; vector: number[]; meta: Record<string, unknown> }[]): Promise<void>;
  search(vector: number[], k: number): Promise<{ id: string; score: number; meta: Record<string, unknown> }[]>;
};
```

## What it contains

- `InMemoryVectorStore` — cosine similarity over an in-memory array. Carries its
  own `dimension`; any vector of the wrong length (in `upsert` or `search`)
  throws a dimension-mismatch error — fail loudly.
- `OllamaEmbeddingProvider` — `nomic-embed-text`, 768-dim. Transport-injectable
  (pass `embed` to feed deterministic vectors in tests; the default uses `fetch`
  against `http://localhost:11434`), mirroring `@aptkit/provider-gemma`.
- Pipeline functions: `chunkText`, `indexDocument`, `queryKnowledgeBase`, and
  `createRetrievalPipeline` (which throws if embedder/store dimensions disagree).
- `createSearchKnowledgeBaseTool` — the `search_knowledge_base` tool wrapping the
  query path; registers into `InMemoryToolRegistry` and is selectable via
  `filterToolsForPolicy` (`@aptkit/tools`).

## Two paths

- **index:** `doc → chunk → embed → store.upsert`
- **query:** `query → embed → store.search → ranked chunks (score + meta)`

## Chunker strategy

Fixed-size character windows: `CHUNK_SIZE` ≈ 512 chars with `CHUNK_OVERLAP` = 64
chars carried between windows. Chosen because it is deterministic, vendor-neutral
(no tokenizer dependency), and trivially testable — the right default for the
from-scratch in-memory pipeline. ~512 chars stays comfortably inside
`nomic-embed-text`'s context while remaining granular enough to isolate a
relevant passage; the overlap keeps a fact that straddles a boundary from being
split across two chunks. A smarter semantic splitter is a later drop-in — the
contracts above it do not change.

## The dimension one-way door

Adapters make the *code* swappable any time, but a corpus embedded at nomic's 768
cannot be searched by a 1536-dim query. So the store carries its `dimension`, a
provider/store mismatch throws loudly at wiring time, and re-index is a
first-class operation. Adaptable interfaces, dimension-locked data.

## Example

```ts
import {
  InMemoryVectorStore,
  OllamaEmbeddingProvider,
  createRetrievalPipeline,
  createSearchKnowledgeBaseTool,
} from '@aptkit/retrieval';
import { InMemoryToolRegistry } from '@aptkit/tools';

const pipeline = createRetrievalPipeline({
  embedder: new OllamaEmbeddingProvider(), // nomic-embed-text @ localhost:11434
  store: new InMemoryVectorStore(768),
});

await pipeline.index({ id: 'notes', text: 'long markdown document...' });
const ranked = await pipeline.query('what did I decide about X?');

const { definition, handler } = createSearchKnowledgeBaseTool(pipeline);
const registry = new InMemoryToolRegistry([definition], { [definition.name]: handler });
```

## Prerequisites (for live embeddings)

```
ollama pull nomic-embed-text
```
