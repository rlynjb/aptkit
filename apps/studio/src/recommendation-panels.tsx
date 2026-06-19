import React from 'react';
import { Check, Clipboard, FileCheck, History, Play, RefreshCw, Route, Save } from 'lucide-react';
import type { Recommendation } from '@aptkit/agent-recommendation';
import { Panel, SaveReplayControl } from './components';
import { featureSet, formatCost, formatCostDelta, formatDelta, formatDuration } from './replay-artifacts';
import type { ComparableReplay, ComparisonState, CostEstimate, PromoteResult, RecommendationFixture, ReplayMode, ReplayState, SavedReplaySummary, TokenUsageSummary, PromotedFixtureSummary } from './types';

export function ComparisonPanel({
  comparison,
  fixtureId,
  openaiAvailable,
  running,
  error,
  onRun,
}: {
  comparison: ComparisonState;
  fixtureId: string;
  openaiAvailable: boolean;
  running: boolean;
  error: string | null;
  onRun: () => void;
}) {
  const fixtureReplay = comparison.fixture;
  const openaiReplay = comparison.openai;
  const fixtureFeatures = featureSet(fixtureReplay);
  const openaiFeatures = featureSet(openaiReplay);
  const sharedFeatures = [...openaiFeatures].filter((feature) => fixtureFeatures.has(feature));
  const openaiOnlyFeatures = [...openaiFeatures].filter((feature) => !fixtureFeatures.has(feature));
  const fixtureOnlyFeatures = [...fixtureFeatures].filter((feature) => !openaiFeatures.has(feature));
  const tokenDelta = (openaiReplay?.usage.totalTokens ?? 0) - (fixtureReplay?.usage.totalTokens ?? 0);
  const costDelta = (openaiReplay?.costEstimate?.totalCost ?? 0) - (fixtureReplay?.costEstimate?.totalCost ?? 0);
  const maxRecommendations = Math.max(fixtureReplay?.recommendations.length ?? 0, openaiReplay?.recommendations.length ?? 0);

  return (
    <Panel title="Fixture vs OpenAI" icon={<Route size={17} />} wide>
      <div className="comparisonPanel">
        <div className="comparisonToolbar">
          <div>
            <strong>{fixtureId}</strong>
            <span>{comparison.completedAt ? `Comparison completed at ${comparison.completedAt}` : 'Latest saved fixture/OpenAI pair'}</span>
          </div>
          <button className="primaryAction" type="button" onClick={onRun} disabled={running || !openaiAvailable}>
            <Play size={15} />
            <span>{running ? 'Running' : 'Run Comparison'}</span>
          </button>
        </div>
        {!openaiAvailable ? <div className="errorState compact">Set OPENAI_API_KEY and restart Studio to enable comparison runs.</div> : null}
        {error ? <div className="errorState compact">{error}</div> : null}
        {!fixtureReplay || !openaiReplay ? (
          <div className="emptyState compact">Run comparison or save both fixture and OpenAI replays for this fixture.</div>
        ) : null}
        <div className="comparisonSummary">
          <ComparisonMetric label="Fixture Eval" value={fixtureReplay ? (fixtureReplay.evalOk ? 'pass' : 'fail') : 'missing'} tone={fixtureReplay?.evalOk ? 'good' : 'neutral'} />
          <ComparisonMetric label="OpenAI Eval" value={openaiReplay ? (openaiReplay.evalOk ? 'pass' : 'fail') : 'missing'} tone={openaiReplay?.evalOk ? 'good' : 'neutral'} />
          <ComparisonMetric label="Recommendations" value={formatDelta((openaiReplay?.recommendationCount ?? 0) - (fixtureReplay?.recommendationCount ?? 0))} />
          <ComparisonMetric label="Tokens" value={formatDelta(tokenDelta)} />
          <ComparisonMetric label="Est. Cost" value={formatCostDelta(costDelta)} />
          <ComparisonMetric label="Shared Features" value={`${sharedFeatures.length}`} />
        </div>
        <div className="featureDiff">
          <div>
            <span>Shared</span>
            <strong>{sharedFeatures.join(', ') || 'none'}</strong>
          </div>
          <div>
            <span>Fixture only</span>
            <strong>{fixtureOnlyFeatures.join(', ') || 'none'}</strong>
          </div>
          <div>
            <span>OpenAI only</span>
            <strong>{openaiOnlyFeatures.join(', ') || 'none'}</strong>
          </div>
        </div>
        <div className="comparisonColumns">
          <ComparisonColumn title="Fixture" replay={fixtureReplay} />
          <ComparisonColumn title="OpenAI" replay={openaiReplay} />
        </div>
        {maxRecommendations > 0 ? (
          <div className="pairedRecommendations">
            {Array.from({ length: maxRecommendations }, (_, index) => (
              <div className="pairedRecommendation" key={`pair-${index}`}>
                <RecommendationPreview label={`Fixture ${index + 1}`} recommendation={fixtureReplay?.recommendations[index]} />
                <RecommendationPreview label={`OpenAI ${index + 1}`} recommendation={openaiReplay?.recommendations[index]} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

export function ComparisonMetric({ label, value, tone = 'neutral' }: { label: string; value: string; tone?: 'neutral' | 'good' }) {
  return (
    <div className={`comparisonMetric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ComparisonColumn({ title, replay }: { title: string; replay: ComparableReplay | undefined }) {
  return (
    <div className="comparisonColumn">
      <div className="comparisonColumnHeader">
        <strong>{title}</strong>
        <span>{replay ? `${replay.provider.id} / ${replay.provider.model}` : 'missing'}</span>
      </div>
      <div className="historyMeta">
        <span>{replay?.recommendationCount ?? 0} recs</span>
        <span>{replay?.usage.totalTokens.toLocaleString() ?? '0'} tokens</span>
        <span>{formatCost(replay?.costEstimate)}</span>
        <span>{replay ? formatDuration(replay.durationMs) : '0ms'}</span>
      </div>
      {replay?.path ? <code>{replay.path}</code> : null}
    </div>
  );
}

export function RecommendationPreview({ label, recommendation }: { label: string; recommendation: Recommendation | undefined }) {
  return (
    <article className="recommendationPreview">
      <span>{label}</span>
      {recommendation ? (
        <>
          <strong>{recommendation.title}</strong>
          <em>{recommendation.bloomreachFeature} / {recommendation.confidence}</em>
          <p>{recommendation.rationale}</p>
        </>
      ) : (
        <strong>missing</strong>
      )}
    </article>
  );
}

export function ReviewPanel({
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
  fixture: RecommendationFixture;
  mode: ReplayMode;
  modelName: string;
  replay: ReplayState | null;
  savedReplay: SavedReplaySummary | undefined;
  usage: TokenUsageSummary;
  costEstimate: CostEstimate | undefined;
  saving: boolean;
  saveError: string | null;
  error: string | null;
  promotingPath: string | null;
  promoteResult: PromoteResult | null;
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
  const recommendationCount = savedReplay?.recommendationCount ?? replay?.recommendations.length ?? 0;
  const modelTurns = savedReplay?.modelTurns ?? replay?.modelTurns ?? 0;
  const canPromote = Boolean(reviewPath && evalOk);

  return (
    <Panel title="Replay Review" icon={<FileCheck size={17} />}>
      <div className="reviewPanel">
        <div className={canPromote ? 'reviewBanner ready' : 'reviewBanner pending'}>
          <strong>{canPromote ? 'Ready to promote' : reviewPath ? 'Needs passing eval' : 'Save before promotion'}</strong>
          <span>{reviewPath ?? 'No saved artifact selected'}</span>
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
            <span>Behavior</span>
            <strong>{canPromote ? 'check after promotion' : 'pending'}</strong>
          </div>
          <div>
            <span>Output</span>
            <strong>{recommendationCount} recs / {modelTurns} turns</strong>
          </div>
          <div>
            <span>Spend</span>
            <strong>{reviewUsage.totalTokens.toLocaleString()} tokens / {formatCost(reviewCost)}</strong>
          </div>
        </div>
        {issues.length ? (
          <ul className="issueList">
            {issues.slice(0, 3).map((issue) => (
              <li key={`${issue.path}-${issue.message}`}>{issue.path}: {issue.message}</li>
            ))}
          </ul>
        ) : null}
        {promoteResult ? (
          <div className="historySuccess">
            <strong>Promoted fixture</strong>
            <code>{promoteResult.path}</code>
          </div>
        ) : null}
        {error ? <div className="errorState compact">{error}</div> : null}
        {saveError ? <div className="errorState compact">{saveError}</div> : null}
        <div className="reviewActions">
          <button className="secondaryAction" type="button" onClick={onSave} disabled={!replay || saving}>
            <Save size={15} />
            <span>{saving ? 'Saving' : replay?.savedPath ? 'Saved Current' : 'Save Current'}</span>
          </button>
          <button
            className="primaryAction"
            type="button"
            onClick={() => reviewPath ? onPromote(reviewPath) : undefined}
            disabled={!canPromote || promotingPath === reviewPath}
          >
            <FileCheck size={15} />
            <span>{promotingPath === reviewPath ? 'Promoting' : 'Promote Reviewed'}</span>
          </button>
        </div>
      </div>
    </Panel>
  );
}

export function WorkflowPanel({
  fixtureId,
  mode,
  replay,
  saving,
  saveError,
  onSave,
}: {
  fixtureId: string;
  mode: ReplayMode;
  replay: ReplayState | null;
  saving: boolean;
  saveError: string | null;
  onSave: () => void;
}) {
  const [copied, setCopied] = React.useState<string | null>(null);
  const artifactPath = replay?.savedPath ?? 'artifacts/replays/<replay>.json';
  const commands = [
    {
      id: 'live',
      label: 'Live replay',
      command: `npm run replay:model -- --provider openai --fixture ${fixtureId}`,
    },
    {
      id: 'eval',
      label: 'Evaluate replays',
      command: 'npm run eval:replays',
    },
    {
      id: 'promote',
      label: 'Promote reviewed replay',
      command: `npm run promote:replay -- ${artifactPath}`,
    },
    {
      id: 'regression',
      label: 'Regression replay',
      command: 'npm run replay:promoted -w @aptkit/agent-recommendation',
    },
  ];

  async function copyCommand(id: string, command: string) {
    await navigator.clipboard.writeText(command);
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1300);
  }

  return (
    <Panel title="Workflow" icon={<Route size={17} />}>
      <div className="workflow">
        <div className="layerCallout">
          <strong>{mode === 'fixture' ? 'Fake model + fake tools' : 'Real model + fake tools'}</strong>
          <span>{mode === 'fixture' ? 'Deterministic UI and regression replay.' : 'Live provider reasoning over controlled fixture data.'}</span>
        </div>
        <ol className="workflowSteps">
          <li>Run fixture</li>
          <li>Run OpenAI</li>
          <li>Save replay artifact</li>
          <li>Evaluate replay</li>
          <li>Promote reviewed replay</li>
          <li>Regression test promoted fixture</li>
        </ol>
        <SaveReplayControl
          canSave={Boolean(replay)}
          onSave={onSave}
          savedPath={replay?.savedPath}
          saveError={saveError}
          saving={saving}
        />
        <div className="commandList">
          {commands.map((item) => (
            <div className="commandRow" key={item.id}>
              <span>{item.label}</span>
              <code>{item.command}</code>
              <button
                aria-label={`Copy ${item.label} command`}
                title={`Copy ${item.label} command`}
                type="button"
                onClick={() => void copyCommand(item.id, item.command)}
              >
                {copied === item.id ? <Check size={15} /> : <Clipboard size={15} />}
              </button>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

export function ReplayHistoryPanel({
  replays,
  loading,
  error,
  selectedPath,
  onRefresh,
  onReview,
}: {
  replays: SavedReplaySummary[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null | undefined;
  onRefresh: () => void;
  onReview: (path: string) => void;
}) {
  const visibleReplays = replays.slice(0, 5);
  return (
    <Panel title="Replay History" icon={<History size={17} />}>
      <div className="historyPanel">
        <button className="secondaryAction" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} />
          <span>{loading ? 'Evaluating' : 'Evaluate Replays'}</span>
        </button>
        {error ? <div className="errorState compact">{error}</div> : null}
        {!loading && visibleReplays.length === 0 ? <div className="emptyState compact">No saved replays found.</div> : null}
        <div className="historyList">
          {visibleReplays.map((replay) => (
            <article className={selectedPath === replay.path ? 'historyItem selected' : 'historyItem'} key={replay.path}>
              <div className="historyHeader">
                <strong>{replay.fixture.id}</strong>
                <span className={replay.evalOk ? 'statusPill good' : 'statusPill bad'}>{replay.evalOk ? 'pass' : 'fail'}</span>
              </div>
              <div className="historyMeta">
                <span>{replay.provider.id} / {replay.provider.model}</span>
                <span>{replay.recommendationCount} recs</span>
                <span>{replay.usage.totalTokens.toLocaleString()} tokens</span>
                <span>{formatCost(replay.costEstimate)}</span>
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

export function PromotedFixturesPanel({
  fixtures,
  loading,
  error,
  onRefresh,
}: {
  fixtures: PromotedFixtureSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}) {
  return (
    <Panel title="Promoted Fixtures" icon={<FileCheck size={17} />}>
      <div className="historyPanel">
        <button className="secondaryAction" type="button" onClick={onRefresh} disabled={loading}>
          <RefreshCw size={15} />
          <span>{loading ? 'Checking' : 'Check Promoted'}</span>
        </button>
        {error ? <div className="errorState compact">{error}</div> : null}
        {!loading && fixtures.length === 0 ? <div className="emptyState compact">No promoted fixtures found.</div> : null}
        <div className="historyList">
          {fixtures.map((fixture) => (
            <article className="historyItem" key={fixture.path}>
              <div className="historyHeader">
                <strong>{fixture.id}</strong>
                <span className={fixture.ok ? 'statusPill good' : 'statusPill bad'}>{fixture.ok ? 'healthy' : 'failing'}</span>
              </div>
              <div className="historyMeta">
                <span>{fixture.recommendationCount} recs</span>
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
                    ...(fixture.expectations.requiredFeatures ?? []).map((feature) => `feature:${feature}`),
                    ...(fixture.expectations.requiredText ?? []).map((text) => `text:${text}`),
                  ].join(', ') || 'none'}</strong>
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
