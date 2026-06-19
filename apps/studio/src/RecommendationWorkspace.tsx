import React from 'react';
import { Activity, BadgeCheck, Boxes, BrainCircuit, CircleDollarSign, Gauge, Route, Timer } from 'lucide-react';
import { recommendationPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { schemaSummary } from '@aptkit/context';
import { fixtures } from './fixtures';
import { loadPromotedFixtures, loadSavedReplays, promoteReplay, runServerReplay, saveReplayArtifact } from './api';
import { AgentReplayShell, type AgentReplayShellContext } from './AgentReplayShell';
import { runFixtureReplay } from './agent-runners';
import { EvalPanel, Metric, Panel, PromptPackagePanel, ProviderStatusPanel, TracePanel } from './components';
import { buildReplayArtifact, comparableFromArtifact, comparisonForFixture, findReviewReplay, formatCost, formatDuration, toReplayState } from './replay-artifacts';
import { ComparisonPanel, PromotedFixturesPanel, ReplayHistoryPanel, ReviewPanel, WorkflowPanel } from './recommendation-panels';
import type { ComparisonState, PromoteResult, PromotedFixtureSummary, RecommendationFixture, ReplayMode, ReplayResult, SavedReplaySummary } from './types';

type RecommendationShellResult = ReplayResult & { savedPath?: string };

type RecommendationShellContext = AgentReplayShellContext<
RecommendationFixture,
ReplayMode,
RecommendationShellResult
>;

export function RecommendationWorkspace({ onHome }: { onHome: () => void }) {
  const [resetToken, setResetToken] = React.useState(0);

  return (
    <AgentReplayShell
      ariaLabel="Replay mode"
      fixtures={fixtures}
      getFixtureId={(fixture) => fixture.id}
      initialMode="fixture"
      metricItems={recommendationMetrics}
      modes={[
        { mode: 'fixture', label: 'Fixture' },
        { mode: 'anthropic', label: 'Anthropic' },
        { mode: 'openai', label: 'OpenAI' },
      ]}
      onFixtureChange={() => setResetToken((current) => current + 1)}
      onHome={onHome}
      onModeChange={() => setResetToken((current) => current + 1)}
      renderPanels={(context) => <RecommendationPanels context={context} resetToken={resetToken} />}
      runFixture={runFixtureReplay}
      runServer={runServerReplay}
      title="Recommendation Agent Replay"
    />
  );
}

function recommendationMetrics(context: RecommendationShellContext) {
  return (
    <>
      <Metric icon={<BadgeCheck size={18} />} label="Eval" value={context.error ? 'Error' : context.replay?.evalOk ? 'Passing' : context.running ? 'Running' : 'Pending'} tone={context.replay?.evalOk ? 'good' : 'neutral'} />
      <Metric icon={<BrainCircuit size={18} />} label="Model" value={context.modelName} />
      <Metric icon={<Gauge size={18} />} label="Tokens" value={context.usage.totalTokens.toLocaleString()} />
      <Metric icon={<CircleDollarSign size={18} />} label="Est. Cost" value={formatCost(context.costEstimate)} />
      <Metric icon={<Timer size={18} />} label="Duration" value={context.replay ? formatDuration(context.replay.durationMs) : context.running ? 'Running' : '0ms'} />
      <Metric icon={<Boxes size={18} />} label="Run" value={`#${context.runId || context.replay?.runId || 0}`} />
    </>
  );
}

function RecommendationPanels({ context, resetToken }: { context: RecommendationShellContext; resetToken: number }) {
  const { error, fixture, mode, providerStatus, replay, running, setReplay, usage, visibleTrace } = context;
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedReplays, setSavedReplays] = React.useState<SavedReplaySummary[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [selectedReviewPath, setSelectedReviewPath] = React.useState<string | null>(null);
  const [comparison, setComparison] = React.useState<ComparisonState | null>(null);
  const [comparisonRunning, setComparisonRunning] = React.useState(false);
  const [comparisonError, setComparisonError] = React.useState<string | null>(null);
  const [promotingPath, setPromotingPath] = React.useState<string | null>(null);
  const [promoteResult, setPromoteResult] = React.useState<PromoteResult | null>(null);
  const [promotedFixtures, setPromotedFixtures] = React.useState<PromotedFixtureSummary[]>([]);
  const [promotedLoading, setPromotedLoading] = React.useState(false);
  const [promotedError, setPromotedError] = React.useState<string | null>(null);
  const comparisonRunCounter = React.useRef(0);

  React.useEffect(() => {
    setSaveError(null);
    setComparison(null);
    setComparisonError(null);
    setPromoteResult(null);
  }, [resetToken]);

  const refreshReplayHistory = React.useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setSavedReplays(await loadSavedReplays());
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshReplayHistory();
  }, [refreshReplayHistory]);

  const refreshPromotedFixtures = React.useCallback(async () => {
    setPromotedLoading(true);
    setPromotedError(null);
    try {
      setPromotedFixtures(await loadPromotedFixtures());
    } catch (caught) {
      setPromotedError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPromotedLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshPromotedFixtures();
  }, [refreshPromotedFixtures]);

  async function saveCurrentReplay() {
    if (!replay) return;
    setSaving(true);
    setSaveError(null);
    try {
      const artifact = buildReplayArtifact(fixture, replay, mode, providerStatus[mode].model);
      const savedPath = await saveReplayArtifact(artifact);
      setReplay((current) => current ? { ...current, savedPath } : current);
      setSelectedReviewPath(savedPath);
      await refreshReplayHistory();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function promoteSavedReplay(path: string) {
    setPromotingPath(path);
    setHistoryError(null);
    setPromoteResult(null);
    try {
      const result = await promoteReplay(path);
      setPromoteResult(result);
      await refreshPromotedFixtures();
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPromotingPath(null);
    }
  }

  async function runComparison() {
    setComparisonRunning(true);
    setComparisonError(null);
    setSaveError(null);
    setPromoteResult(null);
    try {
      const baseRunId = Math.max(context.runId, comparisonRunCounter.current);
      const fixtureRunId = baseRunId + 1;
      comparisonRunCounter.current = fixtureRunId;
      const fixtureResult = await runFixtureReplay(fixture);
      const fixtureState = toReplayState(fixtureResult, fixtureRunId);
      const fixtureArtifact = buildReplayArtifact(fixture, fixtureState, 'fixture', providerStatus.fixture.model);
      const fixturePath = await saveReplayArtifact(fixtureArtifact);

      const openaiRunId = fixtureRunId + 1;
      comparisonRunCounter.current = openaiRunId;
      const openaiResult = await runServerReplay(fixture, 'openai');
      const openaiState = {
        ...toReplayState(openaiResult, openaiRunId),
        savedPath: '',
      };
      const openaiArtifact = buildReplayArtifact(fixture, openaiState, 'openai', providerStatus.openai.model);
      const openaiPath = await saveReplayArtifact(openaiArtifact);
      const completedAt = new Date().toLocaleTimeString();

      context.selectMode('openai');
      context.setRunId(openaiRunId);
      setReplay({ ...openaiState, savedPath: openaiPath, completedAt });
      setSelectedReviewPath(openaiPath);
      setComparison({
        fixture: comparableFromArtifact(fixtureArtifact, fixturePath),
        openai: comparableFromArtifact(openaiArtifact, openaiPath),
        completedAt,
      });
      await refreshReplayHistory();
    } catch (caught) {
      setComparisonError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setComparisonRunning(false);
    }
  }

  const reviewReplay = findReviewReplay(savedReplays, selectedReviewPath, replay?.savedPath, fixture.id, mode);
  const comparisonView = comparisonForFixture(comparison, savedReplays, fixture.id);
  const renderedPrompt = renderPromptTemplate(recommendationPromptPackage.system, {
    schema: schemaSummary(fixture.workspace),
    project_id: fixture.workspace.projectId,
    diagnosis: JSON.stringify(fixture.diagnosis),
  });

  return (
    <div className="layout">
        <section className="leftPane">
          <Panel title="Fixture" icon={<Boxes size={17} />}>
            <div className="kv">
              <span>ID</span>
              <strong>{fixture.id}</strong>
              <span>Case</span>
              <strong>{fixture.description}</strong>
              <span>Status</span>
              <strong>{error ? 'error' : running ? 'running' : replay ? `completed at ${replay.completedAt}` : 'not run'}</strong>
              <span>Mode</span>
              <strong>{mode} / {providerStatus[mode].model}{providerStatus[mode].available ? '' : ' unavailable'}</strong>
              <span>Workspace</span>
              <strong>{fixture.workspace.projectName}</strong>
              <span>Input</span>
              <strong>{usage.inputTokens.toLocaleString()} tokens</strong>
              <span>Output</span>
              <strong>{usage.outputTokens.toLocaleString()} tokens</strong>
              <span>Cost</span>
              <strong>{formatCost(context.costEstimate)}</strong>
              <span>Horizon</span>
              <strong>{fixture.workspace.dataHorizon?.from} to {fixture.workspace.dataHorizon?.to}</strong>
            </div>
          </Panel>

          <Panel title="Anomaly" icon={<Activity size={17} />}>
            <div className="anomalyGrid">
              <div>
                <span>Metric</span>
                <strong>{fixture.anomaly.metric}</strong>
              </div>
              <div>
                <span>Change</span>
                <strong>{fixture.anomaly.change.direction} {fixture.anomaly.change.value}%</strong>
              </div>
              <div>
                <span>Scope</span>
                <strong>{fixture.anomaly.scope.join(', ')}</strong>
              </div>
              <div>
                <span>Severity</span>
                <strong>{fixture.anomaly.severity}</strong>
              </div>
            </div>
            <p className="bodyText">{fixture.anomaly.impact}</p>
          </Panel>

          <Panel title="Diagnosis" icon={<Route size={17} />}>
            <p className="bodyText">{fixture.diagnosis.conclusion}</p>
            <ul className="evidenceList">
              {fixture.diagnosis.evidence.map((evidence) => (
                <li key={evidence}>{evidence}</li>
              ))}
            </ul>
          </Panel>
        </section>

        <section className="mainPane">
          <Panel title="Recommendations" icon={<CircleDollarSign size={17} />} wide>
            {running ? <div className="emptyState">Running {mode === 'fixture' ? 'fixture replay' : `${mode} live replay`}...</div> : null}
            {!providerStatus[mode].available ? <div className="errorState">Set {mode === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'} and restart Studio to enable this mode.</div> : null}
            {error ? <div className="errorState">{error}</div> : null}
            {!running && !error && !replay ? <div className="emptyState">No replay output yet.</div> : null}
            <div className="recommendations">
              {(replay?.recommendations ?? []).map((recommendation) => (
                <article className="recommendation" key={recommendation.id}>
                  <div className="recHeader">
                    <div>
                      <span className="feature">{recommendation.bloomreachFeature}</span>
                      <h2>{recommendation.title}</h2>
                    </div>
                    <span className="confidence">{recommendation.confidence}</span>
                  </div>
                  <p>{recommendation.rationale}</p>
                  <div className="impact">
                    <strong>{typeof recommendation.estimatedImpact === 'string' ? recommendation.estimatedImpact : recommendation.estimatedImpact.range}</strong>
                    {typeof recommendation.estimatedImpact !== 'string' && (
                      <span>{recommendation.estimatedImpact.assumption}</span>
                    )}
                  </div>
                  <ol>
                    {recommendation.steps.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                </article>
              ))}
            </div>
          </Panel>

          <ComparisonPanel
            comparison={comparisonView}
            fixtureId={fixture.id}
            openaiAvailable={providerStatus.openai.available}
            running={comparisonRunning}
            error={comparisonError}
            onRun={() => void runComparison()}
          />
        </section>

        <aside className="rightPane">
          <ProviderStatusPanel
            mode={mode}
            providerStatus={providerStatus}
            supportedModes={['fixture', 'anthropic', 'openai']}
            trace={visibleTrace}
          />

          <PromptPackagePanel
            promptPackage={recommendationPromptPackage}
            renderedPrompt={{ label: 'Rendered for fixture', prompt: renderedPrompt }}
          />

          <WorkflowPanel
            fixtureId={fixture.id}
            mode={mode}
            replay={replay}
            saving={saving}
            saveError={saveError}
            onSave={() => void saveCurrentReplay()}
          />

          <ReviewPanel
            fixture={fixture}
            mode={mode}
            modelName={context.modelName}
            replay={replay}
            savedReplay={reviewReplay}
            usage={usage}
            costEstimate={context.costEstimate}
            saving={saving}
            saveError={saveError}
            error={historyError}
            promotingPath={promotingPath}
            promoteResult={promoteResult}
            onSave={() => void saveCurrentReplay()}
            onPromote={(path) => void promoteSavedReplay(path)}
          />

          <ReplayHistoryPanel
            replays={savedReplays}
            loading={historyLoading}
            error={historyError}
            selectedPath={reviewReplay?.path ?? selectedReviewPath}
            onRefresh={() => void refreshReplayHistory()}
            onReview={setSelectedReviewPath}
          />

          <PromotedFixturesPanel
            fixtures={promotedFixtures}
            loading={promotedLoading}
            error={promotedError}
            onRefresh={() => void refreshPromotedFixtures()}
          />

          <TracePanel running={running} trace={visibleTrace} />

          <EvalPanel
            error={error}
            evalOk={replay?.evalOk}
            issues={replay?.evalIssues ?? []}
            passedLabel="recommendation-shape passed"
            running={running}
          />
        </aside>
      </div>
  );
}
