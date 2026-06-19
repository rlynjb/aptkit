import { decodeNdjsonStream } from '@aptkit/runtime';
import type { CapabilityEvent } from '@aptkit/runtime';
import type { DiagnosticFixture, DiagnosticPromoteResult, DiagnosticReplayArtifact, DiagnosticReplayMode, DiagnosticReplayResult, MonitoringFixture, MonitoringPromoteResult, MonitoringReplayResult, MonitoringReplayMode, MonitoringReplayArtifact, PromoteResult, PromotedDiagnosticFixtureSummary, PromotedFixtureSummary, PromotedMonitoringFixtureSummary, PromotedQueryFixtureSummary, QueryFixture, QueryPromoteResult, QueryReplayArtifact, QueryReplayMode, QueryReplayResult, RecommendationFixture, ReplayArtifact, ReplayMode, ReplayResult, RubricImprovementFixture, RubricImprovementReplayMode, RubricImprovementReplayResult, SavedDiagnosticReplaySummary, SavedMonitoringReplaySummary, SavedQueryReplaySummary, SavedReplaySummary } from './types';
import type { ProviderStatus } from './types';

type StreamReplayOptions = {
  onEvent?: (event: CapabilityEvent) => void;
};

export async function loadProviderStatus(): Promise<ProviderStatus> {
  const response = await fetch('/api/model-status');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load model status failed');
  }
  return payload.providers;
}

export async function runServerQueryReplay(
  fixture: QueryFixture,
  mode: Exclude<QueryReplayMode, 'fixture'>,
  options: StreamReplayOptions = {},
): Promise<QueryReplayResult> {
  return runReplayStream('/api/stream/query/replay', fixture.id, mode, toQueryReplayResult, options);
}

export async function runServerRubricImprovementReplay(
  fixture: RubricImprovementFixture,
  mode: Exclude<RubricImprovementReplayMode, 'fixture'>,
  options: StreamReplayOptions = {},
): Promise<RubricImprovementReplayResult> {
  return runReplayStream('/api/stream/rubric-improvement/replay', fixture.id, mode, toRubricImprovementReplayResult, options);
}

export async function runServerDiagnosticReplay(
  fixture: DiagnosticFixture,
  mode: Exclude<DiagnosticReplayMode, 'fixture'>,
  options: StreamReplayOptions = {},
): Promise<DiagnosticReplayResult> {
  return runReplayStream('/api/stream/diagnostic/replay', fixture.id, mode, toDiagnosticReplayResult, options);
}

export async function runServerMonitoringReplay(
  fixture: MonitoringFixture,
  mode: Exclude<MonitoringReplayMode, 'fixture'>,
  options: StreamReplayOptions = {},
): Promise<MonitoringReplayResult> {
  return runReplayStream('/api/stream/monitoring/replay', fixture.id, mode, toMonitoringReplayResult, options);
}

export async function runServerReplay(
  fixture: RecommendationFixture,
  mode: Exclude<ReplayMode, 'fixture'>,
  options: StreamReplayOptions = {},
): Promise<ReplayResult> {
  return runReplayStream('/api/stream/replay', fixture.id, mode, toReplayResult, options);
}

function toQueryReplayResult(payload: any): QueryReplayResult {
  return {
    answer: payload.answer,
    trace: payload.trace,
    evalOk: payload.eval.ok,
    evalIssueDetails: payload.eval.issues,
    evalIssues: payload.eval.issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`),
    modelTurns: payload.modelTurns,
    durationMs: payload.durationMs,
  };
}

function toRubricImprovementReplayResult(payload: any): RubricImprovementReplayResult {
  return {
    result: payload.result,
    trace: payload.trace,
    evalOk: payload.eval.ok,
    evalIssueDetails: payload.eval.issues,
    evalIssues: payload.eval.issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`),
    modelTurns: payload.modelTurns,
    durationMs: payload.durationMs,
  };
}

function toDiagnosticReplayResult(payload: any): DiagnosticReplayResult {
  return {
    diagnosis: payload.diagnosis,
    trace: payload.trace,
    evalOk: payload.eval.ok,
    evalIssueDetails: payload.eval.issues,
    evalIssues: payload.eval.issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`),
    modelTurns: payload.modelTurns,
    durationMs: payload.durationMs,
  };
}

function toMonitoringReplayResult(payload: any): MonitoringReplayResult {
  return {
    anomalies: payload.anomalies,
    trace: payload.trace,
    evalOk: payload.eval.ok,
    evalIssueDetails: payload.eval.issues,
    evalIssues: payload.eval.issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`),
    modelTurns: payload.modelTurns,
    durationMs: payload.durationMs,
  };
}

