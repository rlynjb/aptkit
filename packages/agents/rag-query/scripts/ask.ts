/**
 * Capstone hand-test (package E): the whole stack, live, in the terminal.
 *
 *   A  GemmaModelProvider (guarded)        — local reasoning
 *   B  OllamaEmbeddingProvider + InMemory   — real RAG, zero cloud
 *   C  injectProfile                        — answers in your voice
 *
 * Requires Ollama running with `gemma2:9b` and `nomic-embed-text:v1.5` pulled.
 *
 *   npm run ask -w @aptkit/agent-rag-query           # default question
 *   npm run ask -w @aptkit/agent-rag-query -- "your question here"
 */

import {
  InMemoryVectorStore,
  OllamaEmbeddingProvider,
  createRetrievalPipeline,
  createSearchKnowledgeBaseTool,
} from '@aptkit/retrieval';
import { InMemoryToolRegistry } from '@aptkit/tools';
import { GemmaModelProvider } from '@aptkit/provider-gemma';
import { ContextWindowGuardedProvider } from '@aptkit/provider-local';
import type { CapabilityEvent } from '@aptkit/runtime';
import { RagQueryAgent } from '../src/index.js';

// A tiny personal corpus (stands in for your real markdown notes).
const CORPUS = [
  { id: 'notes/work', text: 'I work as a software engineer focused on AI agents and RAG systems. My main project is aptkit, a TypeScript agent toolkit.' },
  { id: 'notes/stack', text: 'My preferred stack is TypeScript, Node, and Supabase. I run local models with Ollama — Gemma2 for reasoning and nomic-embed-text for embeddings.' },
  { id: 'notes/coffee', text: 'I take my coffee as a flat white, oat milk, no sugar. I usually have one mid-morning around 10am.' },
];

const PROFILE = 'You are assisting Rein. Rein prefers terse, direct, technically precise answers with no filler.';

async function main(): Promise<void> {
  const question = process.argv.slice(2).join(' ') || 'What does Rein use for embeddings, and how does he take his coffee?';

  // B — real embeddings + in-memory store, wired and validated.
  const embedder = new OllamaEmbeddingProvider({ model: 'nomic-embed-text:v1.5' });
  const store = new InMemoryVectorStore(embedder.dimension);
  const pipeline = createRetrievalPipeline({ embedder, store });

  process.stdout.write(`Indexing ${CORPUS.length} documents...\n`);
  for (const doc of CORPUS) await pipeline.index(doc);

  // Floor top_k: Gemma tends to under-fetch (top_k: 1), starving multi-part
  // questions. minTopK keeps retrieval honest regardless of what the model asks.
  const tool = createSearchKnowledgeBaseTool(pipeline, { minTopK: 4 });
  const tools = new InMemoryToolRegistry([tool.definition], { [tool.definition.name]: tool.handler });

  // A — local Gemma, guarded against its ~8k context window.
  const model = new ContextWindowGuardedProvider(new GemmaModelProvider(), { maxTokens: 8192 });

  // Show the agent's work: every tool call and assistant step.
  const trace = {
    emit(event: CapabilityEvent): void {
      if (event.type === 'tool_call_start') {
        process.stdout.write(`  → tool: ${event.toolName}(${JSON.stringify(event.args)})\n`);
      } else if (event.type === 'tool_call_end') {
        const n = Array.isArray((event.result as { results?: unknown[] })?.results)
          ? (event.result as { results: unknown[] }).results.length
          : 0;
        process.stdout.write(`  ← retrieved ${n} chunks (${event.durationMs}ms)\n`);
      }
    },
  };

  const agent = new RagQueryAgent({ model, tools, profile: PROFILE, trace });

  process.stdout.write(`\nQ: ${question}\n\n`);
  const answer = await agent.answer(question);
  process.stdout.write(`\nA: ${answer}\n`);
}

main().catch((error) => {
  process.stderr.write(`\nask failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
