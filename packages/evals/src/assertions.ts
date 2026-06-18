import { assertRequiredPaths, type StructuralDiffResult } from './structural-diff.js';

export type EvalAssertionResult = StructuralDiffResult & {
  name: string;
};

export function assertRecommendationShape(output: unknown): EvalAssertionResult {
  const result = assertRequiredPaths(output, [
    '0.title',
    '0.rationale',
    '0.bloomreachFeature',
    '0.steps',
    '0.estimatedImpact',
    '0.confidence',
  ]);
  return { name: 'recommendation-shape', ...result };
}

export function assertReplayArtifactShape(output: unknown): EvalAssertionResult {
  const result = assertRequiredPaths(output, [
    'schemaVersion',
    'createdAt',
    'durationMs',
    'provider.id',
    'provider.model',
    'fixture.id',
    'fixture.path',
    'recommendations',
    'trace',
    'eval.name',
    'eval.ok',
    'modelTurns',
  ]);
  const issues = [...result.issues];

  if (!isRecord(output)) {
    return {
      name: 'replay-artifact-shape',
      ok: false,
      issues: [{ path: '', message: 'artifact must be an object' }, ...issues],
    };
  }

  if (output.schemaVersion !== 1) {
    issues.push({ path: 'schemaVersion', message: 'expected schemaVersion 1' });
  }

  if (typeof output.createdAt !== 'string' || Number.isNaN(Date.parse(output.createdAt))) {
    issues.push({ path: 'createdAt', message: 'expected an ISO timestamp string' });
  }

  if (typeof output.durationMs !== 'number' || output.durationMs < 0) {
    issues.push({ path: 'durationMs', message: 'expected a non-negative number' });
  }

  if (typeof output.modelTurns !== 'number' || output.modelTurns < 0) {
    issues.push({ path: 'modelTurns', message: 'expected a non-negative number' });
  }

  if (!Array.isArray(output.trace)) {
    issues.push({ path: 'trace', message: 'expected an array' });
  }

  const recommendations = output.recommendations;
  if (!Array.isArray(recommendations)) {
    issues.push({ path: 'recommendations', message: 'expected an array' });
  } else {
    const recommendationResult = assertRecommendationShape(recommendations);
    for (const issue of recommendationResult.issues) {
      issues.push({ path: `recommendations.${issue.path}`, message: issue.message });
    }
  }

  const replayEval = output.eval;
  if (!isRecord(replayEval) || replayEval.ok !== true) {
    issues.push({ path: 'eval.ok', message: 'expected embedded replay eval to pass' });
  }

  const secretIssue = findSecretLikeString(output);
  if (secretIssue) {
    issues.push(secretIssue);
  }

  return { name: 'replay-artifact-shape', ok: issues.length === 0, issues };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function findSecretLikeString(value: unknown, path = ''): { path: string; message: string } | null {
  if (typeof value === 'string') {
    if (/sk-[A-Za-z0-9_-]{10,}/.test(value) || /OPENAI_API_KEY\s*=/.test(value)) {
      return { path, message: 'artifact contains a secret-like string' };
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = findSecretLikeString(value[index], path ? `${path}.${index}` : String(index));
      if (issue) return issue;
    }
    return null;
  }

  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      const issue = findSecretLikeString(child, path ? `${path}.${key}` : key);
      if (issue) return issue;
    }
  }

  return null;
}
