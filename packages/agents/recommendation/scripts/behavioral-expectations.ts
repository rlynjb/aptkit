import type { Recommendation } from '../src/types.js';

export type BehavioralExpectations = {
  requiredFeatures?: string[];
  requiredText?: string[];
};

export type BehavioralExpectationIssue = {
  path: string;
  message: string;
};

export type BehavioralExpectationResult = {
  name: 'recommendation-behavior';
  ok: boolean;
  issues: BehavioralExpectationIssue[];
};

export function assertBehavioralExpectations(
  recommendations: Recommendation[],
  expectations: BehavioralExpectations | undefined,
): BehavioralExpectationResult {
  const issues: BehavioralExpectationIssue[] = [];
  if (!expectations) return { name: 'recommendation-behavior', ok: true, issues };

  for (const feature of expectations.requiredFeatures ?? []) {
    if (!recommendations.some((recommendation) => recommendation.bloomreachFeature === feature)) {
      issues.push({
        path: 'expectations.requiredFeatures',
        message: `expected at least one recommendation with bloomreachFeature=${feature}`,
      });
    }
  }

  const haystack = recommendations.map(recommendationSearchText).join('\n').toLowerCase();
  for (const text of expectations.requiredText ?? []) {
    if (!haystack.includes(text.toLowerCase())) {
      issues.push({
        path: 'expectations.requiredText',
        message: `expected recommendation text to include "${text}"`,
      });
    }
  }

  return { name: 'recommendation-behavior', ok: issues.length === 0, issues };
}

function recommendationSearchText(recommendation: Recommendation): string {
  return [
    recommendation.title,
    recommendation.rationale,
    recommendation.bloomreachFeature,
    ...recommendation.steps,
    typeof recommendation.estimatedImpact === 'string'
      ? recommendation.estimatedImpact
      : [
          recommendation.estimatedImpact.range,
          recommendation.estimatedImpact.assumption,
        ].join(' '),
    recommendation.successMetric,
    ...(recommendation.prerequisites ?? []).map((prerequisite) => prerequisite.label),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
}
