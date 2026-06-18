import type { StructuralIssue } from './structural-diff.js';

export type DetectionLike = {
  category?: string;
  metric?: string;
  scope?: readonly string[];
  severity?: string;
};

export type DetectionExpectations = {
  minCount?: number;
  maxCount?: number;
  requiredCategories?: readonly string[];
  requiredMetrics?: readonly string[];
  requiredScopes?: readonly string[];
  requiredSeverities?: readonly string[];
};

export type DetectionScoreResult = {
  ok: boolean;
  score: number;
  matched: string[];
  missed: string[];
  unexpected: string[];
  issues: StructuralIssue[];
};

/** Scores detection-like outputs against expected categories, metrics, scopes, severities, and counts. */
export function scoreDetections(
  detections: readonly DetectionLike[],
  expectations: DetectionExpectations = {},
): DetectionScoreResult {
  const required = [
    ...(expectations.requiredCategories ?? []).map((value) => ({ kind: 'category', value })),
    ...(expectations.requiredMetrics ?? []).map((value) => ({ kind: 'metric', value })),
    ...(expectations.requiredScopes ?? []).map((value) => ({ kind: 'scope', value })),
    ...(expectations.requiredSeverities ?? []).map((value) => ({ kind: 'severity', value })),
  ];
  const matched: string[] = [];
  const missed: string[] = [];
  const issues: StructuralIssue[] = [];

  const minCount = expectations.minCount ?? 0;
  if (detections.length < minCount) {
    issues.push({ path: 'expectations.minCount', message: `expected at least ${minCount} detections, got ${detections.length}` });
  }
  if (expectations.maxCount !== undefined && detections.length > expectations.maxCount) {
    issues.push({ path: 'expectations.maxCount', message: `expected at most ${expectations.maxCount} detections, got ${detections.length}` });
  }

  for (const requirement of required) {
    const label = `${requirement.kind}:${requirement.value}`;
    if (matchesRequirement(detections, requirement.kind, requirement.value)) {
      matched.push(label);
    } else {
      missed.push(label);
      issues.push({
        path: expectationPath(requirement.kind),
        message: `expected ${requirement.kind}=${requirement.value}`,
      });
    }
  }

  const expectedCategories = new Set(expectations.requiredCategories ?? []);
  const unexpected = detections
    .map((detection) => detection.category)
    .filter((category): category is string => typeof category === 'string' && category.length > 0)
    .filter((category) => expectedCategories.size > 0 && !expectedCategories.has(category))
    .map((category) => `category:${category}`);

  const requirementCount = required.length + (minCount > 0 ? 1 : 0) + (expectations.maxCount !== undefined ? 1 : 0);
  const failedCount = missed.length + issues.filter((issue) => issue.path === 'expectations.minCount' || issue.path === 'expectations.maxCount').length;
  const score = requirementCount === 0 ? 1 : Math.max(0, (requirementCount - failedCount) / requirementCount);

  return {
    ok: issues.length === 0,
    score,
    matched,
    missed,
    unexpected: [...new Set(unexpected)],
    issues,
  };
}

function matchesRequirement(detections: readonly DetectionLike[], kind: string, value: string): boolean {
  return detections.some((detection) => {
    if (kind === 'category') return detection.category === value;
    if (kind === 'metric') return detection.metric === value;
    if (kind === 'scope') return detection.scope?.includes(value) ?? false;
    if (kind === 'severity') return detection.severity === value;
    return false;
  });
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function expectationPath(kind: string): string {
  if (kind === 'category') return 'expectations.requiredCategories';
  if (kind === 'severity') return 'expectations.requiredSeverities';
  return `expectations.required${capitalize(kind)}s`;
}
