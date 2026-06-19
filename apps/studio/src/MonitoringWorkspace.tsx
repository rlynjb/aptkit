import React from 'react';
import { Activity, BadgeCheck, Boxes, BrainCircuit, CircleDollarSign, Clipboard, FileCheck, Gauge, History, Route, Timer } from 'lucide-react';
import { ECOMMERCE_ANOMALY_CATEGORIES, coverageReport, formatCategoryChecklist, runnableCategories, schemaCapabilities } from '@aptkit/agent-anomaly-monitoring';
import { monitoringPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { schemaSummary } from '@aptkit/context';
import { loadPromotedMonitoringFixtures, loadSavedMonitoringReplays, promoteMonitoringReplay, runServerMonitoringReplay, saveReplayArtifact } from './api';
import { AgentReplayShell, type AgentReplayShellContext } from './AgentReplayShell';
import { runMonitoringFixtureReplay } from './agent-runners';
import { AgentStatusPanel, EvalPanel, Metric, Panel, PromptPackagePanel, ProviderStatusPanel, SaveReplayControl, TracePanel } from './components';
import { monitoringFixtures } from './fixtures';
import { CoverageItem, MonitoringAnomalyCard, MonitoringComparisonPanel, MonitoringReplayHistoryPanel, MonitoringReviewPanel, PromotedMonitoringFixturesPanel } from './monitoring-panels';
import { buildMonitoringReplayArtifact, comparableMonitoringFromArtifact, comparisonForMonitoringFixture, findMonitoringReviewReplay, formatCost, formatDuration, toMonitoringReplayState } from './replay-artifacts';
import { useReplayArtifacts } from './useReplayArtifacts';
import type { MonitoringComparisonState, MonitoringFixture, MonitoringReplayMode, MonitoringReplayResult } from './types';

type MonitoringShellResult = MonitoringReplayResult & { savedPath?: string };

type MonitoringShellContext = AgentReplayShellContext<
MonitoringFixture,
MonitoringReplayMode,
MonitoringShellResult
>;

export function MonitoringWorkspace({ onHome }: { onHome: () => void }) {
  const [resetToken, setResetToken] = React.useState(0);

  return (
    <AgentReplayShell
      ariaLabel="Monitoring replay mode"
      fixtures={monitoringFixtures}
      getFixtureId={(fixture) => fixture.id}
      initialMode="fixture"
      metricItems={monitoringMetrics}
      modeClassName="monitoringModeSwitch"
      modes={[
        { mode: 'fixture', label: 'Fixture' },
        { mode: 'openai', label: 'OpenAI' },
      ]}
      onFixtureChange={() => setResetToken((current) => current + 1)}
      onHome={onHome}
      onModeChange={() => setResetToken((current) => current + 1)}
      renderPanels={(context) => <MonitoringPanels context={context} resetToken={resetToken} />}
      runFixture={runMonitoringFixtureReplay}
      runServer={runServerMonitoringReplay}
      title="Anomaly Monitoring Replay"
    />
  );
}

function monitoringMetrics(context: MonitoringShellContext) {
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

function MonitoringPanels({ context, resetToken }: { context: MonitoringShellContext; resetToken: number }) {
  const { error, fixture, mode, providerStatus, replay, running, setReplay, usage, visibleTrace } = context;
  const coverage = coverageReport(ECOMMERCE_ANOMALY_CATEGORIES, schemaCapabilities(fixture.workspace));
  const fullCoverage = coverage.filter((item) => item.coverage === 'full').length;
  const runnableCoverage = coverage.filter((item) => item.coverage !== 'unavailable').length;
  const [comparison, setComparison] = React.useState<MonitoringComparisonState | null>(null);
  const [comparisonRunning, setComparisonRunning] = React.useState(false);
  const [comparisonError, setComparisonError] = React.useState<string | null>(null);
  const comparisonRunCounter = React.useRef(0);
  const {
    historyError,
    historyLoading,
    promotedError,
    promotedFixtures,
    promotedLoading,
    promoteResult,
    promoteSavedReplay,
    promotingPath,
    refreshPromotedFixtures,
    refreshReplayHistory,
    saveCurrentReplay,
    saveError,
    savedReplays,
    saving,
    selectedReviewPath,
    setSaveError,
    setSelectedReviewPath,
  } = useReplayArtifacts({
    buildArtifact: buildMonitoringReplayArtifact,
    fixture,
    loadPromotedFixtures: loadPromotedMonitoringFixtures,
    loadSavedReplays: loadSavedMonitoringReplays,
    mode,
    model: providerStatus[mode].model,
    promoteReplay: promoteMonitoringReplay,
    replay,
    resetToken,
    saveArtifact: saveReplayArtifact,
    setReplay,
  });

  React.useEffect(() => {
    setComparison(null);
    setComparisonError(null);
  }, [resetToken]);

  async function runComparison() {
    setComparisonRunning(true);
    setComparisonError(null);
    setSaveError(null);
    try {
      const baseRunId = Math.max(context.runId, comparisonRunCounter.current);
      const fixtureRunId = baseRunId + 1;
      comparisonRunCounter.current = fixtureRunId;
      const fixtureResult = await runMonitoringFixtureReplay(fixture);
      const fixtureState = toMonitoringReplayState(fixtureResult, fixtureRunId);
      const fixtureArtifact = buildMonitoringReplayArtifact(fixture, fixtureState, 'fixture', providerStatus.fixture.model);
      const fixturePath = await saveReplayArtifact(fixtureArtifact);

      const openaiRunId = fixtureRunId + 1;
      comparisonRunCounter.current = openaiRunId;
      const openaiResult = await runServerMonitoringReplay(fixture, 'openai');
      const openaiState = {
        ...toMonitoringReplayState(openaiResult, openaiRunId),
        savedPath: '',
      };
      const openaiArtifact = buildMonitoringReplayArtifact(fixture, openaiState, 'openai', providerStatus.openai.model);
      const openaiPath = await saveReplayArtifact(openaiArtifact);
      const completedAt = new Date().toLocaleTimeString();

      context.selectMode('openai');
      context.setRunId(openaiRunId);
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

  const reviewReplay = findMonitoringReviewReplay(savedReplays, selectedReviewPath, replay?.savedPath, fixture.id, mode);
  const comparisonView = comparisonForMonitoringFixture(comparison, savedReplays, fixture.id);
  const renderedPrompt = renderPromptTemplate(monitoringPromptPackage.system, {
    schema: schemaSummary(fixture.workspace, { horizonStyle: 'plain', eventHeading: 'Top events:' }),
    categories: formatCategoryChecklist(runnableCategories(ECOMMERCE_ANOMALY_CATEGORIES, schemaCapabilities(fixture.workspace))),
  });

  return (
    <div className="layout">
      <section className="leftPane">
        <AgentStatusPanel
          icon={<Boxes size={17} />}
          rows={[
            { label: 'ID', value: fixture.id },
            { label: 'Case', value: fixture.description },
            { label: 'Status', value: error ? 'error' : running ? 'running' : replay ? `completed at ${replay.completedAt}` : 'not run' },
            { label: 'Mode', value: `${mode} / ${providerStatus[mode].model}${providerStatus[mode].available ? '' : ' unavailable'}` },
            { label: 'Workspace', value: fixture.workspace.projectName },
            { label: 'Input', value: `${usage.inputTokens.toLocaleString()} tokens` },
            { label: 'Output', value: `${usage.outputTokens.toLocaleString()} tokens` },
            { label: 'Cost', value: formatCost(context.costEstimate) },
            { label: 'Events', value: fixture.workspace.totalEvents.toLocaleString() },
            { label: 'Customers', value: fixture.workspace.totalCustomers.toLocaleString() },
            { label: 'Horizon', value: `${fixture.workspace.dataHorizon?.from} to ${fixture.workspace.dataHorizon?.to}` },
          ]}
        />

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
            <SaveReplayControl
              canSave={Boolean(replay)}
              onSave={() => void saveCurrentReplay()}
              savedPath={replay?.savedPath}
              saveError={saveError}
              saving={saving}
            />
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
        <ProviderStatusPanel
          mode={mode}
          providerStatus={providerStatus}
          supportedModes={['fixture', 'openai']}
          trace={visibleTrace}
        />

        <PromptPackagePanel
          promptPackage={monitoringPromptPackage}
          renderedPrompt={{ label: 'Rendered for fixture', prompt: renderedPrompt }}
        />

        <TracePanel running={running} trace={visibleTrace} />

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

        <Panel title="Run" icon={<History size={17} />}>
          <div className="kv">
            <span>Run</span>
            <strong>{context.runId || replay?.runId || 0}</strong>
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
  );
}
