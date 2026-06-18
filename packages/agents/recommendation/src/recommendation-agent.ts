import { recommendationPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { buildSynthesisInstruction, runAgentLoop, type CapabilityTraceSink, type ModelProvider, type ToolCallRecord } from '@aptkit/runtime';
import { filterToolsForPolicy, type ToolRegistry } from '@aptkit/tools';
import { schemaSummary } from './schema-summary.js';
import {
  DEFAULT_ACTION_TAXONOMY,
  type ActionTaxonomy,
  type Anomaly,
  type Diagnosis,
  type IdlessRecommendation,
  type Recommendation,
  type WorkspaceDescriptor,
} from './types.js';
import { tryParseRecommendations } from './validate.js';

export const RECOMMENDATION_CAPABILITY_ID = 'recommendation-agent';

export const recommendationToolPolicy = {
  capabilityId: RECOMMENDATION_CAPABILITY_ID,
  allowedTools: [
    'list_scenarios',
    'get_scenario',
    'list_initiatives',
    'get_initiative_items',
    'list_recommendations',
    'get_recommendation',
    'list_segmentations',
    'list_email_campaigns',
    'list_voucher_pools',
    'get_frequency_policies',
    'get_metric_timeseries',
    'get_segments',
    'get_anomaly_context',
  ] as const,
};

export type RecommendationAgentOptions = {
  model: ModelProvider;
  tools: ToolRegistry;
  workspace: WorkspaceDescriptor;
  actionTaxonomy?: ActionTaxonomy;
  trace?: CapabilityTraceSink;
  idGenerator?: () => string;
  prompt?: string;
};

export type RecommendationRunOptions = {
  signal?: AbortSignal;
};

export class RecommendationAgent {
  private readonly taxonomy: ActionTaxonomy;
  private readonly idGenerator: () => string;
  private readonly prompt: string;

  constructor(private readonly options: RecommendationAgentOptions) {
    this.taxonomy = options.actionTaxonomy ?? DEFAULT_ACTION_TAXONOMY;
    this.idGenerator = options.idGenerator ?? (() => crypto.randomUUID());
    this.prompt = options.prompt ?? recommendationPromptPackage.system;
  }

  async propose(
    anomaly: Anomaly,
    diagnosis: Diagnosis,
    runOptions: RecommendationRunOptions = {},
  ): Promise<Recommendation[]> {
    const allTools = await this.options.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, recommendationToolPolicy);
    const system = renderPromptTemplate(this.prompt, {
      schema: schemaSummary(this.options.workspace),
      project_id: this.options.workspace.projectId,
      diagnosis: JSON.stringify(diagnosis),
    });

    const { parsed } = await runAgentLoop<IdlessRecommendation[]>({
      capabilityId: RECOMMENDATION_CAPABILITY_ID,
      model: this.options.model,
      tools: this.options.tools,
      system,
      userPrompt: 'Propose recommendations for this diagnosis and return the JSON array.',
      toolSchemas,
      trace: this.options.trace,
      signal: runOptions.signal,
      maxTurns: 6,
      maxToolCalls: 4,
      synthesisInstruction: buildSynthesisInstruction(
        'Stop querying now and output your final answer. Respond with ONLY a JSON array of at most 3 recommendation objects in a json fence, or [] if you cannot propose grounded actions, based on the diagnosis and the data you have already gathered. Do NOT include an id field.',
      ),
      parseResult: (text) => tryParseRecommendations(text, this.taxonomy),
      recoveryPrompt: (toolCalls) => buildRecoveryPrompt(anomaly, diagnosis, toolCalls),
    });

    if (!parsed) return [];
    return parsed.slice(0, 3).map((recommendation) => ({
      id: this.idGenerator(),
      ...recommendation,
    }));
  }
}

function buildRecoveryPrompt(
  anomaly: Anomaly,
  diagnosis: Diagnosis,
  toolCalls: ToolCallRecord[],
): string {
  const evidence =
    toolCalls
      .map((call, index) => {
        const payload = call.error ? { error: call.error } : call.result;
        return `Query ${index + 1}: ${call.toolName} ${JSON.stringify(call.args).slice(0, 200)}\nResult: ${JSON.stringify(payload).slice(0, 900)}`;
      })
      .join('\n\n') || '(no existing-feature queries were completed)';

  return [
    `Anomaly that was diagnosed:\n${JSON.stringify(anomaly)}`,
    `Diagnosis to act on:\n${JSON.stringify(diagnosis)}`,
    `Existing-feature queries run and their results:\n${evidence}`,
    'Based on the diagnosis above, output your best 2-3 recommendations as a single JSON array in a json fence.',
    'Each object must include title, rationale, bloomreachFeature, steps, estimatedImpact, confidence, and any useful setup fields.',
    'Do NOT include an id field. If you cannot propose grounded actions, return []. Do NOT request more queries.',
  ].join('\n\n');
}
