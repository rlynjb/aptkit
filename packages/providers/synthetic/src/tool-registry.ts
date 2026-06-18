import type { ToolCallOptions, ToolCallResult, ToolDefinition, ToolRegistry } from '@aptkit/tools';
import { syntheticEcommerceToolDefinitions } from './tool-definitions.js';
import type { SyntheticEcommerceDataSource } from './types.js';

export type SyntheticEcommerceToolRegistryOptions = {
  dataSource: SyntheticEcommerceDataSource;
  tools?: readonly ToolDefinition[];
};

/** ToolRegistry adapter that exposes synthetic ecommerce data through normal agent tools. */
export class SyntheticEcommerceToolRegistry implements ToolRegistry {
  private readonly dataSource: SyntheticEcommerceDataSource;
  private readonly tools: readonly ToolDefinition[];

  constructor(options: SyntheticEcommerceToolRegistryOptions) {
    this.dataSource = options.dataSource;
    this.tools = options.tools ?? syntheticEcommerceToolDefinitions;
  }

  listTools(): ToolDefinition[] {
    return [...this.tools];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options?: ToolCallOptions,
  ): Promise<ToolCallResult> {
    options?.signal?.throwIfAborted();
    const start = performance.now();
    const result = await this.dispatch(name, args);
    return { result, durationMs: Math.round(performance.now() - start) };
  }

  private dispatch(name: string, args: Record<string, unknown>): Promise<unknown> | unknown {
    if (name === 'get_project_overview') return this.dataSource.getProjectOverview();
    if (name === 'get_metric_timeseries') return this.dataSource.getMetricTimeseries(args);
    if (name === 'get_anomaly_context') return this.dataSource.getAnomalyContext(args);
    throw new Error(`synthetic ecommerce tool not found: ${name}`);
  }
}
