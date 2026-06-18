import React from 'react';
import { FileCheck, History, Play, RefreshCw, Route, Save } from 'lucide-react';
import type { Anomaly as MonitoringAnomaly, CategoryCoverageItem } from '@aptkit/agent-anomaly-monitoring';
import { Panel } from './components';
import { ComparisonMetric } from './recommendation-panels';
import { formatCost, formatCostDelta, formatDelta, formatDuration, monitoringCategorySet } from './replay-artifacts';
import type {
  ComparableMonitoringReplay,
  CostEstimate,
  MonitoringComparisonState,
  MonitoringFixture,
  MonitoringPromoteResult,
  MonitoringReplayMode,
  MonitoringReplayState,
  PromotedMonitoringFixtureSummary,
  SavedMonitoringReplaySummary,
  TokenUsageSummary,
} from './types';

export function CoverageItem({ item }: { item: CategoryCoverageItem }) {
  return (
    <div className={`coverageItem ${item.coverage}`}>
      <div>
        <strong>{item.label}</strong>
        <span>{item.category}</span>
      </div>
      <em>{item.coverage}</em>
      {item.missing?.length ? <p>Missing {item.missing.join(', ')}</p> : null}
    </div>
  );
}

export function MonitoringAnomalyCard({ anomaly, index }: { anomaly: MonitoringAnomaly; index: number }) {
  return (
    <article className="monitoringAnomaly">
      <div className="recHeader">
        <div>
          <span className="feature">{anomaly.category ?? 'uncategorized'}</span>
          <h2>{anomaly.metric}</h2>
        </div>
        <span className={`severityPill ${anomaly.severity}`}>{anomaly.severity}</span>
      </div>
      <div className="anomalyMeta">
        <div>
          <span>Scope</span>
          <strong>{anomaly.scope.join(', ') || 'workspace'}</strong>
        </div>
        <div>
          <span>Change</span>
          <strong>{anomaly.change.direction} {anomaly.change.value}%</strong>
        </div>
        <div>
          <span>Baseline</span>
          <strong>{anomaly.change.baseline}</strong>
        </div>
        <div>
          <span>Evidence</span>
          <strong>{anomaly.evidence?.length ?? 0} item{anomaly.evidence?.length === 1 ? '' : 's'}</strong>
        </div>
      </div>
      {anomaly.impact ? <p>{anomaly.impact}</p> : null}
      <div className="evidencePreview">
        <span>Evidence {index + 1}</span>
        <code>{JSON.stringify(anomaly.evidence?.[0]?.result ?? anomaly.evidence?.[0] ?? {}, null, 2)}</code>
      </div>
    </article>
  );
}

