import { createRubricJudgmentValidator, type RubricDefinition } from '@aptkit/evals';
import type { JsonValidation } from '@aptkit/runtime';
import type { RubricImprovementResult } from './types.js';

export function validateRubricImprovementResult(
  rubric: RubricDefinition,
): (value: unknown) => JsonValidation<RubricImprovementResult> {
  const validateJudgment = createRubricJudgmentValidator(rubric);
  const dimensionIds = new Set(rubric.dimensions.map((dimension) => dimension.id));

  return (value: unknown): JsonValidation<RubricImprovementResult> => {
    if (!isRecord(value)) return { ok: false, error: 'result must be an object' };

    const judgment = validateJudgment(value.judgment);
    if (!judgment.ok) return { ok: false, error: `judgment: ${judgment.error}` };

    if (typeof value.weakestDimension !== 'string' || !dimensionIds.has(value.weakestDimension)) {
      return { ok: false, error: 'weakestDimension must match a rubric dimension id' };
    }

    if (typeof value.nextAction !== 'string' || value.nextAction.trim().length === 0) {
      return { ok: false, error: 'nextAction must be a non-empty string' };
    }

    const nextDrill = validateNextDrill(value.nextDrill);
    if (!nextDrill.ok) return nextDrill;

    return {
      ok: true,
      value: {
        judgment: judgment.value,
        weakestDimension: value.weakestDimension,
        nextAction: value.nextAction.trim(),
        ...(nextDrill.value ? { nextDrill: nextDrill.value } : {}),
      },
    };
  };
}

function validateNextDrill(value: unknown): JsonValidation<RubricImprovementResult['nextDrill']> {
  if (value === undefined || value === null) return { ok: true, value: undefined };
  if (!isRecord(value)) return { ok: false, error: 'nextDrill must be an object when present' };
  if (typeof value.prompt !== 'string' || value.prompt.trim().length === 0) {
    return { ok: false, error: 'nextDrill.prompt must be a non-empty string' };
  }
  if (typeof value.goal !== 'string' || value.goal.trim().length === 0) {
    return { ok: false, error: 'nextDrill.goal must be a non-empty string' };
  }
  return {
    ok: true,
    value: {
      prompt: value.prompt.trim(),
      goal: value.goal.trim(),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
