import type { ToolDefinition, ToolHandler } from '@aptkit/tools';
import type { ConversationMemory, MemoryHit } from './conversation-memory.js';

export const SEARCH_MEMORY_TOOL_NAME = 'search_memory';

export type SearchMemoryResult = { id: string; score: number; text: string };

/** The tool's return payload (the registry wraps it with `durationMs`). */
export type SearchMemoryOutput = {
  query: string;
  memories: SearchMemoryResult[];
};

export type MemoryToolOptions = {
  /** top_k used when the caller omits one. Default 5. */
  defaultTopK?: number;
};

/**
 * Builds a `search_memory` tool over a ConversationMemory. Mirrors
 * `createSearchKnowledgeBaseTool`: returns a `{ definition, handler }` pair to
 * register into an `InMemoryToolRegistry` and select with `filterToolsForPolicy`.
 *
 * Use this when memory lives in a DEDICATED store and the agent should recall it
 * explicitly. When memory shares the document store, the existing
 * `search_knowledge_base` tool already surfaces it — no separate tool needed.
 */
export function createMemoryTool(
  memory: ConversationMemory,
  options: MemoryToolOptions = {},
): { definition: ToolDefinition; handler: ToolHandler } {
  const defaultTopK = options.defaultTopK ?? 5;

  const definition: ToolDefinition = {
    name: SEARCH_MEMORY_TOOL_NAME,
    description:
      'Search past conversation exchanges with this user for ones relevant to a ' +
      'query. Use when the answer may depend on something discussed earlier.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'what to recall from past conversations' },
        top_k: { type: 'number', description: 'max memories to return' },
      },
      required: ['query'],
    },
  };

  const handler: ToolHandler = async (args): Promise<SearchMemoryOutput> => {
    const query = String(args.query ?? '');
    const topK = typeof args.top_k === 'number' ? args.top_k : defaultTopK;
    const hits = await memory.recall(query, topK);
    return {
      query,
      memories: hits.map((h: MemoryHit) => ({ id: h.id, score: h.score, text: h.text })),
    };
  };

  return { definition, handler };
}
