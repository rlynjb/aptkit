import {
  buildSynthesisInstruction,
  runAgentLoop,
  type CapabilityTraceSink,
  type ModelProvider,
} from '@aptkit/runtime';
import { renderPromptTemplate } from '@aptkit/prompts';
import { filterToolsForPolicy, type ToolPolicy, type ToolRegistry } from '@aptkit/tools';
import { injectProfile } from '@aptkit/context';
import { SEARCH_KNOWLEDGE_BASE_TOOL_NAME } from '@aptkit/retrieval';

export const RAG_QUERY_CAPABILITY_ID = 'rag-query-agent';

/** Least-privilege grant: this agent may only search the knowledge base. */
export const ragQueryToolPolicy: ToolPolicy = {
  capabilityId: RAG_QUERY_CAPABILITY_ID,
  allowedTools: [SEARCH_KNOWLEDGE_BASE_TOOL_NAME],
};

const DEFAULT_SYSTEM_TEMPLATE = [
  'You are a personal knowledge assistant.',
  '',
  `Always call the ${SEARCH_KNOWLEDGE_BASE_TOOL_NAME} tool first to retrieve relevant`,
  'passages before answering. Ground every answer in the retrieved chunks and cite',
  'their sources. If the knowledge base does not contain the answer, say so plainly',
  'rather than guessing.',
].join('\n');

const PROFILE_HEADING = '# About the person you are assisting';

const FALLBACK_ANSWER = "I couldn't find anything in the knowledge base to answer that.";

export type RagQueryAgentOptions = {
  /** Package A — the model (e.g. a guarded Gemma provider). */
  model: ModelProvider;
  /** Package B — a registry holding the search_knowledge_base tool. */
  tools: ToolRegistry;
  /** Package C — the user profile (me.md text) to inject into the system prompt. */
  profile?: string;
  /** Override the default system template. */
  prompt?: string;
  trace?: CapabilityTraceSink;
};

export type RagQueryRunOptions = {
  signal?: AbortSignal;
};

export class RagQueryAgent {
  private readonly system: string;

  constructor(private readonly options: RagQueryAgentOptions) {
    const template = options.prompt ?? DEFAULT_SYSTEM_TEMPLATE;
    // C then render: inject the profile, then resolve any template placeholders.
    const withProfile = options.profile
      ? injectProfile(template, options.profile, { position: 'start', heading: PROFILE_HEADING })
      : template;
    this.system = renderPromptTemplate(withProfile, {});
  }

  /** Answers a question grounded in the indexed knowledge base. */
  async answer(question: string, runOptions: RagQueryRunOptions = {}): Promise<string> {
    const allTools = await this.options.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, ragQueryToolPolicy);

    const { finalText } = await runAgentLoop({
      capabilityId: RAG_QUERY_CAPABILITY_ID,
      model: this.options.model,
      tools: this.options.tools,
      system: this.system,
      userPrompt: question,
      toolSchemas,
      trace: this.options.trace,
      signal: runOptions.signal,
      maxTurns: 6,
      maxToolCalls: 4,
      synthesisInstruction: buildSynthesisInstruction(
        'Now answer the question directly and concisely, citing the sources you retrieved.',
      ),
    });

    return finalText.trim() || FALLBACK_ANSWER;
  }
}
