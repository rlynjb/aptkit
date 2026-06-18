import { parseAgentJson } from '@aptkit/runtime';
import type { Diagnosis } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isHypothesis(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.hypothesis === 'string' &&
    typeof value.supported === 'boolean' &&
    typeof value.reasoning === 'string'
  );
}

function isAffectedCustomers(value: unknown): boolean {
  return isRecord(value) && typeof value.count === 'number' && typeof value.segmentDescription === 'string';
}

function isTimeSeriesPoint(value: unknown): boolean {
  return isRecord(value) && typeof value.day === 'string' && typeof value.value === 'number';
}

export function isDiagnosis(value: unknown): value is Diagnosis {
  if (!isRecord(value)) return false;
  if (typeof value.conclusion !== 'string') return false;
  if (!Array.isArray(value.evidence) || !value.evidence.every((item) => typeof item === 'string')) return false;
  if (!Array.isArray(value.hypothesesConsidered) || !value.hypothesesConsidered.every(isHypothesis)) {
    return false;
  }
  if (value.affectedCustomers !== undefined && !isAffectedCustomers(value.affectedCustomers)) return false;
  if (value.timeSeries !== undefined && (!Array.isArray(value.timeSeries) || !value.timeSeries.every(isTimeSeriesPoint))) {
    return false;
  }
  if (value.confidence !== undefined && !['high', 'medium', 'low'].includes(String(value.confidence))) return false;
  return true;
}

export function tryParseDiagnosis(text: string): Diagnosis | null {
  try {
    const parsed = parseAgentJson(text);
    return isDiagnosis(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function validateDiagnosis(diagnosis: unknown) {
  if (isDiagnosis(diagnosis)) return { ok: true as const };
  return { ok: false as const, error: 'diagnosis must match the expected structured output shape' };
}
