export type ModelTextBlock = {
  type: 'text';
  text: string;
};

export type ModelToolUseBlock = {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type ModelToolResultBlock = {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
};

export type ModelContentBlock = ModelTextBlock | ModelToolUseBlock;

export type ModelMessage = {
  role: 'user' | 'assistant';
  content: string | ModelContentBlock[] | ModelToolResultBlock[];
};

export type ModelTool = {
  name: string;
  description?: string;
  inputSchema: object;
};

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  estimated?: boolean;
};

export type ModelRequest = {
  system?: string;
  messages: ModelMessage[];
  tools?: ModelTool[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type ModelResponse = {
  content: ModelContentBlock[];
  usage?: ModelUsage;
  model?: string;
};

export type ModelProvider = {
  id: string;
  defaultModel?: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
};