export function MonitoringComparisonPanel({
  comparison,
  fixtureId,
  openaiAvailable,
  running,
  error,
  onRun,
}: {
  comparison: MonitoringComparisonState;
  fixtureId: string;
  openaiAvailable: boolean;
  running: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const fixtureReplay = comparison.fixture;
  const openaiReplay = comparison.openai;
  const fixtureCategories = monitoringCategorySet(fixtureReplay);
  const openaiCategories = monitoringCategorySet(openaiReplay);
  const sharedCategories = [...openaiCategories].filter((category) => fixtureCategories.has(category));
  const openaiOnlyCategories = [...openaiCategories].filter((category) => !fixtureCategories.has(category));
  const fixtureOnlyCategories = [...fixtureCategories].filter((category) => !openaiCategories.has(category));
  const tokenDelta = (openaiReplay?.usage.totalTokens ?? 0) - (fixtureReplay?.usage.totalTokens ?? 0);
  const costDelta = (openaiReplay?.costEstimate?.totalCost ?? 0) - (fixtureReplay?.costEstimate?.totalCost ?? 0);
  const maxAnomalies = Math.max(fixtureReplay?.anomalies.length ?? 0, openaiReplay?.anomalies.length ?? 0);

  return (
    <Panel title="Fixture vs OpenAI" icon={<Route size={17} />} wide>
      <div className="comparisonPanel">
        <div className="comparisonToolbar">
          <div>
            <strong>{fixtureId}</strong>
            <span>{comparison.completedAt ? `Comparison completed at ${comparison.completedAt}` : 'Latest saved fixture/OpenAI monitoring pair'}</span>
          </div>
          <button className="primaryAction" type="button" onClick={onRun} disabled={running || !openaiAvailable}>
            <Play size={15} />
            <span>{running ? 'Running' : 'Run Comparison'}</span>
          </button>
        </div>
        {!openaiAvailable ? <div className="errorState compact">Set OPENAI_API_KEY and restart Studio to enable comparison runs.</div> : null}
        {error ? <div className="errorState compact">{error}</div> : null}
        {!fixtureReplay || !openaiReplay ? (
          <div className="emptyState compact">Run comparison or save both fixture and OpenAI monitoring replays for this fixture.</div>
        ) : null}
        <div className="comparisonSummary">
          <ComparisonMetric label="Fixture Eval" value={fixtureReplay ? (fixtureReplay.evalOk ? 'pass' : 'fail') : 'missing'} tone={fixtureReplay?.evalOk ? 'good' : 'neutral'} />
          <ComparisonMetric label="OpenAI Eval" value={openaiReplay ? (openaiReplay.evalOk ? 'pass' : 'fail') : 'missing'} tone={openaiReplay?.evalOk ? 'good' : 'neutral'} />
          <ComparisonMetric label="Anomalies" value={formatDelta((openaiReplay?.anomalyCount ?? 0) - (fixtureReplay?.anomalyCount ?? 0))} />
          <ComparisonMetric label="Tokens" value={formatDelta(tokenDelta)} />
          <ComparisonMetric label="Est. Cost" value={formatCostDelta(costDelta)} />
          <ComparisonMetric label="Shared Categories" value={`${sharedCategories.length}`} />
        </div>
        <div className="featureDiff">
          <div>
            <span>Shared</span>
            <strong>{sharedCategories.join(', ') || 'none'}</strong>
          </div>
          <div>
            <span>Fixture only</span>
            <strong>{fixtureOnlyCategories.join(', ') || 'none'}</strong>
          </div>
          <div>
            <span>OpenAI only</span>
            <strong>{openaiOnlyCategories.join(', ') || 'none'}</strong>
          </div>
        </div>
        <div className="comparisonColumns">
          <MonitoringComparisonColumn title="Fixture" replay={fixtureReplay} />
          <MonitoringComparisonColumn title="OpenAI" replay={openaiReplay} />
        </div>
        {maxAnomalies > 0 ? (
          <div className="pairedRecommendations">
            {Array.from({ length: maxAnomalies }, (_, index) => (
              <div className="pairedRecommendation" key={`monitoring-pair-${index}`}>
                <MonitoringAnomalyPreview label={`Fixture ${index + 1}`} anomaly={fixtureReplay?.anomalies[index]} />
                <MonitoringAnomalyPreview label={`OpenAI ${index + 1}`} anomaly={openaiReplay?.anomalies[index]} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

export function MonitoringComparisonColumn({ title, replay }: { title: string; replay: ComparableMonitoringReplay | undefined }) {
  return (
    <div className="comparisonColumn">
      <div className="comparisonColumnHeader">
        <strong>{title}</strong>
        <span>{replay ? `${replay.provider.id} / ${replay.provider.model}` : 'missing'}</span>
      </div>
      <div className="historyMeta">
        <span>{replay?.anomalyCount ?? 0} anomalies</span>
        <span>{replay?.usage.totalTokens.toLocaleString() ?? '0'} tokens</span>
        <span>{formatCost(replay?.costEstimate)}</span>
        <span>{replay ? formatDuration(replay.durationMs) : '0ms'}</span>
      </div>
      {replay?.path ? <code>{replay.path}</code> : null}
    </div>
  );
}

export function MonitoringAnomalyPreview({ label, anomaly }: { label: string; anomaly: MonitoringAnomaly | undefined }) {
  return (
    <article className="recommendationPreview">
      <span>{label}</span>
      {anomaly ? (
        <>
          <strong>{anomaly.metric}</strong>
          <em>{anomaly.category ?? 'uncategorized'} / {anomaly.severity}</em>
          <p>{anomaly.scope.join(', ')} - {anomaly.change.direction} {anomaly.change.value}% vs {anomaly.change.baseline}</p>
        </>
      ) : (
        <strong>missing</strong>
      )}
    </article>
  );
}

export function MonitoringReviewPanel({
  fixture,
  mode,
  modelName,
  replay,
  savedReplay,
  usage,
  costEstimate,
  saving,
  saveError,
  error,
  promotingPath,
  promoteResult,
  onSave,
  onPromote,
}: {
  fixture: MonitoringFixture;
  mode: MonitoringReplayMode;
  modelName: string;
  replay: MonitoringReplayState | null;
  savedReplay: SavedMonitoringReplaySummary | undefined;
  usage: TokenUsageSummary;
  costEstimate: CostEstimate | undefined;
  saving: boolean;
  saveError: string | null;
  error: string | null;
  promotingPath: string | null;
  promoteResult: MonitoringPromoteResult | null;
  onSave: () => void;
  onPromote: (path: string) => void;
}) {
  const reviewPath = savedReplay?.path ?? replay?.savedPath;
  const evalOk = savedReplay?.evalOk ?? replay?.evalOk ?? false;
  const issues = savedReplay?.issues ?? replay?.evalIssueDetails ?? [];
  const reviewUsage = savedReplay?.usage ?? usage;
  const reviewCost = savedReplay?.costEstimate ?? costEstimate;
  const provider = savedReplay?.provider
    ? `${savedReplay.provider.id} / ${savedReplay.provider.model}`
    : `${mode} / ${modelName}`;
  const anomalyCount = savedReplay?.anomalyCount ?? replay?.anomalies.length ?? 0;
  const modelTurns = savedReplay?.modelTurns ?? replay?.modelTurns ?? 0;
  const canReview = Boolean(reviewPath && evalOk);

  return (
    <Panel title="Replay Review" icon={<FileCheck size={17} />}>
      <div className="reviewPanel">
        <div className={canReview ? 'reviewBanner ready' : 'reviewBanner pending'}>
          <strong>{canReview ? 'Ready for comparison' : reviewPath ? 'Needs passing eval' : 'Save before review'}</strong>
          <span>{reviewPath ?? 'No saved monitoring artifact selected'}</span>
        </div>
        <div className="reviewGrid">
          <div>
            <span>Fixture</span>
            <strong>{savedReplay?.fixture.id ?? fixture.id}</strong>
          </div>
          <div>
            <span>Provider</span>
            <strong>{provider}</strong>
          </div>
          <div>
            <span>Shape Eval</span>
            <strong>{evalOk ? 'passing' : 'not passing'}</strong>
          </div>
          <div>
            <span>Output</span>
            <strong>{anomalyCount} anomalies / {modelTurns} turns</strong>
          </div>
          <div>
            <span>Spend</span>
            <strong>{reviewUsage.totalTokens.toLocaleString()} tokens / {formatCost(reviewCost)}</strong>
          </div>
          <div>
            <span>Next</span>
            <strong>{canReview ? 'compare fixture/OpenAI' : 'save passing replay'}</strong>
          </div>
        </div>
        {issues.length ? (
          <ul className="issueList">
            {issues.slice(0, 3).map((issue) => (
              <li key={`${issue.path}-${issue.message}`}>{issue.path}: {issue.message}</li>
            ))}
          </ul>
        ) : null}
        {error ? <div className="errorState compact">{error}</div> : null}
        {saveError ? <div className="errorState compact">{saveError}</div> : null}
        {promoteResult ? (
          <div className="historySuccess">
            <strong>Promoted monitoring fixture</strong>
            <code>{promoteResult.path}</code>
          </div>
        ) : null}
        <div className="reviewActions">
          <button className="secondaryAction" type="button" onClick={onSave} disabled={!replay || saving}>
            <Save size={15} />
            <span>{saving ? 'Saving' : replay?.savedPath ? 'Saved Current' : 'Save Current'}</span>
          </button>
          <button
            className="primaryAction"
            type="button"
            onClick={() => reviewPath ? onPromote(reviewPath) : undefined}
            disabled={!canReview || promotingPath === reviewPath}
          >
            <FileCheck size={15} />
            <span>{promotingPath === reviewPath ? 'Promoting' : 'Promote Reviewed'}</span>
          </button>
        </div>
      </div>
    </Panel>
  );
}

export function MonitoringReplayHistoryPanel({
  replays,
  loading,
  error,
  selectedPath,
  onRefresh,
  onReview,
}: {
  replays: SavedMonitoringReplaySummary[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null | undefined;
  onRefresh: () => void;
  onReview: (path: string) => void;
}) {
  const visibleReplays = replays.slice(0, 5);
  return (
    <Panel title="Monitoring History" icon={<History size={17} />}>
      <div className="historyPanel">
        <button className="secondaryAction" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} />
          <span>{loading ? 'Checking' : 'Refresh History'}</span>
        </button>
        {error ? <div className="errorState compact">{error}</div> : null}
        {!loading && visibleReplays.length === 0 ? <div className="emptyState compact">No saved monitoring replays found.</div> : null}
        <div className="historyList">
          {visibleReplays.map((replay) => (
            <article className={selectedPath === replay.path ? 'historyItem selected' : 'historyItem'} key={replay.path}>
              <div className="historyHeader">
                <strong>{replay.fixture.id}</strong>
                <span className={replay.evalOk ? 'statusPill good' : 'statusPill bad'}>{replay.evalOk ? 'pass' : 'fail'}</span>
              </div>
              <div className="historyMeta">
                <span>{replay.provider.id} / {replay.provider.model}</span>
                <span>{replay.anomalyCount} anomalies</span>
                <span>{replay.usage.totalTokens.toLocaleString()} tokens</span>
                <span>{formatDuration(replay.durationMs)}</span>
              </div>
              <code>{replay.path}</code>
              {replay.issues.length ? (
                <ul className="issueList">
                  {replay.issues.slice(0, 2).map((issue) => (
                    <li key={`${replay.path}-${issue.path}-${issue.message}`}>{issue.path}: {issue.message}</li>
                  ))}
                </ul>
              ) : null}
              <button
                className="secondaryAction"
                type="button"
                onClick={() => onReview(replay.path)}
              >
                <FileCheck size={15} />
                <span>{selectedPath === replay.path ? 'Reviewing' : 'Review'}</span>
              </button>
            </article>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function PromotedMonitoringFixturesPanel({
  fixtures,
  loading,
  error,
  onRefresh,
}: {
  fixtures: PromotedMonitoringFixtureSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <Panel title="Promoted Monitoring" icon={<FileCheck size={17} />}>
      <div className="historyPanel">
        <button className="secondaryAction" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} />
          <span>{loading ? 'Checking' : 'Check Promoted'}</span>
        </button>
        {error ? <div className="errorState compact">{error}</div> : null}
        {!loading && fixtures.length === 0 ? <div className="emptyState compact">No promoted monitoring fixtures found.</div> : null}
        <div className="historyList">
          {fixtures.map((fixture) => (
            <article className="historyItem" key={fixture.path}>
              <div className="historyHeader">
                <strong>{fixture.id}</strong>
                <span className={fixture.ok ? 'statusPill good' : 'statusPill bad'}>{fixture.ok ? 'healthy' : 'failing'}</span>
              </div>
              <div className="historyMeta">
                <span>{fixture.anomalyCount} anomalies</span>
                <span>{fixture.modelTurns} turns</span>
                <span>{fixture.usage.totalTokens.toLocaleString()} tokens</span>
                <span>{formatCost(fixture.costEstimate)}</span>
                <span>{fixture.behaviorOk ? 'behavior pass' : 'behavior fail'}</span>
              </div>
              {fixture.promotion?.sourceProvider?.id ? (
                <div className="expectationBlock">
                  <span>Source</span>
                  <strong>{fixture.promotion.sourceProvider.id} / {fixture.promotion.sourceProvider.model ?? 'unknown'}</strong>
                </div>
              ) : null}
              {fixture.expectations ? (
                <div className="expectationBlock">
                  <span>Expectations</span>
                  <strong>{[
                    ...(fixture.expectations.requiredCategories ?? []).map((category) => `category:${category}`),
                    ...(fixture.expectations.requiredMetrics ?? []).map((metric) => `metric:${metric}`),
                    ...(fixture.expectations.requiredScopes ?? []).map((scope) => `scope:${scope}`),
                    ...(fixture.expectations.requiredSeverities ?? []).map((severity) => `severity:${severity}`),
                    fixture.expectations.minAnomalyCount !== undefined ? `min:${fixture.expectations.minAnomalyCount}` : '',
                  ].filter(Boolean).join(', ') || 'none'}</strong>
                </div>
              ) : null}
              <code>{fixture.path}</code>
              {fixture.issues.length ? (
                <ul className="issueList">
                  {fixture.issues.slice(0, 3).map((issue) => (
                    <li key={`${fixture.path}-${issue.source}-${issue.path}-${issue.message}`}>
                      {issue.source} / {issue.path}: {issue.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
        </div>
      </div>
    </Panel>
  );
}
