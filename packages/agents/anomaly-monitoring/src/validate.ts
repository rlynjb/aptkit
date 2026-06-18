import { parseValidatedJson } from '@aptkit/runtime';
import type { Anomaly, Severity } from './types.js';

const severities: Severity[] = ['critical', 'warning', 'info', 'positive'];

export function validateAnomalies(value: unknown): { ok: true; value: Anomaly[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: 'expected anomaly array' };
  for (const [index, anomaly] of value.entries()) {
    if (!anomaly || typeof anomaly !== 'object') return { ok: false, error: `${index}: expected object` };
    const candidate = anomaly as Record<string, unknown>;
    if (typeof candidate.metric !== 'string') return { ok: false, error: `${index}.metric must be string` };
    if (!Array.isArray(candidate.scope) || !candidate.scope.every((item) => typeof item === 'string')) {
      return { ok: false, error: `${index}.scope must be string[]` };
    }
    if (!candidate.change || typeof candidate.change !== 'object') return { ok: false, error: `${index}.change must be object` };
    const change = candidate.change as Record<string, unknown>;
    if (typeof change.value !== 'number') return { ok: false, error: `${index}.change.value must be number` };
    if (change.direction !== 'up' && change.direction !== 'down') return { ok: false, error: `${index}.change.direction invalid` };
    if (typeof change.baseline !== 'string') return { ok: false, error: `${index}.change.baseline must be string` };
    if (!severities.includes(candidate.severity as Severity)) return { ok: false, error: `${index}.severity invalid` };
    if ('evidence' in candidate && !Array.isArray(candidate.evidence)) return { ok: false, error: `${index}.evidence must be array` };
  }
  return { ok: true, value: value as Anomaly[] };
}

export function tryParseAnomalies(text: string): Anomaly[] | null {
  const parsed = parseValidatedJson(text, validateAnomalies);
  return parsed.ok ? parsed.value : null;
}
