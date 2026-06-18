import OpenAI from 'openai';
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';
import type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelTool,
  ModelToolResultBlock,
} from '@aptkit/runtime';

export type OpenAIModelProviderOptions = {
  apiKey?: string;
  model?: string;
  client?: OpenAI;
};

export class OpenAIModelProvider implements ModelProvider {
  readonly id = 'openai';
  readonly defaultModel: string;
  private readonly client: OpenAI;

  constructor(options: OpenAIModelProviderOptions = {}) {
    this.defaultModel = options.model ?? process.env.OPENAI_MODEL ?? 'gpt-4.1';
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey ?? process.env.OPENAI_API_KEY });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const messages: ChatCompletionMessageParam[] = [
      ...(request.system ? [{ role: 'system' as const, content: request.system }] : []),
      ...request.messages.flatMap(toOpenAIMessage),
    ];

    const response = await this.client.chat.completions.create(
      {
        model: this.defaultModel,
        messages,
        ...(request.tools?.length ? { tools: request.tools.map(toOpenAITool), tool_choice: 'auto' as const } : {}),
        ...(request.maxTokens !== undefined ? { max_completion_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    const message = response.choices[0]?.message;
    const content: ModelContentBlock[] = [];

    if (message?.content) {
      content.push({ type: 'text', text: message.content });
    }

    for (const toolCall of message?.tool_calls ?? []) {
      if (toolCall.type !== 'function') continue;
      content.push({
        type: 'tool_use',
        id: toolCall.id,
        name: toolCall.function.name,
        input: parseToolArguments(toolCall.function.arguments),
      });
    }

    return {
      content,
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
            estimated: false,
          }
        : undefined,
      model: response.model,
    };
  }
}

function toOpenAIMessage(message: ModelMessage): ChatCompletionMessageParam[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }];
  }

  if (isToolResultList(message.content)) {
    return message.content.map((block) => ({
      role: 'tool',
      tool_call_id: block.toolUseId,
      content: block.content,
    }));
  }

  if (message.role === 'assistant') {
    const text = message.content
      .filter((block): block is Extract<ModelContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = message.content
      .filter((block): block is Extract<ModelContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      }));

    const assistantMessage: ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    };
    return [assistantMessage];
  }

  return [{
    role: 'user',
    content: message.content
      .filter((block): block is Extract<ModelContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join(''),
  }];
}

function toOpenAITool(tool: ModelTool): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema as Record<string, unknown>,
    },
  };
}

function isToolResultList(
  blocks: ModelContentBlock[] | ModelToolResultBlock[],
): blocks is ModelToolResultBlock[] {
  return blocks.every((block) => block.type === 'tool_result');
}

function parseToolArguments(args: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(args);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}
