import {
  generateStructured,
  type CapabilityTraceSink,
  type JsonValidation,
  type ModelProvider,
  type StructuredGenerationResult,
} from '@aptkit/runtime';

export type RubricScoreLevel = {
  score: number;
  description: string;
};

export type RubricDimension = {
  id: string;
  label: string;
  description: string;
  scale: readonly RubricScoreLevel[];
};

export type RubricVerdictRule = {
  verdict: string;
  description: string;
};

export type RubricCalibrationExample = {
  input: string;
  expected: string;
};

export type RubricDefinition = {
  id: string;
  title: string;
  task: string;
  dimensions: readonly RubricDimension[];
  verdicts: readonly RubricVerdictRule[];
  checks?: readonly string[];
  calibrationExamples?: readonly RubricCalibrationExample[];
};

export type RubricDimensionScore = {
  score: number;
  reason: string;
};

export type RubricJudgment = {
  dimensions: Record<string, RubricDimensionScore>;
  checks?: Record<string, boolean>;
  verdict: string;
  fix: string;
  reasoning?: string;
};

export type RubricJudgeInput = {
  subject: string;
  context?: Record<string, string>;
};

export type RubricJudgeOptions = {
  model: ModelProvider;
  rubric: RubricDefinition;
  capabilityId?: string;
  maxTokens?: number;
  temperature?: number;
  trace?: CapabilityTraceSink;
};

export type RubricJudgeRunOptions = {
  signal?: AbortSignal;
};

export class RubricJudge {
  private readonly model: ModelProvider;
  private readonly rubric: RubricDefinition;
  private readonly capabilityId: string;
  private readonly maxTokens: number;
  private readonly temperature?: number;
  private readonly trace?: CapabilityTraceSink;

  constructor(options: RubricJudgeOptions) {
    this.model = options.model;
    this.rubric = options.rubric;
    this.capabilityId = options.capabilityId ?? 'rubric-judge';
    this.maxTokens = options.maxTokens ?? 1200;
    this.temperature = options.temperature;
    this.trace = options.trace;
  }

  judge(
    input: RubricJudgeInput,
    options: RubricJudgeRunOptions = {},
  ): Promise<StructuredGenerationResult<RubricJudgment>> {
    return generateStructured({
      capabilityId: this.capabilityId,
      model: this.model,
      system: buildRubricJudgeSystemPrompt(this.rubric),
      userPrompt: buildRubricJudgeUserPrompt(input),
      validate: createRubricJudgmentValidator(this.rubric),
      maxTokens: this.maxTokens,
      temperature: this.temperature,
      trace: this.trace,
      signal: options.signal,
    });
  }
}

export function buildRubricJudgeSystemPrompt(rubric: RubricDefinition): string {
  const dimensions = rubric.dimensions
    .map((dimension) => {
      const scale = dimension.scale
        .map((level) => `  ${level.score} = ${level.description}`)
        .join('\n');
      return `${dimension.id} ${dimension.label}: ${dimension.description}\n${scale}`;
    })
    .join('\n\n');

  const verdicts = rubric.verdicts
    .map((rule) => `- ${rule.verdict}: ${rule.description}`)
    .join('\n');

  const checks = rubric.checks?.length
    ? `\nChecks to return as booleans:\n${rubric.checks.map((check) => `- ${check}`).join('\n')}\n`
    : '';

  const examples = rubric.calibrationExamples?.length
    ? `\nCalibration examples. Use these only to anchor the scoring scale; do not repeat them.\n${rubric.calibrationExamples
        .map((example) => `Input:\n${example.input}\nExpected:\n${example.expected}`)
        .join('\n\n')}\n`
    : '';

  const dimensionShape = Object.fromEntries(
    rubric.dimensions.map((dimension) => [dimension.id, { score: 0, reason: '' }]),
  );
  const checkShape = Object.fromEntries((rubric.checks ?? []).map((check) => [check, true]));
  const outputShape = {
    dimensions: dimensionShape,
    ...(rubric.checks?.length ? { checks: checkShape } : {}),
    verdict: rubric.verdicts[0]?.verdict ?? 'pass',
    fix: '',
    reasoning: '',
  };

  return [
    `You are a rubric judge for: ${rubric.title}.`,
    rubric.task,
    '',
    'Score the subject against the rubric. Score meaning and evidence, not style preferences unless the rubric asks for style.',
    'Never rewrite the subject. Return one highest-leverage fix, not a list.',
    '',
    'Rubric dimensions:',
    dimensions,
    '',
    'Allowed verdicts:',
    verdicts,
    checks.trimEnd(),
    examples.trimEnd(),
    '',
    'Output JSON only. No prose. No markdown fences. Use exactly this shape:',
    JSON.stringify(outputShape),
  ].filter(Boolean).join('\n');
}

