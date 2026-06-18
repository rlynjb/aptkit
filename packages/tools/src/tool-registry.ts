import type { ModelTool } from '@aptkit/runtime';

export type ToolDefinition = ModelTool;

export type ToolCallOptions = {
  signal?: AbortSignal;
};

export type ToolCallResult = {
  result: unknown;
  durationMs: number;
};

export type ToolRegistry = {
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<ToolCallResult>;
};

export type ToolHandler = (
  args: Record<string, unknown>,
  options?: ToolCallOptions,
) => Promise<unknown> | unknown;

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly handlers = new Map<string, ToolHandler>();

  constructor(
    private readonly definitions: ToolDefinition[],
    handlers: Record<string, ToolHandler>,
  ) {
    for (const [name, handler] of Object.entries(handlers)) {
      this.handlers.set(name, handler);
    }
  }

  listTools(): ToolDefinition[] {
    return this.definitions;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<ToolCallResult> {
    options?.signal?.throwIfAborted();
    const handler = this.handlers.get(name);
    if (!handler) {
      throw new Error(`tool not found: ${name}`);
    }

    const start = performance.now();
    const result = await handler(args, options);
    return { result, durationMs: Math.round(performance.now() - start) };
  }
}
