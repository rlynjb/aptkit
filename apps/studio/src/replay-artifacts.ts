import type { CapabilityEvent } from '@aptkit/runtime';
import monitoringFixture from '../../../packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json';
import diagnosticFixture from '../../../packages/agents/diagnostic-investigation/fixtures/sp-revenue-diagnostic.json';
import electronicsSpikeFixture from '../../../packages/agents/recommendation/fixtures/electronics-spike.json';
import spRevenueDropFixture from '../../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
import voucherDropoffFixture from '../../../packages/agents/recommendation/fixtures/voucher-dropoff.json';
import type { ComparableMonitoringReplay, ComparableReplay, ComparisonState, CostEstimate, DiagnosticFixture, DiagnosticReplayArtifact, DiagnosticReplayMode, DiagnosticReplayState, MonitoringComparisonState, MonitoringFixture, MonitoringReplayMode, MonitoringReplayArtifact, MonitoringReplayResult, MonitoringReplayState, RecommendationFixture, ReplayArtifact, ReplayMode, ReplayResult, ReplayState, SavedMonitoringReplaySummary, SavedReplaySummary, TokenUsageSummary } from './types';

export function buildDiagnosticReplayArtifact(
  fixture: DiagnosticFixture,
  replay: DiagnosticReplayState,
  mode: DiagnosticReplayMode,
  fallbackModel: string,
): DiagnosticReplayArtifact {
  const usage = summarizeUsage(replay.trace);
  const modelName = usage.modelName || fallbackModel;
  const costEstimate = estimateCost(mode, usage, modelName);
  return {
    schemaVersion: 1,
    capabilityId: 'diagnostic-investigation-agent',
    createdAt: new Date().toISOString(),
    durationMs: replay.durationMs,
    provider: {
      id: mode,
      model: modelName,
    },
    fixture: {
      id: fixture.id,
      description: fixture.description,
      path: diagnosticFixturePath(fixture.id),
    },
    diagnosis: replay.diagnosis,
    trace: replay.trace,
    ...(costEstimate ? { costEstimate } : {}),
    eval: {
      name: 'diagnosis-shape',
      ok: replay.evalOk,
      issues: replay.evalIssueDetails,
    },
    modelTurns: replay.modelTurns,
  };
}

export function diagnosticFixturePath(fixtureId: string): string {
  const knownPaths: Record<string, string> = {
    [diagnosticFixture.id]: 'packages/agents/diagnostic-investigation/fixtures/sp-revenue-diagnostic.json',
  };
  return knownPaths[fixtureId] ?? `packages/agents/diagnostic-investigation/fixtures/${fixtureId}.json`;
}

export function buildMonitoringReplayArtifact(
  fixture: MonitoringFixture,
  replay: MonitoringReplayState,
  mode: MonitoringReplayMode,
  fallbackModel: string,
): MonitoringReplayArtifact {
  const usage = summarizeUsage(replay.trace);
  const modelName = usage.modelName || fallbackModel;
  const costEstimate = estimateCost(mode, usage, modelName);
  return {
    schemaVersion: 1,
    capabilityId: 'anomaly-monitoring-agent',
    createdAt: new Date().toISOString(),
    durationMs: replay.durationMs,
    provider: {
      id: mode,
      model: modelName,
    },
    fixture: {
      id: fixture.id,
      description: fixture.description,
      path: monitoringFixturePath(fixture.id),
    },
    anomalies: replay.anomalies,
    trace: replay.trace,
    ...(costEstimate ? { costEstimate } : {}),
    eval: {
      name: 'anomaly-shape',
      ok: replay.evalOk,
      issues: replay.evalIssueDetails,
    },
    modelTurns: replay.modelTurns,
  };
}

export function monitoringFixturePath(fixtureId: string): string {
  const knownPaths: Record<string, string> = {
    [monitoringFixture.id]: 'packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json',
  };
  return knownPaths[fixtureId] ?? `packages/agents/anomaly-monitoring/fixtures/${fixtureId}.json`;
}

