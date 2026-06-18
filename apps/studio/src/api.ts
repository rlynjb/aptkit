import type { DiagnosticFixture, DiagnosticPromoteResult, DiagnosticReplayArtifact, DiagnosticReplayMode, DiagnosticReplayResult, MonitoringFixture, MonitoringPromoteResult, MonitoringReplayResult, MonitoringReplayMode, MonitoringReplayArtifact, PromoteResult, PromotedDiagnosticFixtureSummary, PromotedFixtureSummary, PromotedMonitoringFixtureSummary, PromotedQueryFixtureSummary, QueryFixture, QueryPromoteResult, QueryReplayArtifact, QueryReplayMode, QueryReplayResult, RecommendationFixture, ReplayArtifact, ReplayMode, ReplayResult, SavedDiagnosticReplaySummary, SavedMonitoringReplaySummary, SavedQueryReplaySummary, SavedReplaySummary } from './types';

export async function runServerQueryReplay(
  fixture: QueryFixture,
  mode: Exclude<QueryReplayMode, 'fixture'>,
): Promise<QueryReplayResult> {
  const response = await fetch('/api/query/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId: fixture.id, mode }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'query replay failed');
  }
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

export async function runServerDiagnosticReplay(
  fixture: DiagnosticFixture,
  mode: Exclude<DiagnosticReplayMode, 'fixture'>,
): Promise<DiagnosticReplayResult> {
  const response = await fetch('/api/diagnostic/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId: fixture.id, mode }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'diagnostic replay failed');
  }
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

export async function runServerMonitoringReplay(
  fixture: MonitoringFixture,
  mode: Exclude<MonitoringReplayMode, 'fixture'>,
): Promise<MonitoringReplayResult> {
  const response = await fetch('/api/monitoring/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId: fixture.id, mode }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'monitoring replay failed');
  }
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

export async function runServerReplay(fixture: RecommendationFixture, mode: Exclude<ReplayMode, 'fixture'>): Promise<ReplayResult> {
  const response = await fetch('/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId: fixture.id, mode }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'live replay failed');
  }
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
