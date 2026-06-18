import { buildSynthesisInstruction, runAgentLoop, type CapabilityTraceSink, type ModelProvider, type ToolCallRecord } from '@aptkit/runtime';
import { filterToolsForPolicy, type ToolRegistry } from '@aptkit/tools';
import { DIAGNOSTIC_PROMPT } from './diagnostic-prompt.js';
import { schemaSummary } from './schema-summary.js';
import type { Anomaly, Diagnosis, WorkspaceDescriptor } from './types.js';
import { tryParseDiagnosis } from './validate.js';

export const DIAGNOSTIC_INVESTIGATION_CAPABILITY_ID = 'diagnostic-investigation-agent';

export const diagnosticInvestigationToolPolicy = {
  capabilityId: DIAGNOSTIC_INVESTIGATION_CAPABILITY_ID,
  allowedTools: [
    'execute_analytics_eql',
    'get_event_segmentation',
    'list_email_campaigns',
    'list_experiments',
    'list_scenarios',
    'list_banners',
    'list_customers',
    'get_customer_prediction_score',
    'get_metric_timeseries',
    'get_segments',
    'get_anomaly_context',
  ] as const,
};

export type DiagnosticAgentOptions = {
  model: ModelProvider;
  tools: ToolRegistry;
  workspace: WorkspaceDescriptor;
  trace?: CapabilityTraceSink;
  prompt?: string;
};

export type DiagnosticRunOptions = {
  signal?: AbortSignal;
};

const FALLBACK_DIAGNOSIS: Diagnosis = {
  conclusion: 'Insufficient data to determine a cause for this change.',
  evidence: [],
  hypothesesConsidered: [],
  confidence: 'low',
};

export class DiagnosticInvestigationAgent {
  private readonly prompt: string;

  constructor(private readonly options: DiagnosticAgentOptions) {
    this.prompt = options.prompt ?? DIAGNOSTIC_PROMPT;
  }

  async investigate(anomaly: Anomaly, runOptions: DiagnosticRunOptions = {}): Promise<Diagnosis> {
    const allTools = await this.options.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, diagnosticInvestigationToolPolicy);
    const system = this.prompt
      .replace('{schema}', schemaSummary(this.options.workspace))
      .replace(/\{project_id\}/g, this.options.workspace.projectId)
      .replace('{anomaly}', JSON.stringify(anomaly));

    const { toolCalls, parsed } = await runAgentLoop<Diagnosis>({
      capabilityId: DIAGNOSTIC_INVESTIGATION_CAPABILITY_ID,
      model: this.options.model,
      tools: this.options.tools,
      system,
      userPrompt: 'Investigate the anomaly and return the diagnosis JSON object.',
      toolSchemas,
      trace: this.options.trace,
      signal: runOptions.signal,
      maxTurns: 8,
      maxToolCalls: 6,
      synthesisInstruction: buildSynthesisInstruction(
        'Stop investigating now and output your final answer. Respond with ONLY a single JSON object in a json fence matching the diagnosis shape: conclusion, evidence, hypothesesConsidered, and any supported optional fields. Base it only on the evidence already gathered.',
      ),
      parseResult: tryParseDiagnosis,
      recoveryPrompt: (calls) => buildRecoveryPrompt(anomaly, calls),
    });

    const diagnosis = parsed ?? FALLBACK_DIAGNOSIS;
    const confidence = diagnosisConfidence(diagnosis);
    const hadErrors = toolCalls.some((call) => call.error);
    return { ...diagnosis, confidence: confidence === 'high' && hadErrors ? 'medium' : confidence };
  }
}

export function diagnosisConfidence(diagnosis: Diagnosis): 'high' | 'medium' | 'low' {
  if (diagnosis.confidence) return diagnosis.confidence;
  const hypotheses = diagnosis.hypothesesConsidered ?? [];
  if (hypotheses.length === 0) return 'low';
  const supported = hypotheses.filter((item) => item.supported).length;
  const tested = hypotheses.filter((item) => item.reasoning.trim().length > 0).length;
  if (supported >= 1 && tested === hypotheses.length) return 'high';
  if (supported >= 1) return 'medium';
  return 'low';
}

function buildRecoveryPrompt(anomaly: Anomaly, toolCalls: ToolCallRecord[]): string {
  const evidence =
    toolCalls
      .map((call, index) => {
        const payload = call.error ? { error: call.error } : call.result;
        return `Query ${index + 1}: ${call.toolName} ${JSON.stringify(call.args).slice(0, 200)}\nResult: ${JSON.stringify(payload).slice(0, 900)}`;
      })
      .join('\n\n') || '(no successful queries were completed)';

  return [
    `Anomaly investigated:\n${JSON.stringify(anomaly)}`,
    `Queries run and their results:\n${evidence}`,
    'Based ONLY on the evidence above, output your best-supported diagnosis as a single JSON object in a json fence.',
    'Use this shape: {"conclusion": string, "evidence": string[], "hypothesesConsidered": [{"hypothesis": string, "supported": boolean, "reasoning": string}]}.',
    'Give a concrete conclusion grounded in observed values. If the data was inconclusive, say what was inconclusive. Do NOT request more queries.',
  ].join('\n\n');
}
