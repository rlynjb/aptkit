import { buildSynthesisInstruction, runAgentLoop, type CapabilityTraceSink, type ModelProvider } from '@aptkit/runtime';
import { queryPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { filterToolsForPolicy, type ToolRegistry } from '@aptkit/tools';
import { schemaSummary } from './schema-summary.js';
import type { Intent, WorkspaceDescriptor } from './types.js';

export const QUERY_CAPABILITY_ID = 'query-agent';

export const queryToolPolicy = {
  capabilityId: QUERY_CAPABILITY_ID,
  allowedTools: [
    'list_dashboards',
    'get_dashboard',
    'list_trends',
    'get_trend',
    'list_funnels',
    'get_funnel',
    'list_running_aggregates',
    'get_running_aggregate',
    'list_reports',
    'get_report',
    'execute_analytics',
    'execute_analytics_eql',
    'get_customer_prediction_score',
    'get_event_segmentation',
    'list_customers',
    'list_customer_events',
    'list_customers_in_segment',
    'list_segmentations',
    'list_email_campaigns',
    'list_sms_campaigns',
    'list_in_app_messages',
    'list_banners',
    'list_experiments',
    'list_scenarios',
    'list_catalog_items',
    'get_catalog_item',
    'get_scenario',
    'list_initiatives',
    'get_initiative_items',
    'list_recommendations',
    'get_recommendation',
    'list_voucher_pools',
    'get_frequency_policies',
    'get_metric_timeseries',
    'get_segments',
    'get_anomaly_context',
  ] as const,
};

export type QueryAgentOptions = {
  model: ModelProvider;
  tools: ToolRegistry;
  workspace: WorkspaceDescriptor;
  trace?: CapabilityTraceSink;
  prompt?: string;
};

export type QueryRunOptions = {
  intent?: Intent;
  signal?: AbortSignal;
};

const FALLBACK_ANSWER = 'I was unable to find enough data to answer that question.';

export class QueryAgent {
  private readonly prompt: string;

  constructor(private readonly options: QueryAgentOptions) {
    this.prompt = options.prompt ?? queryPromptPackage.system;
  }

  async answer(question: string, runOptions: QueryRunOptions = {}): Promise<string> {
    const allTools = await this.options.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, queryToolPolicy);
    const intent = runOptions.intent ?? 'diagnostic';
    const system = renderPromptTemplate(this.prompt, {
      schema: schemaSummary(this.options.workspace),
      project_id: this.options.workspace.projectId,
      intent,
    });

    const { finalText } = await runAgentLoop({
      capabilityId: QUERY_CAPABILITY_ID,
      model: this.options.model,
      tools: this.options.tools,
      system,
      userPrompt: question,
      toolSchemas,
      trace: this.options.trace,
      signal: runOptions.signal,
      maxTurns: 8,
      maxToolCalls: 6,
      synthesisInstruction: buildSynthesisInstruction(
        'Now answer the user question directly and concisely in plain prose, citing the key numbers you found.',
      ),
    });

    return finalText.trim() || FALLBACK_ANSWER;
  }
}
