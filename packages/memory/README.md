# @aptkit/memory

Long-term, retrieval-based **episodic memory** for agents: store conversation
exchanges, recall the relevant ones by semantic similarity. (RAG over
conversation history.)

Built on the `@aptkit/retrieval` contracts — it speaks only `EmbeddingProvider`
and `VectorStore`, so it never names a database. Inject a `PgVectorStore` for
durable memory or an `InMemoryVectorStore` for tests; the logic is identical.

```ts
import { createConversationMemory, createMemoryTool } from '@aptkit/memory';

const memory = createConversationMemory({ embedder, store });

// after each turn:
await memory.remember({ conversationId, question, answer });

// later (or next session):
const past = await memory.recall('which editor do I prefer', 3);

// or let an agent recall explicitly:
const { definition, handler } = createMemoryTool(memory);
```

**Store sharing.** Memory rows are tagged `kind=memory`. Point `store` at the
same store your documents use (memory mixes in and surfaces via
`search_knowledge_base`) or a dedicated store (isolated; recall via the
`search_memory` tool). `recall()` filters to memory rows either way.

**Scope.** This is the storage + retrieval half. Memory *management* —
summarization, fact extraction, consolidation, decay — is intentionally out of
scope and layered on top.
