import React from 'react';
import { BadgeCheck, Boxes, BrainCircuit, CircleDollarSign, FileCheck, FileText, Gauge, MessageSquareText, RefreshCw, Save, Timer } from 'lucide-react';
import { queryPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { schemaSummary } from '@aptkit/context';
import { loadPromotedQueryFixtures, loadSavedQueryReplays, promoteQueryReplay, runServerQueryReplay, saveReplayArtifact } from './api';
import { AgentReplayShell, type AgentReplayShellContext } from './AgentReplayShell';
import { runQueryFixtureReplay } from './agent-runners';
import { EvalPanel, Metric, Panel, PromptPackagePanel, ProviderStatusPanel, TracePanel } from './components';
import { queryFixtures } from './fixtures';
import { buildQueryReplayArtifact, formatCost, formatDuration } from './replay-artifacts';
import { useReplayArtifacts } from './useReplayArtifacts';
import type { QueryFixture, QueryReplayMode, QueryReplayResult } from './types';

type QueryShellResult = QueryReplayResult & { savedPath?: string };

type QueryShellContext = AgentReplayShellContext<
QueryFixture,
QueryReplayMode,
QueryShellResult
>;

export function QueryWorkspace({ onHome }: { onHome: () => void }) {
  const [resetToken, setResetToken] = React.useState(0);

  return (
    <AgentReplayShell
      ariaLabel="Query replay mode"
      fixtures={queryFixtures}
      getFixtureId={(fixture) => fixture.id}
      initialMode="fixture"
      metricItems={queryMetrics}
      modeClassName="monitoringModeSwitch"
      modes={[
        { mode: 'fixture', label: 'Fixture' },
        { mode: 'openai', label: 'OpenAI' },
      ]}
      onFixtureChange={() => setResetToken((current) => current + 1)}
      onHome={onHome}
      onModeChange={() => setResetToken((current) => current + 1)}
      renderPanels={(context) => <QueryPanels context={context} resetToken={resetToken} />}
      runFixture={runQueryFixtureReplay}
      runServer={runServerQueryReplay}
      title="Query Replay"
    />
  );
}

function queryMetrics(context: QueryShellContext) {
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

function QueryPanels({ context, resetToken }: { context: QueryShellContext; resetToken: number }) {
  const { error, fixture, mode, providerStatus, replay, running, setReplay, usage, visibleTrace } = context;
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
    buildArtifact: buildQueryReplayArtifact,
    fixture,
    loadPromotedFixtures: loadPromotedQueryFixtures,
    loadSavedReplays: loadSavedQueryReplays,
    mode,
    model: providerStatus[mode].model,
    promoteReplay: promoteQueryReplay,
    replay,
    resetToken,
    saveArtifact: saveReplayArtifact,
    setReplay,
  });
  const renderedPrompt = renderPromptTemplate(queryPromptPackage.system, {
    schema: schemaSummary(fixture.workspace),
    project_id: fixture.workspace.projectId,
    intent: fixture.intent,
  });

  return (
    <div className="layout">
      <section className="leftPane">
        <Panel title="Fixture" icon={<Boxes size={17} />}>
          <div className="kv">
            <span>ID</span>
            <strong>{fixture.id}</strong>
            <span>Question</span>
            <strong>{fixture.question}</strong>
            <span>Intent</span>
            <strong>{fixture.intent}</strong>
            <span>Status</span>
            <strong>{error ? 'error' : running ? 'running' : replay ? `completed at ${replay.completedAt}` : 'not run'}</strong>
            <span>Mode</span>
            <strong>{mode} / {providerStatus[mode].model}{providerStatus[mode].available ? '' : ' unavailable'}</strong>
            <span>Workspace</span>
            <strong>{fixture.workspace.projectName}</strong>
            <span>Run</span>
            <strong>{context.runId || replay?.runId || 0}</strong>
            <span>Turns</span>
            <strong>{replay?.modelTurns ?? 0}</strong>
          </div>
        </Panel>

        <Panel title="Workflow" icon={<FileText size={17} />}>
          <div className="workflow">
            <div className="layerCallout">
              <strong>{mode === 'fixture' ? 'Fake model + fake tools' : 'Real model + fake tools'}</strong>
              <span>{mode === 'fixture' ? 'Deterministic query replay for UI validation.' : 'OpenAI answers over controlled fixture data; no live customer data is sent.'}</span>
            </div>
            <ol className="workflowSteps">
              <li>Load query fixture</li>
              <li>Run allowed analytics tool</li>
              <li>Return grounded prose answer</li>
              <li>Validate answer presence</li>
            </ol>
            <div className="saveReplay">
              <button type="button" onClick={() => void saveCurrentReplay()} disabled={!replay || saving}>
                <Save size={15} />
                <span>{saving ? 'Saving' : replay?.savedPath ? 'Saved' : 'Save Replay'}</span>
              </button>
              <code>{replay?.savedPath ?? 'No saved artifact yet'}</code>
              {saveError ? <p>{saveError}</p> : null}
            </div>
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
                <strong>Promoted query fixture</strong>
                <code>{promoteResult.path}</code>
              </div>
            ) : null}
          </div>
        </Panel>
      </section>

      <section className="mainPane">
        <Panel title="Answer" icon={<MessageSquareText size={17} />} wide>
          {running ? <div className="emptyState">Running {mode === 'fixture' ? 'fixture' : 'OpenAI'} query replay...</div> : null}
          {!providerStatus[mode].available ? <div className="errorState">Set OPENAI_API_KEY and restart Studio to enable OpenAI query replay.</div> : null}
          {error ? <div className="errorState">{error}</div> : null}
          {!running && !error && !replay ? <div className="emptyState">No answer yet.</div> : null}
          {replay?.answer ? <p className="answerText">{replay.answer}</p> : null}
        </Panel>

        <Panel title="Query History" icon={<FileText size={17} />} wide>
          <div className="historyPanel">
            <button className="secondaryAction" type="button" onClick={() => void refreshReplayHistory()} disabled={historyLoading}>
              <RefreshCw size={15} />
              <span>{historyLoading ? 'Checking' : 'Refresh History'}</span>
            </button>
            {historyError ? <div className="errorState compact">{historyError}</div> : null}
            {!historyLoading && savedReplays.length === 0 ? <div className="emptyState compact">No saved query replays found.</div> : null}
            <div className="historyList">
              {savedReplays.slice(0, 6).map((savedReplay) => (
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
                  <p className="bodyText">{savedReplay.question ?? fixture.question}</p>
                  <p className="bodyText">{savedReplay.answer}</p>
                  <code>{savedReplay.path}</code>
                </article>
              ))}
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
          promptPackage={queryPromptPackage}
          renderedPrompt={{ label: 'Rendered for fixture', prompt: renderedPrompt }}
        />

        <TracePanel running={running} trace={visibleTrace} />
        <EvalPanel
          error={error}
          evalOk={replay?.evalOk}
          issues={replay?.evalIssues ?? []}
          passedLabel="query-answer-shape passed"
          running={running}
        />
        <Panel title="Promoted Query" icon={<FileCheck size={17} />}>
          <div className="historyPanel">
            <button className="secondaryAction" type="button" onClick={() => void refreshPromotedFixtures()} disabled={promotedLoading}>
              <RefreshCw size={15} />
              <span>{promotedLoading ? 'Checking' : 'Check Promoted'}</span>
            </button>
            {promotedError ? <div className="errorState compact">{promotedError}</div> : null}
            {!promotedLoading && promotedFixtures.length === 0 ? <div className="emptyState compact">No promoted query fixtures found.</div> : null}
            <div className="historyList">
              {promotedFixtures.map((promotedFixture) => (
                <article className="historyItem" key={promotedFixture.path}>
                  <div className="historyHeader">
                    <strong>{promotedFixture.id}</strong>
                    <span className={promotedFixture.ok ? 'statusPill good' : 'statusPill bad'}>{promotedFixture.ok ? 'healthy' : 'failing'}</span>
                  </div>
                  <div className="historyMeta">
                    <span>{promotedFixture.answerPresent ? 'answer present' : 'missing answer'}</span>
                    <span>{promotedFixture.modelTurns} turns</span>
                    <span>{promotedFixture.usage.totalTokens.toLocaleString()} tokens</span>
                    <span>{promotedFixture.behaviorOk ? 'behavior pass' : 'behavior fail'}</span>
                  </div>
                  {promotedFixture.expectations ? (
                    <div className="expectationBlock">
                      <span>Expectations</span>
                      <strong>{(promotedFixture.expectations.requiredAnswerText ?? []).join(', ') || 'none'}</strong>
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
