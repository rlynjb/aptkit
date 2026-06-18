import React from 'react';
import { Activity, BadgeCheck, Boxes, BrainCircuit, ChevronDown, CircleDollarSign, Clipboard, FileCheck, Gauge, History, KeyRound, Play, Route, Save, Timer } from 'lucide-react';
import { ECOMMERCE_ANOMALY_CATEGORIES, coverageReport, formatCategoryChecklist, runnableCategories, schemaCapabilities } from '@aptkit/agent-anomaly-monitoring';
import { monitoringPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { schemaSummary } from '@aptkit/context';
import { monitoringFixtures } from './fixtures';
import { loadPromotedMonitoringFixtures, loadSavedMonitoringReplays, promoteMonitoringReplay, runServerMonitoringReplay, saveReplayArtifact } from './api';
import { runMonitoringFixtureReplay } from './agent-runners';
import { EvalPanel, Metric, Panel, PromptPackagePanel, ReplayModeSwitch, TracePanel } from './components';
import { CoverageItem, MonitoringAnomalyCard, MonitoringComparisonPanel, MonitoringReplayHistoryPanel, MonitoringReviewPanel, PromotedMonitoringFixturesPanel } from './monitoring-panels';
import { buildMonitoringReplayArtifact, comparableMonitoringFromArtifact, comparisonForMonitoringFixture, estimateCost, findMonitoringReviewReplay, formatCost, formatDuration, summarizeUsage, toMonitoringReplayState } from './replay-artifacts';
import type { MonitoringComparisonState, MonitoringPromoteResult, MonitoringReplayMode, MonitoringReplayState, PromotedMonitoringFixtureSummary, ProviderStatus, SavedMonitoringReplaySummary } from './types';

export function MonitoringWorkspace({ onHome }: { onHome: () => void }) {
  const [selectedFixtureId, setSelectedFixtureId] = React.useState(monitoringFixtures[0].id);
  const [mode, setMode] = React.useState<MonitoringReplayMode>('fixture');
  const [providerStatus, setProviderStatus] = React.useState<ProviderStatus>({
    fixture: { available: true, model: 'fixture-model' },
    anthropic: { available: false, model: 'claude-sonnet-4-6' },
    openai: { available: false, model: 'gpt-4.1' },
  });
  const [replay, setReplay] = React.useState<MonitoringReplayState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [runId, setRunId] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedReplays, setSavedReplays] = React.useState<SavedMonitoringReplaySummary[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [selectedReviewPath, setSelectedReviewPath] = React.useState<string | null>(null);
  const [comparison, setComparison] = React.useState<MonitoringComparisonState | null>(null);
  const [comparisonRunning, setComparisonRunning] = React.useState(false);
  const [comparisonError, setComparisonError] = React.useState<string | null>(null);
  const [promotingPath, setPromotingPath] = React.useState<string | null>(null);
  const [promoteResult, setPromoteResult] = React.useState<MonitoringPromoteResult | null>(null);
  const [promotedFixtures, setPromotedFixtures] = React.useState<PromotedMonitoringFixtureSummary[]>([]);
  const [promotedLoading, setPromotedLoading] = React.useState(false);
  const [promotedError, setPromotedError] = React.useState<string | null>(null);
  const runCounter = React.useRef(0);
  const selectedFixtureRef = React.useRef(monitoringFixtures[0]);
  const modeRef = React.useRef(mode);
  const fixture = monitoringFixtures.find((candidate) => candidate.id === selectedFixtureId) ?? monitoringFixtures[0];
  const coverage = coverageReport(ECOMMERCE_ANOMALY_CATEGORIES, schemaCapabilities(fixture.workspace));
  const fullCoverage = coverage.filter((item) => item.coverage === 'full').length;
  const runnableCoverage = coverage.filter((item) => item.coverage !== 'unavailable').length;

  selectedFixtureRef.current = fixture;
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
        ? await runMonitoringFixtureReplay(fixtureToRun)
        : await runServerMonitoringReplay(fixtureToRun, modeToRun);
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

  function selectFixture(event: React.ChangeEvent<HTMLSelectElement>) {
    setSelectedFixtureId(event.target.value);
    setReplay(null);
    setError(null);
    setSaveError(null);
    setComparison(null);
    setComparisonError(null);
  }

  function selectMode(nextMode: MonitoringReplayMode) {
    setMode(nextMode);
    setReplay(null);
    setError(null);
    setSaveError(null);
    setComparisonError(null);
  }

  const refreshReplayHistory = React.useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      setSavedReplays(await loadSavedMonitoringReplays());
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
      setPromotedFixtures(await loadPromotedMonitoringFixtures());
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
      const artifact = buildMonitoringReplayArtifact(fixture, replay, mode, providerStatus[mode].model);
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
      const result = await promoteMonitoringReplay(path);
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
    try {
      const fixtureRunId = runCounter.current + 1;
      runCounter.current = fixtureRunId;
      const fixtureResult = await runMonitoringFixtureReplay(fixtureToRun);
      const fixtureState = toMonitoringReplayState(fixtureResult, fixtureRunId);
      const fixtureArtifact = buildMonitoringReplayArtifact(fixtureToRun, fixtureState, 'fixture', providerStatus.fixture.model);
      const fixturePath = await saveReplayArtifact(fixtureArtifact);

      const openaiRunId = runCounter.current + 1;
      runCounter.current = openaiRunId;
      const openaiResult = await runServerMonitoringReplay(fixtureToRun, 'openai');
      const openaiState = {
        ...toMonitoringReplayState(openaiResult, openaiRunId),
        savedPath: '',
      };
      const openaiArtifact = buildMonitoringReplayArtifact(fixtureToRun, openaiState, 'openai', providerStatus.openai.model);
      const openaiPath = await saveReplayArtifact(openaiArtifact);
      const completedAt = new Date().toLocaleTimeString();

      setMode('openai');
      setRunId(openaiRunId);
      setReplay({ ...openaiState, savedPath: openaiPath, completedAt });
      setSelectedReviewPath(openaiPath);
      setComparison({
        fixture: comparableMonitoringFromArtifact(fixtureArtifact, fixturePath),
        openai: comparableMonitoringFromArtifact(openaiArtifact, openaiPath),
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
  const reviewReplay = findMonitoringReviewReplay(savedReplays, selectedReviewPath, replay?.savedPath, fixture.id, mode);
  const comparisonView = comparisonForMonitoringFixture(comparison, savedReplays, fixture.id);
  const renderedPrompt = renderPromptTemplate(monitoringPromptPackage.system, {
    schema: schemaSummary(fixture.workspace, { horizonStyle: 'plain', eventHeading: 'Top events:' }),
    categories: formatCategoryChecklist(runnableCategories(ECOMMERCE_ANOMALY_CATEGORIES, schemaCapabilities(fixture.workspace))),
  });

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Anomaly Monitoring Replay</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            <Boxes size={15} />
            <span>Home</span>
          </button>
          <ReplayModeSwitch
            ariaLabel="Monitoring replay mode"
            className="monitoringModeSwitch"
            mode={mode}
            onSelect={selectMode}
            options={[
              { mode: 'fixture', available: true, icon: <Boxes size={15} />, label: 'Fixture' },
              { mode: 'openai', available: providerStatus.openai.available, icon: <KeyRound size={15} />, label: 'OpenAI' },
            ]}
          />
          <label className="fixtureSelect">
            <span>Fixture</span>
            <ChevronDown size={16} aria-hidden="true" />
            <select value={selectedFixtureId} onChange={selectFixture} disabled={running}>
              {monitoringFixtures.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id}
                </option>
              ))}
            </select>
          </label>
          <button className="runButton" onClick={startReplay} disabled={running || !providerStatus[mode].available}>
            <Play size={17} aria-hidden="true" />
            <span>{running ? 'Running' : mode === 'fixture' ? 'Run Fixture' : 'Run OpenAI'}</span>
          </button>
        </div>
      </header>

      <section className="metrics" aria-label="Monitoring replay summary">
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
              <span>Events</span>
              <strong>{fixture.workspace.totalEvents.toLocaleString()}</strong>
              <span>Customers</span>
              <strong>{fixture.workspace.totalCustomers.toLocaleString()}</strong>
              <span>Horizon</span>
              <strong>{fixture.workspace.dataHorizon?.from} to {fixture.workspace.dataHorizon?.to}</strong>
            </div>
          </Panel>

          <Panel title="Coverage" icon={<FileCheck size={17} />}>
            <div className="coverageSummary">
              <strong>{fullCoverage} full</strong>
              <span>{runnableCoverage} runnable categories out of {coverage.length}</span>
            </div>
            <div className="coverageGrid">
              {coverage.map((item) => (
                <CoverageItem item={item} key={item.category} />
              ))}
            </div>
          </Panel>
        </section>

        <section className="mainPane">
          <Panel title="Detected Anomalies" icon={<Activity size={17} />} wide>
            {running ? <div className="emptyState">Running {mode === 'fixture' ? 'fixture' : 'OpenAI'} monitoring replay...</div> : null}
            {!providerStatus[mode].available ? <div className="errorState">Set OPENAI_API_KEY and restart Studio to enable OpenAI monitoring.</div> : null}
            {error ? <div className="errorState">{error}</div> : null}
            {!running && !error && !replay ? <div className="emptyState">No monitoring output yet.</div> : null}
            {!running && replay && replay.anomalies.length === 0 ? <div className="emptyState">No meaningful anomaly found.</div> : null}
            <div className="anomalyCards">
              {(replay?.anomalies ?? []).map((anomaly, index) => (
                <MonitoringAnomalyCard anomaly={anomaly} index={index} key={`${anomaly.metric}-${anomaly.scope.join('-')}-${index}`} />
              ))}
            </div>
          </Panel>

          <MonitoringComparisonPanel
            comparison={comparisonView}
            fixtureId={fixture.id}
            openaiAvailable={providerStatus.openai.available}
            running={comparisonRunning}
            error={comparisonError}
            onRun={() => void runComparison()}
          />

          <Panel title="Workflow" icon={<Route size={17} />} wide>
            <div className="workflow">
              <div className="layerCallout">
                <strong>{mode === 'fixture' ? 'Fake model + fake tools' : 'Real model + fake tools'}</strong>
                <span>{mode === 'fixture' ? 'Deterministic monitoring replay for UI validation and regression checks.' : 'OpenAI reasons over controlled fixture data; no live customer data is sent.'}</span>
              </div>
              <ol className="workflowSteps">
                <li>Load ecommerce workspace descriptor</li>
                <li>Calculate runnable anomaly categories</li>
                <li>Replay fixture model tool calls</li>
                <li>Validate anomaly JSON</li>
                <li>Review trace and coverage in Studio</li>
              </ol>
              <div className="saveReplay">
                <button type="button" onClick={() => void saveCurrentReplay()} disabled={!replay || saving}>
                  <Save size={15} />
                  <span>{saving ? 'Saving' : replay?.savedPath ? 'Saved' : 'Save Replay'}</span>
                </button>
                <code>{replay?.savedPath ?? 'No saved artifact yet'}</code>
                {saveError ? <p>{saveError}</p> : null}
              </div>
              <div className="commandList">
                <div className="commandRow">
                  <span>{mode === 'fixture' ? 'CLI replay' : 'Live shape'}</span>
                  <code>{mode === 'fixture' ? 'npm run replay:monitoring' : 'OpenAI monitoring runs through Studio API'}</code>
                  <button
                    aria-label="Copy monitoring replay command"
                    title="Copy monitoring replay command"
                    type="button"
                    onClick={() => void navigator.clipboard.writeText(mode === 'fixture' ? 'npm run replay:monitoring' : 'OpenAI monitoring runs through Studio API')}
                  >
                    <Clipboard size={15} />
                  </button>
                </div>
              </div>
            </div>
          </Panel>
        </section>

        <aside className="rightPane">
          <PromptPackagePanel
            promptPackage={monitoringPromptPackage}
            renderedPrompt={{ label: 'Rendered for fixture', prompt: renderedPrompt }}
          />

          <TracePanel running={running} trace={replay?.trace ?? []} />

          <EvalPanel
            error={error}
            evalOk={replay?.evalOk}
            issues={replay?.evalIssues ?? []}
            passedLabel="anomaly-shape passed"
            running={running}
          />

          <MonitoringReviewPanel
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

          <Panel title="Run" icon={<History size={17} />}>
            <div className="kv">
              <span>Run</span>
              <strong>{runId || replay?.runId || 0}</strong>
              <span>Turns</span>
              <strong>{replay?.modelTurns ?? 0}</strong>
              <span>Input</span>
              <strong>{usage.inputTokens.toLocaleString()} tokens</strong>
              <span>Output</span>
              <strong>{usage.outputTokens.toLocaleString()} tokens</strong>
            </div>
          </Panel>

          <MonitoringReplayHistoryPanel
            replays={savedReplays}
            loading={historyLoading}
            error={historyError}
            selectedPath={reviewReplay?.path ?? selectedReviewPath}
            onRefresh={() => void refreshReplayHistory()}
            onReview={setSelectedReviewPath}
          />

          <PromotedMonitoringFixturesPanel
            fixtures={promotedFixtures}
            loading={promotedLoading}
            error={promotedError}
            onRefresh={() => void refreshPromotedFixtures()}
          />
        </aside>
      </div>
    </main>
  );
}
