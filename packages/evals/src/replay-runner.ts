import { readdir, readFile } from 'node:fs/promises';
import { extname, join, relative, resolve } from 'node:path';
import { assertCapabilityReplayArtifactShape, type EvalAssertionResult } from './assertions.js';

export type ReplayArtifactEvalSummary = {
  path: string;
  ok: boolean;
  issues: EvalAssertionResult['issues'];
  capabilityId: string;
  provider: unknown;
  fixture: string | null;
  recommendationCount: number | null;
  anomalyCount: number | null;
  diagnosisPresent: boolean | null;
  answerPresent: boolean | null;
};

export type ReplayArtifactEvalReport = {
  ok: boolean;
  checked: number;
  failed: number;
  results: ReplayArtifactEvalSummary[];
  message?: string;
};

export type EvaluateReplayArtifactFilesOptions = {
  cwd?: string;
};

/** Lists replay artifact JSON files in deterministic filename order. */
export async function listReplayArtifacts(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return [];
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile() && extname(entry.name) === '.json')
    .map((entry) => join(dir, entry.name))
    .sort();
}

/** Evaluates one parsed replay artifact and returns the CLI/Studio summary fields. */
export function evaluateReplayArtifact(artifact: unknown, path: string): ReplayArtifactEvalSummary {
  const result = assertCapabilityReplayArtifactShape(artifact);
  return {
    path,
    ok: result.ok,
    issues: result.issues,
    capabilityId: isRecord(artifact) && typeof artifact.capabilityId === 'string'
      ? artifact.capabilityId
      : 'recommendation-agent',
    provider: isRecord(artifact) ? artifact.provider : undefined,
    fixture: isRecord(artifact) && isRecord(artifact.fixture) && typeof artifact.fixture.id === 'string'
      ? artifact.fixture.id
      : null,
    recommendationCount: isRecord(artifact) && Array.isArray(artifact.recommendations)
      ? artifact.recommendations.length
      : null,
    anomalyCount: isRecord(artifact) && Array.isArray(artifact.anomalies) ? artifact.anomalies.length : null,
    diagnosisPresent: isRecord(artifact) && artifact.diagnosis && typeof artifact.diagnosis === 'object' ? true : null,
    answerPresent: isRecord(artifact) && typeof artifact.answer === 'string' ? artifact.answer.trim().length > 0 : null,
  };
}

/** Reads and evaluates replay artifact files, preserving the aggregate CLI report shape. */
export async function evaluateReplayArtifactFiles(
  paths: readonly string[],
  options: EvaluateReplayArtifactFilesOptions = {},
): Promise<ReplayArtifactEvalReport> {
  if (paths.length === 0) {
    return { ok: true, checked: 0, failed: 0, results: [], message: 'no replay artifacts found' };
  }

  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const results: ReplayArtifactEvalSummary[] = [];

  for (const path of paths) {
    const raw = await readFile(path, 'utf8');
    const artifact = JSON.parse(raw) as unknown;
    results.push(evaluateReplayArtifact(artifact, relativePath(cwd, path)));
  }

  const failed = results.filter((result) => !result.ok);
  return {
    ok: failed.length === 0,
    checked: results.length,
    failed: failed.length,
    results,
  };
}

function relativePath(cwd: string, path: string): string {
  const absolute = resolve(path);
  const relativePathFromCwd = relative(cwd, absolute);
  return relativePathFromCwd.startsWith('..') ? absolute : relativePathFromCwd;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
