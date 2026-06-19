import {
  timestamp,
  type CapabilityTraceSink,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@aptkit/runtime';

export type ContextWindowGuardOptions = {
  maxTokens: number;
  outputReserve?: number;
  charsPerToken?: number;
  capabilityId?: string;
  trace?: CapabilityTraceSink;
};

export type ContextWindowEstimate = {
  estimatedInputTokens: number;
  maxTokens: number;
  outputReserve: number;
  availableInputTokens: number;
  ok: boolean;
};

export class ContextWindowExceededError extends Error {
  readonly estimate: ContextWindowEstimate;

  constructor(estimate: ContextWindowEstimate) {
    super(
      `estimated input tokens ${estimate.estimatedInputTokens} exceed local context input budget ${estimate.availableInputTokens}`,
    );
    this.name = 'ContextWindowExceededError';
    this.estimate = estimate;
  }
}

export class ContextWindowGuardedProvider implements ModelProvider {
  readonly id: string;
  readonly defaultModel?: string;
  private readonly provider: ModelProvider;
  private readonly options: Required<Omit<ContextWindowGuardOptions, 'trace'>> & { trace?: CapabilityTraceSink };

  constructor(provider: ModelProvider, options: ContextWindowGuardOptions) {
    this.provider = provider;
    this.id = provider.id;
    this.defaultModel = provider.defaultModel;
    this.options = {
      maxTokens: options.maxTokens,
      outputReserve: options.outputReserve ?? 768,
      charsPerToken: options.charsPerToken ?? 3,
      capabilityId: options.capabilityId ?? 'local-context-guard',
      trace: options.trace,
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    request.signal?.throwIfAborted();
    const estimate = estimateContextWindow(request, this.options);
    if (!estimate.ok) {
      this.options.trace?.emit({
        type: 'warning',
        capabilityId: this.options.capabilityId,
        message: `Skipping local provider ${this.provider.id}: estimated ${estimate.estimatedInputTokens} input tokens exceed ${estimate.availableInputTokens}.`,
        timestamp: timestamp(),
      });
      throw new ContextWindowExceededError(estimate);
    }
    return this.provider.complete(request);
  }
}

export function estimateContextWindow(
  request: ModelRequest,
  options: Pick<ContextWindowGuardOptions, 'maxTokens' | 'outputReserve' | 'charsPerToken'>,
): ContextWindowEstimate {
  const maxTokens = options.maxTokens;
  const outputReserve = options.outputReserve ?? 768;
  const charsPerToken = options.charsPerToken ?? 3;
  const estimatedInputTokens = estimateModelRequestTokens(request, charsPerToken);
  const availableInputTokens = Math.max(0, maxTokens - outputReserve);
  return {
    estimatedInputTokens,
    maxTokens,
    outputReserve,
    availableInputTokens,
    ok: estimatedInputTokens <= availableInputTokens,
  };
}

export function estimateModelRequestTokens(request: ModelRequest, charsPerToken = 3): number {
  const text = [
    request.system ?? '',
    ...request.messages.map(messageText),
    ...(request.tools ?? []).map((tool) => `${tool.name} ${tool.description ?? ''} ${JSON.stringify(tool.inputSchema)}`),
  ].join('\n');
  return estimateTextTokens(text, charsPerToken);
}

export function estimateTextTokens(text: string, charsPerToken = 3): number {
  if (charsPerToken <= 0) throw new Error('charsPerToken must be greater than 0');
  return Math.ceil(text.length / charsPerToken);
}

function messageText(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool_use') return `${block.name} ${JSON.stringify(block.input)}`;
    return block.content;
  }).join('\n');
}