export function buildReplayArtifact(
  fixture: RecommendationFixture,
  replay: ReplayState,
  mode: ReplayMode,
  fallbackModel: string,
): ReplayArtifact {
  const usage = summarizeUsage(replay.trace);
  const modelName = usage.modelName || fallbackModel;
  const costEstimate = estimateCost(mode, usage, modelName);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    durationMs: replay.durationMs,
    provider: {
      id: mode,
      model: modelName,
    },
    fixture: {
      id: fixture.id,
      description: fixture.description,
      path: fixturePath(fixture.id),
    },
    recommendations: replay.recommendations,
    trace: replay.trace,
    ...(costEstimate ? { costEstimate } : {}),
    eval: {
      name: 'recommendation-shape',
      ok: replay.evalOk,
      issues: replay.evalIssueDetails,
    },
    modelTurns: replay.modelTurns,
  };
}

export function fixturePath(fixtureId: string): string {
  const knownPaths: Record<string, string> = {
    [spRevenueDropFixture.id]: 'packages/agents/recommendation/fixtures/sp-revenue-drop.json',
    [electronicsSpikeFixture.id]: 'packages/agents/recommendation/fixtures/electronics-spike.json',
    [voucherDropoffFixture.id]: 'packages/agents/recommendation/fixtures/voucher-dropoff.json',
  };
  return knownPaths[fixtureId] ?? `packages/agents/recommendation/fixtures/${fixtureId}.json`;
}

