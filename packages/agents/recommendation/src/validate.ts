import { parseAgentJson } from '@aptkit/runtime';
import type { ActionTaxonomy, IdlessRecommendation } from './types.js';

const CONFIDENCE = ['high', 'medium', 'low'];
const EFFORT = ['low', 'medium', 'high'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isEstimatedImpact(value: unknown): boolean {
  if (typeof value === 'string') return true;
  return isRecord(value) && typeof value.range === 'string';
}

function isPrerequisite(value: unknown): boolean {
  return isRecord(value) && typeof value.label === 'string' && typeof value.satisfied === 'boolean';
}

export function isRecommendationArray(
  value: unknown,
  taxonomy: ActionTaxonomy,
): value is IdlessRecommendation[] {
  return Array.isArray(value) && value.every((item) => {
    if (!isRecord(item)) return false;
    if (typeof item.title !== 'string') return false;
    if (typeof item.rationale !== 'string') return false;
    if (!taxonomy.features.includes(item.bloomreachFeature as never)) return false;
    if (!Array.isArray(item.steps) || !item.steps.every((step) => typeof step === 'string')) return false;
    if (!isEstimatedImpact(item.estimatedImpact)) return false;
    if (!CONFIDENCE.includes(String(item.confidence))) return false;
    if (item.effort !== undefined && !EFFORT.includes(String(item.effort))) return false;
    if (item.timeToSetUpMinutes !== undefined && typeof item.timeToSetUpMinutes !== 'number') return false;
    if (item.readResultInDays !== undefined && typeof item.readResultInDays !== 'number') return false;
    if (
      item.prerequisites !== undefined &&
      (!Array.isArray(item.prerequisites) || !item.prerequisites.every(isPrerequisite))
    ) {
      return false;
    }
    if (item.successMetric !== undefined && typeof item.successMetric !== 'string') return false;
    return true;
  });
}

export function tryParseRecommendations(
  text: string,
  taxonomy: ActionTaxonomy,
): IdlessRecommendation[] | null {
  try {
    const parsed = parseAgentJson(text);
    return isRecommendationArray(parsed, taxonomy) ? parsed : null;
  } catch {
    return null;
  }
}
