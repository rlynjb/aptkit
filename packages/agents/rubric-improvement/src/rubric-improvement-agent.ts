import {
  buildSynthesisInstruction,
  parseValidatedJson,
  runAgentLoop,
  type CapabilityTraceSink,
  type ModelProvider,
} from '@aptkit/runtime';
import { filterToolsForPolicy, type ToolPolicy, type ToolRegistry } from '@aptkit/tools';
import type { RubricDefinition } from './types.js';
import type { RubricImprovementInput, RubricImprovementResult } from './types.js';
import { validateRubricImprovementResult } from './validate.js';

export const RUBRIC_IMPROVEMENT_CAPABILITY_ID = 'rubric-improvement-agent';

export const rubricImprovementToolPolicy = {
  capabilityId: RUBRIC_IMPROVEMENT_CAPABILITY_ID,
  allowedTools: [
    'get_recent_judgments',
    'get_user_pattern_history',
    'get_rubric_definition',
    'get_current_attempt_context',
    'save_judgment',
    'generate_next_scenario',
  ] as const,
};

export type RubricImprovementAgentOptions = {
  model: ModelProvider;
  tools: ToolRegistry;
  rubric: RubricDefinition;
  trace?: CapabilityTraceSink;
  toolPolicy?: ToolPolicy;
  prompt?: string;
};

export type RubricImprovementRunOptions = {
  signal?: AbortSignal;
};

export class RubricImprovementAgent {
  private readonly model: ModelProvider;
  private readonly tools: ToolRegistry;
  private readonly rubric: RubricDefinition;
  private readonly trace?: CapabilityTraceSink;
  private readonly toolPolicy: ToolPolicy;
  private readonly prompt?: string;

  constructor(options: RubricImprovementAgentOptions) {
    this.model = options.model;
    this.tools = options.tools;
    this.rubric = options.rubric;
    this.trace = options.trace;
    this.toolPolicy = options.toolPolicy ?? rubricImprovementToolPolicy;
    this.prompt = options.prompt;
  }

  async improve(
    input: RubricImprovementInput,
    options: RubricImprovementRunOptions = {},
  ): Promise<RubricImprovementResult> {
    const allTools = await this.tools.listTools();
    const toolSchemas = filterToolsForPolicy(allTools, this.toolPolicy);
    const validate = validateRubricImprovementResult(this.rubric);
    const system = this.prompt ?? buildRubricImprovementSystemPrompt(this.rubric);

    const { parsed } = await runAgentLoop({
      capabilityId: RUBRIC_IMPROVEMENT_CAPABILITY_ID,
      model: this.model,
      tools: this.tools,
      system,
      userPrompt: buildRubricImprovementUserPrompt(input),
      toolSchemas,
      trace: this.trace,
      signal: options.signal,
      maxTurns: 6,
      maxToolCalls: 3,
      maxTokens: 2400,
      synthesisInstruction: buildSynthesisInstruction(
        'Return the final rubric improvement JSON object with judgment, weakestDimension, nextAction, and optional nextDrill.',
      ),
      parseResult: (text) => parseImprovementResult(text, validate),
      recoveryPrompt: (completedToolCalls) => [
        'The previous answer was not valid JSON for the rubric improvement output.',
        'Use the same completed evidence and tool results; do not request more data.',
        'Return ONLY a JSON object with this shape:',
        outputShape(this.rubric),
        '',
        `Tool calls already completed: ${JSON.stringify(completedToolCalls.map((call) => ({ toolName: call.toolName, args: call.args, result: call.result, error: call.error })))}`,
      ].join('\n'),
    });

    if (parsed) return parsed;
    throw new Error('rubric improvement output was not parseable');
  }
}

export function buildRubricImprovementSystemPrompt(rubric: RubricDefinition): string {
  return [
    `You are a rubric improvement agent for: ${rubric.title}.`,
    rubric.task,
    '',
    'Your job is to score the subject, identify the weakest dimension, and produce one focused next action.',
    'Use tools only when they can improve the judgment with recent history, pattern context, current attempt context, or scenario generation.',
    'Do not rewrite the subject. Do not provide a long coaching essay.',
    '',
    'Rubric:',
    JSON.stringify(rubric, null, 2),
    '',
    'Return JSON only. No markdown fences. Use exactly this shape:',
    outputShape(rubric),
  ].join('\n');
}

export function buildRubricImprovementUserPrompt(input: RubricImprovementInput): string {
  const context = input.context && Object.keys(input.context).length > 0
    ? `Context:\n${Object.entries(input.context).map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n`
    : '';
  return `${context}Subject:\n${input.subject}`;
}

function parseImprovementResult(
  text: string,
  validate: (value: unknown) => { ok: true; value: RubricImprovementResult } | { ok: false; error: string },
): RubricImprovementResult | null {
  const result = parseValidatedJson(text, validate);
  return result.ok ? result.value : null;
}

function outputShape(rubric: RubricDefinition): string {
  const dimensions = Object.fromEntries(
    rubric.dimensions.map((dimension) => [dimension.id, { score: 0, reason: '' }]),
  );
  const checks = Object.fromEntries((rubric.checks ?? []).map((check) => [check, true]));
  return JSON.stringify({
    judgment: {
      dimensions,
      ...(rubric.checks?.length ? { checks } : {}),
      verdict: rubric.verdicts[0]?.verdict ?? 'pass',
      fix: '',
      reasoning: '',
    },
    weakestDimension: rubric.dimensions[0]?.id ?? 'dimension',
    nextAction: '',
    nextDrill: {
      prompt: '',
      goal: '',
    },
  }, null, 2);
}
