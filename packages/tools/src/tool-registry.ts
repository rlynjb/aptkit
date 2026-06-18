import type { ModelTool } from '@aptkit/runtime';

export type ToolDefinition = ModelTool;

/** Per-call controls passed from an agent loop into a tool implementation. */
export type ToolCallOptions = {
  signal?: AbortSignal;
};

/** Normalized result envelope for any model-callable tool. */
export type ToolCallResult = {
  result: unknown;
  durationMs: number;
};

/** Provider-neutral registry that lists callable tools and executes them by name. */
export type ToolRegistry = {
  listTools(): Promise<ToolDefinition[]> | ToolDefinition[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<ToolCallResult>;
};

/** Function backing one tool in an in-memory or adapter-backed registry. */
export type ToolHandler = (
  args: Record<string, unknown>,
  options?: ToolCallOptions,
) => Promise<unknown> | unknown;

/** Test/demo registry that serves fixed tool definitions with injected handlers. */
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

  /** Executes a named handler and records wall-clock duration for traces. */
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
