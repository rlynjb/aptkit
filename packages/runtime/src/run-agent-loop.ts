import { timestamp, type CapabilityTraceSink } from './events.js';
import type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelTool,
  ModelToolResultBlock,
  ModelToolUseBlock,
} from './model-provider.js';

export type ToolCallRecord = {
  id: string;
  capabilityId: string;
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  durationMs?: number;
  error?: string;
};

export type ToolExecutor = {
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<{ result: unknown; durationMs: number }>;
};

export type AgentRunResult<T = null> = {
  finalText: string;
  toolCalls: ToolCallRecord[];
  parsed: T | null;
};

export type RunAgentLoopOptions<T> = {
  capabilityId: string;
  model: ModelProvider;
  tools: ToolExecutor;
  system: string;
  userPrompt: string;
  toolSchemas: ModelTool[];
  trace?: CapabilityTraceSink;
  maxTurns?: number;
  maxTokens?: number;
  maxToolCalls?: number;
  synthesisInstruction?: string;
  signal?: AbortSignal;
  parseResult?: (finalText: string) => T | null;
  recoveryPrompt?: (toolCalls: ToolCallRecord[]) => string;
};

const MAX_TOOL_RESULT_CHARS = 16_000;

function truncate(value: string): string {
  if (value.length <= MAX_TOOL_RESULT_CHARS) return value;
  return `${value.slice(0, MAX_TOOL_RESULT_CHARS)}\n...[truncated]`;
}

function textFromContent(content: ModelContentBlock[]): string {
  return content
    .filter((block): block is Extract<ModelContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

function toolUsesFromContent(content: ModelContentBlock[]): ModelToolUseBlock[] {
  return content.filter(
    (block): block is ModelToolUseBlock => block.type === 'tool_use',
  );
}

export function buildSynthesisInstruction(middle: string): string {
  return `You have NO more tool calls available. ${middle} Do not say you need more queries.`;
}

export async function runAgentLoop<T = null>(
  options: RunAgentLoopOptions<T>,
): Promise<AgentRunResult<T>> {
  const {
    capabilityId,
    model,
    tools,
    system,
    userPrompt,
    toolSchemas,
    trace,
    maxTurns = 8,
    maxTokens = 4096,
    maxToolCalls,
    synthesisInstruction,
    signal,
  } = options;

  const messages: ModelMessage[] = [{ role: 'user', content: userPrompt }];
  const toolCalls: ToolCallRecord[] = [];
  let finalText = '';

  for (let turn = 0; turn < maxTurns; turn += 1) {
    signal?.throwIfAborted();

    const budgetSpent = maxToolCalls !== undefined && toolCalls.length >= maxToolCalls;
    const forceFinal = turn === maxTurns - 1 || budgetSpent;
    const response = await model.complete({
      system: forceFinal && synthesisInstruction ? `${system}\n\n${synthesisInstruction}` : system,
      messages,
      tools: forceFinal ? undefined : toolSchemas,
      maxTokens,
      signal,
    });

    if (response.usage) {
      trace?.emit({
        type: 'model_usage',
        capabilityId,
        provider: model.id,
        model: response.model ?? model.defaultModel ?? 'unknown',
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        estimated: response.usage.estimated,
        timestamp: timestamp(),
      });
    }

    messages.push({ role: 'assistant', content: response.content });

    const text = textFromContent(response.content);
    if (text) {
      trace?.emit({ type: 'step', capabilityId, role: 'assistant', content: text, timestamp: timestamp() });
    }

    const toolUses = toolUsesFromContent(response.content);
    if (toolUses.length === 0) {
      finalText = text;
      break;
    }

    const toolResults: ModelToolResultBlock[] = [];

    for (const toolUse of toolUses) {
      const toolCall: ToolCallRecord = {
        id: toolUse.id,
        capabilityId,
        toolName: toolUse.name,
        args: toolUse.input,
      };

      trace?.emit({
        type: 'tool_call_start',
        capabilityId,
        toolName: toolUse.name,
        args: toolUse.input,
        timestamp: timestamp(),
      });

      let isError = false;
      let resultContent: string;

      try {
        const { result, durationMs } = await tools.callTool(toolUse.name, toolUse.input, { signal });
        toolCall.result = result;
        toolCall.durationMs = durationMs;
        resultContent = truncate(JSON.stringify(result));
      } catch (error) {
        isError = true;
        const message = error instanceof Error ? error.message : String(error);
        toolCall.error = message;
        resultContent = truncate(JSON.stringify({ error: message }));
      }

      toolCalls.push(toolCall);
      trace?.emit({
        type: 'tool_call_end',
        capabilityId,
        toolName: toolUse.name,
        result: toolCall.result,
        error: toolCall.error,
        durationMs: toolCall.durationMs ?? 0,
        timestamp: timestamp(),
      });

      toolResults.push({
        type: 'tool_result',
        toolUseId: toolUse.id,
        content: resultContent,
        ...(isError ? { isError: true } : {}),
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }

  let parsed: T | null = null;
  if (options.parseResult) {
    parsed = options.parseResult(finalText);
    if (parsed === null && options.recoveryPrompt) {
      const recoveryText = await runRecoveryTurn(options, options.recoveryPrompt(toolCalls));
      parsed = recoveryText === null ? null : options.parseResult(recoveryText);
    }
  }

  return { finalText, toolCalls, parsed };
}

async function runRecoveryTurn<T>(
  options: RunAgentLoopOptions<T>,
  userPrompt: string,
): Promise<string | null> {
  try {
    options.signal?.throwIfAborted();
    const response = await options.model.complete({
      system:
        'You are concluding a completed investigation. Output ONLY the structured answer in the requested shape. Never ask for more data.',
      messages: [{ role: 'user', content: userPrompt }],
      maxTokens: 2048,
      signal: options.signal,
    });
    return textFromContent(response.content);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    options.trace?.emit({
      type: 'warning',
      capabilityId: options.capabilityId,
      message: error instanceof Error ? error.message : String(error),
      timestamp: timestamp(),
    });
    return null;
  }
}