function toReplayResult(payload: any): ReplayResult {
  return {
    recommendations: payload.recommendations,
    trace: payload.trace,
    evalOk: payload.eval.ok,
    evalIssueDetails: payload.eval.issues,
    evalIssues: payload.eval.issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`),
    modelTurns: payload.modelTurns,
    durationMs: payload.durationMs,
  };
}

async function runReplayStream<T>(
  endpoint: string,
  fixtureId: string,
  mode: string,
  mapResult: (payload: any) => T,
  options: StreamReplayOptions,
): Promise<T> {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId, mode }),
  });

  if (!response.body) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error ?? 'streaming replay failed');
  }

  let finalPayload: any = null;
  for await (const record of decodeNdjsonStream(responseBodyChunks(response.body))) {
    if (!record.ok) {
      options.onEvent?.({
        type: 'warning',
        capabilityId: 'studio-stream',
        message: `Malformed stream record on line ${record.warning.line}: ${record.warning.error}`,
        timestamp: new Date().toISOString(),
      });
      continue;
    }
    const value = record.value;
    if (!isRecord(value) || typeof value.type !== 'string') continue;
    if (value.type === 'event' && isCapabilityEventRecord(value.event)) {
      options.onEvent?.(value.event);
      continue;
    }
    if (value.type === 'result') {
      finalPayload = value.result;
      continue;
    }
    if (value.type === 'error') {
      throw new Error(typeof value.error === 'string' ? value.error : 'streaming replay failed');
    }
  }

  if (!response.ok) throw new Error('streaming replay failed');
  if (!finalPayload) throw new Error('streaming replay ended without a result');
  return mapResult(finalPayload);
}

/** Adapts browser ReadableStream chunks to the runtime NDJSON decoder's async-iterable input. */
async function* responseBodyChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

function isCapabilityEventRecord(value: unknown): value is CapabilityEvent {
  return isRecord(value)
    && typeof value.type === 'string'
    && typeof value.capabilityId === 'string'
    && typeof value.timestamp === 'string';
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null;
}

export async function saveReplayArtifact(artifact: ReplayArtifact | MonitoringReplayArtifact | DiagnosticReplayArtifact | QueryReplayArtifact): Promise<string> {
  const response = await fetch('/api/replay/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artifact }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'save replay failed');
  }
  return payload.path;
}

export async function loadSavedReplays(): Promise<SavedReplaySummary[]> {
  const response = await fetch('/api/replays');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load replays failed');
  }
  return payload.replays.filter((replay: SavedReplaySummary) => !replay.capabilityId || replay.capabilityId === 'recommendation-agent');
}

export async function loadSavedMonitoringReplays(): Promise<SavedMonitoringReplaySummary[]> {
  const response = await fetch('/api/replays');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load monitoring replays failed');
  }
  return payload.replays.filter((replay: SavedMonitoringReplaySummary) => replay.capabilityId === 'anomaly-monitoring-agent');
}

export async function loadSavedDiagnosticReplays(): Promise<SavedDiagnosticReplaySummary[]> {
  const response = await fetch('/api/replays');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load diagnostic replays failed');
  }
  return payload.replays.filter((replay: SavedDiagnosticReplaySummary) => replay.capabilityId === 'diagnostic-investigation-agent');
}

export async function loadSavedQueryReplays(): Promise<SavedQueryReplaySummary[]> {
  const response = await fetch('/api/replays');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load query replays failed');
  }
  return payload.replays.filter((replay: SavedQueryReplaySummary) => replay.capabilityId === 'query-agent');
}

export async function promoteReplay(path: string): Promise<PromoteResult> {
  const response = await fetch('/api/replays/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'promote replay failed');
  }
  return payload;
}

export async function promoteMonitoringReplay(path: string): Promise<MonitoringPromoteResult> {
  const response = await fetch('/api/monitoring/replays/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'promote monitoring replay failed');
  }
  return payload;
}

export async function promoteDiagnosticReplay(path: string): Promise<DiagnosticPromoteResult> {
  const response = await fetch('/api/diagnostic/replays/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'promote diagnostic replay failed');
  }
  return payload;
}

export async function promoteQueryReplay(path: string): Promise<QueryPromoteResult> {
  const response = await fetch('/api/query/replays/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'promote query replay failed');
  }
  return payload;
}

export async function loadPromotedFixtures(): Promise<PromotedFixtureSummary[]> {
  const response = await fetch('/api/promoted-fixtures');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load promoted fixtures failed');
  }
  return payload.fixtures;
}

export async function loadPromotedMonitoringFixtures(): Promise<PromotedMonitoringFixtureSummary[]> {
  const response = await fetch('/api/promoted-monitoring-fixtures');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load promoted monitoring fixtures failed');
  }
  return payload.fixtures;
}

export async function loadPromotedDiagnosticFixtures(): Promise<PromotedDiagnosticFixtureSummary[]> {
  const response = await fetch('/api/promoted-diagnostic-fixtures');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load promoted diagnostic fixtures failed');
  }
  return payload.fixtures;
}

export async function loadPromotedQueryFixtures(): Promise<PromotedQueryFixtureSummary[]> {
  const response = await fetch('/api/promoted-query-fixtures');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load promoted query fixtures failed');
  }
  return payload.fixtures;
}
