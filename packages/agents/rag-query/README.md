# @aptkit/agent-rag-query

The capstone (package E): a profile-aware RAG agent that proves packages A–D compose.

See `docs/personal-agent-packages.md`.

## What it wires

| Package | Role here |
| --- | --- |
| A `@aptkit/provider-gemma` | local model (wrap in `ContextWindowGuardedProvider`) |
| B `@aptkit/retrieval` | `search_knowledge_base` tool over an in-memory RAG pipeline |
| C `@aptkit/context` | `injectProfile` puts your `me.md` into the system prompt |
| D `@aptkit/evals` | `scorePrecisionAtK` measures retrieval quality |

The agent registers the retrieval tool, grants it via `filterToolsForPolicy`
(`ragQueryToolPolicy` — search only), and runs `runAgentLoop`: retrieve → ground
→ answer with citations.

## Example

```ts
import { RagQueryAgent } from '@aptkit/agent-rag-query';

const agent = new RagQueryAgent({
  model,        // a (guarded) GemmaModelProvider
  tools,        // InMemoryToolRegistry holding the search_knowledge_base tool
  profile,      // me.md text — injected into the system prompt
});

const answer = await agent.answer('What does the knowledge base say about X?');
```

## Live demo

Terminal, one shot, real Gemma + real nomic embeddings, zero cloud:

```
ollama pull gemma2:9b nomic-embed-text:v1.5
npm run ask -w @aptkit/agent-rag-query -- "your question"
```

No Supabase, no phone, no sync. Swapping `InMemoryVectorStore` for a future
`PgVectorStore` is the only change needed to graduate this to the shared data plane.
