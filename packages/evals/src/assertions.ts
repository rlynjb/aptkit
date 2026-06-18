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
