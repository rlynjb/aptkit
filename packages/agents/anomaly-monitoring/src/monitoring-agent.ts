import { monitoringPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { buildSynthesisInstruction, runAgentLoop, type CapabilityTraceSink, type ModelProvider, type ToolCallRecord } from '@aptkit/runtime';
import { filterToolsForPolicy, type ToolRegistry } from '@aptkit/tools';
import { ECOMMERCE_ANOMALY_CATEGORIES, runnableCategories, schemaCapabilities } from './categories.js';
import { schemaSummary } from './schema-summary.js';
import type { Anomaly, AnomalyCategory, WorkspaceDescriptor } from './types.js';
import { tryParseAnomalies } from './validate.js';

export const ANOMALY_MONITORING_CAPABILITY_ID = 'anomaly-monitoring-agent';

export const anomalyMonitoringToolPolicy = {
  capabilityId: ANOMALY_MONITORING_CAPABILITY_ID,
  allowedTools: [
    'execute_analytics_eql',
    'get_metric_timeseries',
    'get_segments',
    'get_anomaly_context',
  ] as const,
};

export type MonitoringAgentOptions = {
  model: ModelProvider;
  tools: ToolRegistry;
  workspace: WorkspaceDescriptor;
  categories?: readonly AnomalyCategory[];
  trace?: CapabilityTraceSink;
  prompt?: string;
};

export type MonitoringRunOptions = {
  signal?: AbortSignal;
};

const severityRank: Record<Anomaly['severity'], number> = {
  critical: 3,
  warning: 2,
  info: 1,
  positive: 0,
};

export class AnomalyMonitoringAgent {
  private readonly categories: readonly AnomalyCategory[];
  private readonly prompt: string;

  constructor(private readonly options: MonitoringAgentOptions) {
    this.categories = options.categories ?? ECOMMERCE_ANOMALY_CATEGORIES;
    this.prompt = options.prompt ?? monitoringPromptPackage.system;
  }

  runnableCategories(): AnomalyCategory[] {
    return runnableCategories(this.categories, schemaCapabilities(this.options.workspace));
  }

  async scan(runOptions: MonitoringRunOptions = {}): Promise<Anomaly[]> {
    const allTools = await this.options.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, anomalyMonitoringToolPolicy);
    const categories = this.runnableCategories();
    const system = renderPromptTemplate(this.prompt, {
      schema: schemaSummary(this.options.workspace),
      categories: formatCategoryChecklist(categories),
    });

    const { parsed } = await runAgentLoop<Anomaly[]>({
      capabilityId: ANOMALY_MONITORING_CAPABILITY_ID,
      model: this.options.model,
      tools: this.options.tools,
      system,
      userPrompt:
        'Run the anomaly checklist using the available tools. Return only the anomaly JSON array in a json fence, or [] if no meaningful anomaly is found.',
      toolSchemas,
      trace: this.options.trace,
      signal: runOptions.signal,
      maxTurns: 8,
      maxToolCalls: 6,
      synthesisInstruction: buildSynthesisInstruction(
        'Stop querying now and output your final answer. Respond with ONLY a JSON array of anomaly objects in a json fence, or [] if nothing meaningful was found, based on the data you have already gathered.',
      ),
      parseResult: tryParseAnomalies,
      recoveryPrompt: buildRecoveryPrompt,
    });

    if (!parsed) return [];
    return [...parsed]
      .sort((left, right) => severityRank[right.severity] - severityRank[left.severity])
      .slice(0, 10);
  }
}

function formatCategoryChecklist(categories: readonly AnomalyCategory[]): string {
  if (categories.length === 0) return '(no runnable checklist categories; scan core metrics broadly)';
  return categories
    .map(
      (category) =>
        `- ${category.id} (${category.label}): ${category.whyItMatters} recipe: ${category.queryRecipe}; warning >= ${category.thresholds.warning}%, critical >= ${category.thresholds.critical}%.`,
    )
    .join('\n');
}

function buildRecoveryPrompt(toolCalls: ToolCallRecord[]): string {
  const evidence =
    toolCalls
      .map((call, index) => {
        const payload = call.error ? { error: call.error } : call.result;
        return `Query ${index + 1}: ${call.toolName} ${JSON.stringify(call.args).slice(0, 200)}\nResult: ${JSON.stringify(payload).slice(0, 900)}`;
      })
      .join('\n\n') || '(no tool queries were completed)';

  return [
    'The anomaly-monitoring run is complete. Convert the evidence below into the final anomaly JSON array.',
    evidence,
    'Return ONLY a JSON array in a json fence. Each anomaly needs metric, scope, change, severity, evidence, and category when known. Return [] if evidence is not strong enough.',
  ].join('\n\n');
}
