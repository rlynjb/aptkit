import React from 'react';
import { Activity, BadgeCheck, Boxes, BrainCircuit, CircleDollarSign, FileCheck, Gauge, History, RefreshCw, Route, SearchCheck, Timer } from 'lucide-react';
import { diagnosticPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { schemaSummary } from '@aptkit/context';
import { loadPromotedDiagnosticFixtures, loadSavedDiagnosticReplays, promoteDiagnosticReplay, runServerDiagnosticReplay, saveReplayArtifact } from './api';
import { AgentReplayShell, type AgentReplayShellContext } from './AgentReplayShell';
import { runDiagnosticFixtureReplay } from './agent-runners';
import { AgentStatusPanel, EvalPanel, Metric, Panel, PromptPackagePanel, ProviderStatusPanel, SaveReplayControl, TracePanel } from './components';
import { diagnosticFixtures } from './fixtures';
import { buildDiagnosticReplayArtifact, formatCost, formatDuration } from './replay-artifacts';
import { useReplayArtifacts } from './useReplayArtifacts';
import type { DiagnosticFixture, DiagnosticReplayMode, DiagnosticReplayResult } from './types';

type DiagnosticShellResult = DiagnosticReplayResult & { savedPath?: string };

type DiagnosticShellContext = AgentReplayShellContext<
DiagnosticFixture,
DiagnosticReplayMode,
DiagnosticShellResult
>;

export function DiagnosticWorkspace({ onHome }: { onHome: () => void }) {
  const [resetToken, setResetToken] = React.useState(0);

  return (
    <AgentReplayShell
      ariaLabel="Diagnostic replay mode"
      fixtures={diagnosticFixtures}
      getFixtureId={(fixture) => fixture.id}
      initialMode="fixture"
      metricItems={diagnosticMetrics}
      modeClassName="monitoringModeSwitch"
      modes={[
        { mode: 'fixture', label: 'Fixture' },
        { mode: 'openai', label: 'OpenAI' },
      ]}
      onFixtureChange={() => setResetToken((current) => current + 1)}
      onHome={onHome}
      onModeChange={() => setResetToken((current) => current + 1)}
      renderPanels={(context) => <DiagnosticPanels context={context} resetToken={resetToken} />}
      runFixture={runDiagnosticFixtureReplay}
      runServer={runServerDiagnosticReplay}
      title="Diagnostic Investigation Replay"
    />
  );
}

function diagnosticMetrics(context: DiagnosticShellContext) {
  const diagnosis = context.replay?.diagnosis;
  return (
    <>
      <Metric icon={<BadgeCheck size={18} />} label="Eval" value={context.error ? 'Error' : context.replay?.evalOk ? 'Passing' : context.running ? 'Running' : 'Pending'} tone={context.replay?.evalOk ? 'good' : 'neutral'} />
      <Metric icon={<BrainCircuit size={18} />} label="Model" value={context.modelName} />
      <Metric icon={<Gauge size={18} />} label="Tokens" value={context.usage.totalTokens.toLocaleString()} />
      <Metric icon={<CircleDollarSign size={18} />} label="Est. Cost" value={formatCost(context.costEstimate)} />
      <Metric icon={<SearchCheck size={18} />} label="Confidence" value={diagnosis?.confidence ?? 'pending'} />
      <Metric icon={<Timer size={18} />} label="Duration" value={context.replay ? formatDuration(context.replay.durationMs) : context.running ? 'Running' : '0ms'} />
      <Metric icon={<Boxes size={18} />} label="Run" value={`#${context.runId || context.replay?.runId || 0}`} />
    </>
  );
}

function DiagnosticPanels({ context, resetToken }: { context: DiagnosticShellContext; resetToken: number }) {
  const { error, fixture, mode, providerStatus, replay, running, setReplay, usage, visibleTrace } = context;
  const diagnosis = replay?.diagnosis;
  const {
    historyError,
    historyLoading,
    latestReviewPath,
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
  } = useReplayArtifacts({
    buildArtifact: buildDiagnosticReplayArtifact,
    fixture,
    loadPromotedFixtures: loadPromotedDiagnosticFixtures,
    loadSavedReplays: loadSavedDiagnosticReplays,
    mode,
    model: providerStatus[mode].model,
    promoteReplay: promoteDiagnosticReplay,
    replay,
    resetToken,
    saveArtifact: saveReplayArtifact,
    setReplay,
  });
  const renderedPrompt = renderPromptTemplate(diagnosticPromptPackage.system, {
    schema: schemaSummary(fixture.workspace),
    project_id: fixture.workspace.projectId,
    anomaly: JSON.stringify(fixture.anomaly),
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
            { label: 'Run', value: context.runId || replay?.runId || 0 },
            { label: 'Turns', value: replay?.modelTurns ?? 0 },
            { label: 'Input', value: `${usage.inputTokens.toLocaleString()} tokens` },
            { label: 'Output', value: `${usage.outputTokens.toLocaleString()} tokens` },
          ]}
        />

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
          {fixture.anomaly.impact ? <p className="bodyText">{fixture.anomaly.impact}</p> : null}
        </Panel>
      </section>

      <section className="mainPane">
        <Panel title="Diagnosis" icon={<SearchCheck size={17} />} wide>
          {running ? <div className="emptyState">Running {mode === 'fixture' ? 'fixture' : 'OpenAI'} diagnostic replay...</div> : null}
          {!providerStatus[mode].available ? <div className="errorState">Set OPENAI_API_KEY and restart Studio to enable OpenAI diagnostic replay.</div> : null}
          {error ? <div className="errorState">{error}</div> : null}
          {!running && !error && !replay ? <div className="emptyState">No diagnostic output yet.</div> : null}
          {diagnosis ? (
            <div className="workflow">
              <div className="layerCallout">
                <strong>{diagnosis.confidence ?? 'unknown'} confidence</strong>
                <span>{diagnosis.conclusion}</span>
              </div>
              <ol className="workflowSteps">
                {diagnosis.evidence.map((evidence) => (
                  <li key={evidence}>{evidence}</li>
                ))}
              </ol>
            </div>
          ) : null}
        </Panel>

        <Panel title="Hypotheses" icon={<Route size={17} />} wide>
          {!diagnosis ? <div className="emptyState compact">No hypotheses yet.</div> : null}
          <div className="historyList">
            {(diagnosis?.hypothesesConsidered ?? []).map((hypothesis) => (
              <article className="historyItem" key={hypothesis.hypothesis}>
                <div className="historyHeader">
                  <strong>{hypothesis.hypothesis}</strong>
                  <span className={hypothesis.supported ? 'statusPill good' : 'statusPill bad'}>{hypothesis.supported ? 'supported' : 'ruled out'}</span>
                </div>
                <p className="bodyText">{hypothesis.reasoning}</p>
              </article>
            ))}
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
          promptPackage={diagnosticPromptPackage}
          renderedPrompt={{ label: 'Rendered for fixture', prompt: renderedPrompt }}
        />

        <TracePanel running={running} trace={visibleTrace} />

        <EvalPanel
          error={error}
          evalOk={replay?.evalOk}
          issues={replay?.evalIssues ?? []}
          passedLabel="diagnosis-shape passed"
          running={running}
        />

        <Panel title="Workflow" icon={<History size={17} />}>
          <div className="workflow">
            <div className="layerCallout">
              <strong>{mode === 'fixture' ? 'Fake model + fake tools' : 'Real model + fake tools'}</strong>
              <span>{mode === 'fixture' ? 'Deterministic diagnostic replay for UI validation and regression checks.' : 'OpenAI reasons over controlled fixture data; no live customer data is sent.'}</span>
            </div>
            <ol className="workflowSteps">
              <li>Load anomaly fixture</li>
              <li>Test competing hypotheses</li>
              <li>Query context and timeseries tools</li>
              <li>Validate diagnosis JSON</li>
            </ol>
            <SaveReplayControl
              canSave={Boolean(replay)}
              onSave={() => void saveCurrentReplay()}
              savedPath={replay?.savedPath}
              saveError={saveError}
              saving={saving}
            />
            <div className="reviewActions">
              <button
                className="primaryAction"
                type="button"
                onClick={() => latestReviewPath ? void promoteSavedReplay(latestReviewPath) : undefined}
                disabled={!latestReviewPath || promotingPath === latestReviewPath}
              >
                <FileCheck size={15} />
                <span>{promotingPath === latestReviewPath ? 'Promoting' : 'Promote Replay'}</span>
              </button>
            </div>
            {promoteResult ? (
              <div className="historySuccess">
                <strong>Promoted diagnostic fixture</strong>
                <code>{promoteResult.path}</code>
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title="Diagnostic History" icon={<FileCheck size={17} />}>
          <div className="historyPanel">
            <button className="secondaryAction" type="button" onClick={() => void refreshReplayHistory()} disabled={historyLoading}>
              <RefreshCw size={15} />
              <span>{historyLoading ? 'Checking' : 'Refresh History'}</span>
            </button>
            {historyError ? <div className="errorState compact">{historyError}</div> : null}
            {!historyLoading && savedReplays.length === 0 ? <div className="emptyState compact">No saved diagnostic replays found.</div> : null}
            <div className="historyList">
              {savedReplays.slice(0, 5).map((savedReplay) => (
                <article className="historyItem" key={savedReplay.path}>
                  <div className="historyHeader">
                    <strong>{savedReplay.fixture.id}</strong>
                    <span className={savedReplay.evalOk ? 'statusPill good' : 'statusPill bad'}>{savedReplay.evalOk ? 'pass' : 'fail'}</span>
                  </div>
                  <div className="historyMeta">
                    <span>{savedReplay.provider.id} / {savedReplay.provider.model}</span>
                    <span>{savedReplay.usage.totalTokens.toLocaleString()} tokens</span>
                    <span>{formatCost(savedReplay.costEstimate)}</span>
                    <span>{formatDuration(savedReplay.durationMs)}</span>
                  </div>
                  <p className="bodyText">{savedReplay.diagnosis?.conclusion ?? 'No diagnosis summary'}</p>
                  <code>{savedReplay.path}</code>
                </article>
              ))}
            </div>
          </div>
        </Panel>

        <Panel title="Promoted Diagnostic" icon={<FileCheck size={17} />}>
          <div className="historyPanel">
            <button className="secondaryAction" type="button" onClick={() => void refreshPromotedFixtures()} disabled={promotedLoading}>
              <RefreshCw size={15} />
              <span>{promotedLoading ? 'Checking' : 'Check Promoted'}</span>
            </button>
            {promotedError ? <div className="errorState compact">{promotedError}</div> : null}
            {!promotedLoading && promotedFixtures.length === 0 ? <div className="emptyState compact">No promoted diagnostic fixtures found.</div> : null}
            <div className="historyList">
              {promotedFixtures.map((promotedFixture) => (
                <article className="historyItem" key={promotedFixture.path}>
                  <div className="historyHeader">
                    <strong>{promotedFixture.id}</strong>
                    <span className={promotedFixture.ok ? 'statusPill good' : 'statusPill bad'}>{promotedFixture.ok ? 'healthy' : 'failing'}</span>
                  </div>
                  <div className="historyMeta">
                    <span>{promotedFixture.diagnosisPresent ? 'diagnosis present' : 'missing diagnosis'}</span>
                    <span>{promotedFixture.modelTurns} turns</span>
                    <span>{promotedFixture.usage.totalTokens.toLocaleString()} tokens</span>
                    <span>{promotedFixture.behaviorOk ? 'behavior pass' : 'behavior fail'}</span>
                  </div>
                  {promotedFixture.expectations ? (
                    <div className="expectationBlock">
                      <span>Expectations</span>
                      <strong>{[
                        ...(promotedFixture.expectations.requiredEvidenceText ?? []).map((text) => `evidence:${text}`),
                        ...(promotedFixture.expectations.requiredSupportedHypothesisText ?? []).map((text) => `hypothesis:${text}`),
                      ].join(', ') || 'none'}</strong>
                    </div>
                  ) : null}
                  <code>{promotedFixture.path}</code>
                  {promotedFixture.issues.length ? (
                    <ul className="issueList">
                      {promotedFixture.issues.slice(0, 3).map((issue) => (
                        <li key={`${promotedFixture.path}-${issue.source}-${issue.path}-${issue.message}`}>
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
      </aside>
    </div>
  );
}