export function buildRubricJudgeUserPrompt(input: RubricJudgeInput): string {
  const context = input.context && Object.keys(input.context).length > 0
    ? `Context:\n${Object.entries(input.context).map(([key, value]) => `${key}: ${value}`).join('\n')}\n\n`
    : '';
  return `${context}Subject:\n${input.subject}`;
}

export function createRubricJudgmentValidator(
  rubric: RubricDefinition,
): (value: unknown) => JsonValidation<RubricJudgment> {
  const dimensionIds = new Set(rubric.dimensions.map((dimension) => dimension.id));
  const verdicts = new Set(rubric.verdicts.map((rule) => rule.verdict));
  const scoreRanges = new Map(
    rubric.dimensions.map((dimension) => [
      dimension.id,
      {
        min: Math.min(...dimension.scale.map((level) => level.score)),
        max: Math.max(...dimension.scale.map((level) => level.score)),
      },
    ]),
  );

  return (value: unknown): JsonValidation<RubricJudgment> => {
    if (!isRecord(value)) return { ok: false, error: 'judgment must be an object' };
    if (!isRecord(value.dimensions)) return { ok: false, error: 'judgment.dimensions must be an object' };

    const dimensions: Record<string, RubricDimensionScore> = {};
    for (const id of dimensionIds) {
      const score = value.dimensions[id];
      if (!isRecord(score)) return { ok: false, error: `dimensions.${id} must be an object` };
      if (typeof score.score !== 'number') return { ok: false, error: `dimensions.${id}.score must be a number` };
      if (typeof score.reason !== 'string') return { ok: false, error: `dimensions.${id}.reason must be a string` };
      const range = scoreRanges.get(id);
      if (range && (score.score < range.min || score.score > range.max)) {
        return { ok: false, error: `dimensions.${id}.score must be between ${range.min} and ${range.max}` };
      }
      dimensions[id] = { score: score.score, reason: score.reason.trim() };
    }

    if (typeof value.verdict !== 'string' || !verdicts.has(value.verdict)) {
      return { ok: false, error: 'judgment.verdict is not allowed by the rubric' };
    }
    if (typeof value.fix !== 'string') return { ok: false, error: 'judgment.fix must be a string' };
    if (value.reasoning !== undefined && typeof value.reasoning !== 'string') {
      return { ok: false, error: 'judgment.reasoning must be a string when present' };
    }

    const checks = validateChecks(value.checks, rubric.checks);
    if (!checks.ok) return checks;

    return {
      ok: true,
      value: {
        dimensions,
        ...(checks.value ? { checks: checks.value } : {}),
        verdict: value.verdict,
        fix: value.fix.trim(),
        ...(value.reasoning ? { reasoning: value.reasoning.trim() } : {}),
      },
    };
  };
}

function validateChecks(
  value: unknown,
  expectedChecks?: readonly string[],
): JsonValidation<Record<string, boolean> | undefined> {
  if (!expectedChecks?.length) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, error: 'judgment.checks must be an object' };
  const checks: Record<string, boolean> = {};
  for (const check of expectedChecks) {
    if (typeof value[check] !== 'boolean') {
      return { ok: false, error: `checks.${check} must be a boolean` };
    }
    checks[check] = value[check];
  }
  return { ok: true, value: checks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
