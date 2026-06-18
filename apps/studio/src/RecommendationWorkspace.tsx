import React from 'react';
import { Activity, BadgeCheck, Boxes, BrainCircuit, ChevronDown, CircleDollarSign, Cloud, Gauge, KeyRound, Play, Route, Timer } from 'lucide-react';
import { fixtures } from './fixtures';
import { loadPromotedFixtures, loadSavedReplays, promoteReplay, runServerReplay, saveReplayArtifact } from './api';
import { runFixtureReplay } from './agent-runners';
import { EvalPanel, Metric, Panel, ReplayModeSwitch, TracePanel } from './components';
import { buildReplayArtifact, comparableFromArtifact, comparisonForFixture, estimateCost, findReviewReplay, formatCost, formatDuration, summarizeUsage, toReplayState } from './replay-artifacts';
import { ComparisonPanel, PromotedFixturesPanel, ReplayHistoryPanel, ReviewPanel, WorkflowPanel } from './recommendation-panels';
import type { ComparisonState, PromoteResult, PromotedFixtureSummary, ProviderStatus, ReplayMode, ReplayState, SavedReplaySummary } from './types';

export function RecommendationWorkspace({ onHome }: { onHome: () => void }) {
  const [selectedFixtureId, setSelectedFixtureId] = React.useState(fixtures[0].id);
  const [mode, setMode] = React.useState<ReplayMode>('fixture');
  const [providerStatus, setProviderStatus] = React.useState<ProviderStatus>({
    fixture: { available: true, model: 'fixture-model' },
    anthropic: { available: false, model: 'claude-sonnet-4-6' },
    openai: { available: false, model: 'gpt-4.1' },
  });
  const [replay, setReplay] = React.useState<ReplayState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [runId, setRunId] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
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
  const runCounter = React.useRef(0);
  const selectedFixtureRef = React.useRef(fixtures[0]);
  const fixture = fixtures.find((candidate) => candidate.id === selectedFixtureId) ?? fixtures[0];

  selectedFixtureRef.current = fixture;
  const modeRef = React.useRef(mode);
  modeRef.current = mode;

  const startReplay = React.useCallback(async () => {
    const fixtureToRun = selectedFixtureRef.current;
    const modeToRun = modeRef.current;
    const nextRunId = runCounter.current + 1;
    runCounter.current = nextRunId;
    setRunId(nextRunId);
    setRunning(true);
    setError(null);
    setSaveError(null);
    setReplay(null);
    try {
      const result = modeToRun === 'fixture'
        ? await runFixtureReplay(fixtureToRun)
        : await runServerReplay(fixtureToRun, modeToRun);
      setReplay({
        ...result,
        runId: nextRunId,
        completedAt: new Date().toLocaleTimeString(),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }, []);

  React.useEffect(() => {
    void startReplay();
  }, [startReplay]);

  React.useEffect(() => {
    fetch('/api/model-status')
      .then((response) => response.json())
      .then((payload) => setProviderStatus(payload.providers))
      .catch(() => {
        setProviderStatus((current) => current);
      });
  }, []);

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

  function selectFixture(event: React.ChangeEvent<HTMLSelectElement>) {
    setSelectedFixtureId(event.target.value);
    setReplay(null);
    setError(null);
    setSaveError(null);
    setComparison(null);
    setComparisonError(null);
  }

  function selectMode(nextMode: ReplayMode) {
    setMode(nextMode);
    setReplay(null);
    setError(null);
    setSaveError(null);
    setComparisonError(null);
  }

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
    const fixtureToRun = selectedFixtureRef.current;
    setComparisonRunning(true);
    setComparisonError(null);
    setError(null);
    setSaveError(null);
    setPromoteResult(null);
    try {
      const fixtureRunId = runCounter.current + 1;
      runCounter.current = fixtureRunId;
      const fixtureResult = await runFixtureReplay(fixtureToRun);
      const fixtureState = toReplayState(fixtureResult, fixtureRunId);
      const fixtureArtifact = buildReplayArtifact(fixtureToRun, fixtureState, 'fixture', providerStatus.fixture.model);
      const fixturePath = await saveReplayArtifact(fixtureArtifact);

      const openaiRunId = runCounter.current + 1;
      runCounter.current = openaiRunId;
      const openaiResult = await runServerReplay(fixtureToRun, 'openai');
      const openaiState = {
        ...toReplayState(openaiResult, openaiRunId),
        savedPath: '',
      };
      const openaiArtifact = buildReplayArtifact(fixtureToRun, openaiState, 'openai', providerStatus.openai.model);
      const openaiPath = await saveReplayArtifact(openaiArtifact);
      const completedAt = new Date().toLocaleTimeString();

      setMode('openai');
      setRunId(openaiRunId);
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

  const usage = summarizeUsage(replay?.trace ?? []);
  const modelName = usage.modelName || providerStatus[mode].model;
  const costEstimate = estimateCost(mode, usage, modelName);
  const reviewReplay = findReviewReplay(savedReplays, selectedReviewPath, replay?.savedPath, fixture.id, mode);
  const comparisonView = comparisonForFixture(comparison, savedReplays, fixture.id);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Recommendation Agent Replay</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            <Boxes size={15} />
            <span>Home</span>
          </button>
          <ReplayModeSwitch
            ariaLabel="Replay mode"
            mode={mode}
            onSelect={selectMode}
            options={[
              { mode: 'fixture', available: true, icon: <Boxes size={15} />, label: 'Fixture' },
              { mode: 'anthropic', available: providerStatus.anthropic.available, icon: <Cloud size={15} />, label: 'Anthropic' },
              { mode: 'openai', available: providerStatus.openai.available, icon: <KeyRound size={15} />, label: 'OpenAI' },
            ]}
          />
          <label className="fixtureSelect">
            <span>Fixture</span>
            <ChevronDown size={16} aria-hidden="true" />
            <select value={selectedFixtureId} onChange={selectFixture} disabled={running}>
              {fixtures.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id}
                </option>
              ))}
            </select>
          </label>
          <button className="runButton" onClick={startReplay} disabled={running || !providerStatus[mode].available}>
            <Play size={17} aria-hidden="true" />
            <span>{running ? 'Running' : mode === 'fixture' ? 'Run Fixture' : 'Run Live'}</span>
          </button>
        </div>
      </header>

      <section className="metrics" aria-label="Replay summary">
        <Metric icon={<BadgeCheck size={18} />} label="Eval" value={error ? 'Error' : replay?.evalOk ? 'Passing' : running ? 'Running' : 'Pending'} tone={replay?.evalOk ? 'good' : 'neutral'} />
        <Metric icon={<BrainCircuit size={18} />} label="Model" value={modelName} />
        <Metric icon={<Gauge size={18} />} label="Tokens" value={usage.totalTokens.toLocaleString()} />
        <Metric icon={<CircleDollarSign size={18} />} label="Est. Cost" value={formatCost(costEstimate)} />
        <Metric icon={<Timer size={18} />} label="Duration" value={replay ? formatDuration(replay.durationMs) : running ? 'Running' : '0ms'} />
      </section>

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
              <strong>{formatCost(costEstimate)}</strong>
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
            modelName={modelName}
            replay={replay}
            savedReplay={reviewReplay}
            usage={usage}
            costEstimate={costEstimate}
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

          <TracePanel running={running} trace={replay?.trace ?? []} />

          <EvalPanel
            error={error}
            evalOk={replay?.evalOk}
            issues={replay?.evalIssues ?? []}
            passedLabel="recommendation-shape passed"
            running={running}
          />
        </aside>
      </div>
    </main>
  );
}
