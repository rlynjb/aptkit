import Anthropic from '@anthropic-ai/sdk';
import type {
  ModelContentBlock,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelTool,
  ModelToolResultBlock,
} from '@aptkit/runtime';

export type AnthropicModelProviderOptions = {
  apiKey?: string;
  model?: string;
  client?: Anthropic;
};

export class AnthropicModelProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly defaultModel: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicModelProviderOptions = {}) {
    this.defaultModel = options.model ?? 'claude-sonnet-4-6';
    this.client = options.client ?? new Anthropic({ apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY });
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.messages.create(
      {
        model: this.defaultModel,
        max_tokens: request.maxTokens ?? 4096,
        ...(request.system ? { system: request.system } : {}),
        messages: request.messages.map(toAnthropicMessage),
        ...(request.tools?.length ? { tools: request.tools.map(toAnthropicTool) } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      },
      request.signal ? { signal: request.signal } : undefined,
    );

    return {
      content: response.content.flatMap((block): ModelContentBlock[] => {
        if (block.type === 'text') return [{ type: 'text', text: block.text }];
        if (block.type === 'tool_use') {
          return [{
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: asRecord(block.input),
          }];
        }
        return [];
      }),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        estimated: false,
      },
      model: response.model,
    };
  }
}

function toAnthropicMessage(message: ModelMessage): Anthropic.Messages.MessageParam {
  return {
    role: message.role,
    content: typeof message.content === 'string'
      ? message.content
      : message.content.map((block) => {
          if (block.type === 'text') return { type: 'text', text: block.text } as const;
          if (block.type === 'tool_use') {
            return {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input,
            } as const;
          }
          return {
            type: 'tool_result',
            tool_use_id: (block as ModelToolResultBlock).toolUseId,
            content: (block as ModelToolResultBlock).content,
            ...((block as ModelToolResultBlock).isError ? { is_error: true } : {}),
          } as const;
        }) as Anthropic.Messages.MessageParam['content'],
  };
}

function toAnthropicTool(tool: ModelTool): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description ?? '',
    input_schema: tool.inputSchema as Anthropic.Messages.Tool['input_schema'],
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
