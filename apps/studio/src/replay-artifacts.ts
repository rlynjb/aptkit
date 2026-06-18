import { estimateCost, formatCost, pricingForModel, summarizeUsage } from '@aptkit/runtime';
import type { CapabilityEvent } from '@aptkit/runtime';
import { ECOMMERCE_ANOMALY_CATEGORIES, formatCategoryChecklist, runnableCategories, schemaCapabilities } from '@aptkit/agent-anomaly-monitoring';
import { schemaSummary } from '@aptkit/context';
import { diagnosticPromptPackage, monitoringPromptPackage, queryPromptPackage, recommendationPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import type { PromptPackage } from '@aptkit/prompts';
import monitoringFixture from '../../../packages/agents/anomaly-monitoring/fixtures/sp-revenue-monitoring.json';
import diagnosticFixture from '../../../packages/agents/diagnostic-investigation/fixtures/sp-revenue-diagnostic.json';
import queryFixture from '../../../packages/agents/query/fixtures/revenue-by-state-query.json';
import electronicsSpikeFixture from '../../../packages/agents/recommendation/fixtures/electronics-spike.json';
import spRevenueDropFixture from '../../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
import voucherDropoffFixture from '../../../packages/agents/recommendation/fixtures/voucher-dropoff.json';
import type { ComparableMonitoringReplay, ComparableReplay, ComparisonState, CostEstimate, DiagnosticFixture, DiagnosticReplayArtifact, DiagnosticReplayMode, DiagnosticReplayState, MonitoringComparisonState, MonitoringFixture, MonitoringReplayMode, MonitoringReplayArtifact, MonitoringReplayResult, MonitoringReplayState, PromptPackageProvenance, QueryFixture, QueryReplayArtifact, QueryReplayMode, QueryReplayState, RecommendationFixture, ReplayArtifact, ReplayMode, ReplayResult, ReplayState, SavedMonitoringReplaySummary, SavedReplaySummary, TokenUsageSummary } from './types';

export function buildQueryReplayArtifact(
  fixture: QueryFixture,
  replay: QueryReplayState,
  mode: QueryReplayMode,
  fallbackModel: string,
): QueryReplayArtifact {
  const usage = summarizeUsage(replay.trace);
  const modelName = usage.modelName || fallbackModel;
  const costEstimate = estimateCost(mode, usage, modelName);
  return {
    schemaVersion: 1,
    capabilityId: 'query-agent',
    createdAt: new Date().toISOString(),
    durationMs: replay.durationMs,
    provider: {
      id: mode,
      model: modelName,
    },
    fixture: {
      id: fixture.id,
      description: fixture.description,
      path: queryFixturePath(fixture.id),
    },
    promptPackage: promptPackageProvenance(
      queryPromptPackage,
      renderPromptTemplate(queryPromptPackage.system, {
        schema: schemaSummary(fixture.workspace),
        project_id: fixture.workspace.projectId,
        intent: fixture.intent,
      }),
    ),
    question: fixture.question,
    intent: fixture.intent,
    answer: replay.answer,
    trace: replay.trace,
    ...(costEstimate ? { costEstimate } : {}),
    eval: {
      name: 'query-answer-shape',
      ok: replay.evalOk,
      issues: replay.evalIssueDetails,
    },
    modelTurns: replay.modelTurns,
  };
}

export function queryFixturePath(fixtureId: string): string {
  const knownPaths: Record<string, string> = {
    [queryFixture.id]: 'packages/agents/query/fixtures/revenue-by-state-query.json',
  };
  return knownPaths[fixtureId] ?? `packages/agents/query/fixtures/${fixtureId}.json`;
}

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
    promptPackage: promptPackageProvenance(
      diagnosticPromptPackage,
      renderPromptTemplate(diagnosticPromptPackage.system, {
        schema: schemaSummary(fixture.workspace),
        project_id: fixture.workspace.projectId,
        anomaly: JSON.stringify(fixture.anomaly),
      }),
    ),
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
    promptPackage: promptPackageProvenance(
      monitoringPromptPackage,
      renderPromptTemplate(monitoringPromptPackage.system, {
        schema: schemaSummary(fixture.workspace, { horizonStyle: 'plain', eventHeading: 'Top events:' }),
        categories: formatCategoryChecklist(runnableCategories(ECOMMERCE_ANOMALY_CATEGORIES, schemaCapabilities(fixture.workspace))),
      }),
    ),
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
    promptPackage: promptPackageProvenance(
      recommendationPromptPackage,
      renderPromptTemplate(recommendationPromptPackage.system, {
        schema: schemaSummary(fixture.workspace),
        project_id: fixture.workspace.projectId,
        diagnosis: JSON.stringify(fixture.diagnosis),
      }),
    ),
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

export function promptPackageProvenance(
  promptPackage: PromptPackage,
  renderedPrompt: string,
): PromptPackageProvenance {
  return {
    id: promptPackage.id,
    version: promptPackage.version,
    capabilityId: promptPackage.capabilityId,
    templateHash: stableTextHash(promptPackage.system),
    templateChars: promptPackage.system.length,
    renderedHash: stableTextHash(renderedPrompt),
    renderedChars: renderedPrompt.length,
  };
}

export function stableTextHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export { estimateCost, formatCost, pricingForModel, summarizeUsage };

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
  return replay ? { ...replay, usage: normalizeUsageSummary(replay.usage) } : undefined;
}

export function latestMonitoringReplayFor(
  replays: SavedMonitoringReplaySummary[],
  fixtureId: string,
  providerId: string,
): ComparableMonitoringReplay | undefined {
  const replay = replays.find((candidate) => candidate.fixture.id === fixtureId && candidate.provider.id === providerId);
  return replay ? { ...replay, usage: normalizeUsageSummary(replay.usage) } : undefined;
}

function normalizeUsageSummary(
  usage: Pick<TokenUsageSummary, 'inputTokens' | 'outputTokens' | 'totalTokens'> & Partial<TokenUsageSummary>,
): TokenUsageSummary {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    modelName: usage.modelName ?? '',
    turns: usage.turns ?? 0,
    estimated: usage.estimated ?? false,
  };
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