export function summarizeUsage(trace: CapabilityEvent[]) {
  return trace.reduce(
    (summary, event) => {
      if (event.type !== 'model_usage') return summary;
      return {
        inputTokens: summary.inputTokens + (event.inputTokens ?? 0),
        outputTokens: summary.outputTokens + (event.outputTokens ?? 0),
        totalTokens: summary.totalTokens + (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
        modelName: event.model || summary.modelName,
      };
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelName: '' },
  );
}

export function estimateCost(provider: string, usage: TokenUsageSummary, modelName: string): CostEstimate | undefined {
  const pricing = pricingForModel(provider, modelName);
  if (!pricing) return undefined;
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.inputUsdPerMillion;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPerMillion;
  return {
    currency: 'USD',
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    inputUsdPerMillion: pricing.inputUsdPerMillion,
    outputUsdPerMillion: pricing.outputUsdPerMillion,
    estimated: true,
  };
}

export function pricingForModel(provider: string, modelName: string): Pick<CostEstimate, 'inputUsdPerMillion' | 'outputUsdPerMillion'> | undefined {
  if (provider !== 'openai') return undefined;
  const normalized = modelName.toLowerCase();
  if (normalized.startsWith('gpt-4.1-nano')) return { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.4 };
  if (normalized.startsWith('gpt-4.1-mini')) return { inputUsdPerMillion: 0.4, outputUsdPerMillion: 1.6 };
  if (normalized.startsWith('gpt-4.1')) return { inputUsdPerMillion: 2, outputUsdPerMillion: 8 };
  return undefined;
}

export function formatCost(costEstimate: CostEstimate | undefined): string {
  if (!costEstimate) return 'n/a';
  if (costEstimate.totalCost === 0) return '$0.00';
  if (costEstimate.totalCost < 0.01) return `$${costEstimate.totalCost.toFixed(4)}`;
  return `$${costEstimate.totalCost.toFixed(2)}`;
}

export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

export function toReplayState(result: ReplayResult, runId: number): ReplayState {
  return {
    ...result,
    runId,
    completedAt: new Date().toLocaleTimeString(),
  };
}

export function toMonitoringReplayState(result: MonitoringReplayResult, runId: number): MonitoringReplayState {
  return {
    ...result,
    runId,
    completedAt: new Date().toLocaleTimeString(),
  };
}

export function comparableFromArtifact(artifact: ReplayArtifact, path: string): ComparableReplay {
  const usage = summarizeUsage(artifact.trace);
  return {
    path,
    createdAt: artifact.createdAt,
    provider: artifact.provider,
    fixture: artifact.fixture,
    evalOk: artifact.eval.ok,
    issues: artifact.eval.issues,
    recommendations: artifact.recommendations,
    recommendationCount: artifact.recommendations.length,
    durationMs: artifact.durationMs,
    modelTurns: artifact.modelTurns,
    usage,
    costEstimate: artifact.costEstimate,
  };
}

export function comparableMonitoringFromArtifact(artifact: MonitoringReplayArtifact, path: string): ComparableMonitoringReplay {
  const usage = summarizeUsage(artifact.trace);
  return {
    path,
    createdAt: artifact.createdAt,
    provider: artifact.provider,
    fixture: artifact.fixture,
    evalOk: artifact.eval.ok,
    issues: artifact.eval.issues,
    anomalies: artifact.anomalies,
    anomalyCount: artifact.anomalies.length,
    durationMs: artifact.durationMs,
    modelTurns: artifact.modelTurns,
    usage,
    costEstimate: artifact.costEstimate,
  };
}

export function comparisonForFixture(
  comparison: ComparisonState | null,
  replays: SavedReplaySummary[],
  fixtureId: string,
): ComparisonState {
  if (comparison?.fixture?.fixture.id === fixtureId || comparison?.openai?.fixture.id === fixtureId) {
    return comparison;
  }
  return {
    fixture: latestReplayFor(replays, fixtureId, 'fixture'),
    openai: latestReplayFor(replays, fixtureId, 'openai'),
    completedAt: '',
  };
}

export function comparisonForMonitoringFixture(
  comparison: MonitoringComparisonState | null,
  replays: SavedMonitoringReplaySummary[],
  fixtureId: string,
): MonitoringComparisonState {
  if (comparison?.fixture?.fixture.id === fixtureId || comparison?.openai?.fixture.id === fixtureId) {
    return comparison;
  }
  return {
    fixture: latestMonitoringReplayFor(replays, fixtureId, 'fixture'),
    openai: latestMonitoringReplayFor(replays, fixtureId, 'openai'),
    completedAt: '',
  };
}

export function latestReplayFor(replays: SavedReplaySummary[], fixtureId: string, providerId: string): ComparableReplay | undefined {
  const replay = replays.find((candidate) => candidate.fixture.id === fixtureId && candidate.provider.id === providerId);
  return replay ? { ...replay } : undefined;
}

export function latestMonitoringReplayFor(
  replays: SavedMonitoringReplaySummary[],
  fixtureId: string,
  providerId: string,
): ComparableMonitoringReplay | undefined {
  const replay = replays.find((candidate) => candidate.fixture.id === fixtureId && candidate.provider.id === providerId);
  return replay ? { ...replay } : undefined;
}

export function featureSet(replay: ComparableReplay | undefined): Set<string> {
  return new Set((replay?.recommendations ?? []).map((recommendation) => recommendation.bloomreachFeature));
}

export function monitoringCategorySet(replay: ComparableMonitoringReplay | undefined): Set<string> {
  return new Set((replay?.anomalies ?? []).map((anomaly) => anomaly.category ?? 'uncategorized'));
}

export function formatDelta(value: number, formatter: (value: number) => string = (next) => next.toLocaleString()): string {
  if (value === 0) return 'same';
  return `${value > 0 ? '+' : ''}${formatter(value)}`;
}

export function formatCostDelta(value: number): string {
  if (value === 0) return 'same';
  return `${value > 0 ? '+' : '-'}${formatCost({ currency: 'USD', inputCost: 0, outputCost: 0, totalCost: Math.abs(value), inputUsdPerMillion: 0, outputUsdPerMillion: 0, estimated: true })}`;
}

export function findReviewReplay(
  replays: SavedReplaySummary[],
  selectedPath: string | null,
  currentSavedPath: string | undefined,
  fixtureId: string,
  mode: ReplayMode,
): SavedReplaySummary | undefined {
  if (selectedPath) {
    const selected = replays.find((replay) => replay.path === selectedPath);
    if (selected) return selected;
  }
  if (currentSavedPath) {
    const current = replays.find((replay) => replay.path === currentSavedPath);
    if (current) return current;
  }
  return replays.find((replay) => replay.fixture.id === fixtureId && replay.provider.id === mode);
}

export function findMonitoringReviewReplay(
  replays: SavedMonitoringReplaySummary[],
  selectedPath: string | null,
  currentSavedPath: string | undefined,
  fixtureId: string,
  mode: MonitoringReplayMode,
): SavedMonitoringReplaySummary | undefined {
  if (selectedPath) {
    const selected = replays.find((replay) => replay.path === selectedPath);
    if (selected) return selected;
  }
  if (currentSavedPath) {
    const current = replays.find((replay) => replay.path === currentSavedPath);
    if (current) return current;
  }
  return replays.find((replay) => replay.fixture.id === fixtureId && replay.provider.id === mode);
}
