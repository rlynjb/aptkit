import React from 'react';
import { BadgeCheck, Boxes, BrainCircuit, ChevronDown, CircleDollarSign, FileCheck, FileText, Gauge, KeyRound, MessageSquareText, Play, RefreshCw, Save, Timer } from 'lucide-react';
import { queryPromptPackage, renderPromptTemplate } from '@aptkit/prompts';
import { schemaSummary as querySchemaSummary } from '@aptkit/agent-query';
import { loadPromotedQueryFixtures, loadSavedQueryReplays, promoteQueryReplay, runServerQueryReplay, saveReplayArtifact } from './api';
import { runQueryFixtureReplay } from './agent-runners';
import { EvalPanel, Metric, Panel, PromptPackagePanel, ReplayModeSwitch, TracePanel } from './components';
import { queryFixtures } from './fixtures';
import { buildQueryReplayArtifact, estimateCost, formatCost, formatDuration, summarizeUsage } from './replay-artifacts';
import type { PromotedQueryFixtureSummary, ProviderStatus, QueryPromoteResult, QueryReplayMode, QueryReplayState, SavedQueryReplaySummary } from './types';

export function QueryWorkspace({ onHome }: { onHome: () => void }) {
  const [selectedFixtureId, setSelectedFixtureId] = React.useState(queryFixtures[0].id);
  const [mode, setMode] = React.useState<QueryReplayMode>('fixture');
  const [providerStatus, setProviderStatus] = React.useState<ProviderStatus>({
    fixture: { available: true, model: 'fixture-model' },
    anthropic: { available: false, model: 'claude-sonnet-4-6' },
    openai: { available: false, model: 'gpt-4.1' },
  });
  const [replay, setReplay] = React.useState<QueryReplayState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [runId, setRunId] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [savedReplays, setSavedReplays] = React.useState<SavedQueryReplaySummary[]>([]);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [promotingPath, setPromotingPath] = React.useState<string | null>(null);
  const [promoteResult, setPromoteResult] = React.useState<QueryPromoteResult | null>(null);
  const [promotedFixtures, setPromotedFixtures] = React.useState<PromotedQueryFixtureSummary[]>([]);
  const [promotedLoading, setPromotedLoading] = React.useState(false);
  const [promotedError, setPromotedError] = React.useState<string | null>(null);
  const runCounter = React.useRef(0);
  const selectedFixtureRef = React.useRef(queryFixtures[0]);
  const modeRef = React.useRef(mode);
  const fixture = queryFixtures.find((candidate) => candidate.id === selectedFixtureId) ?? queryFixtures[0];
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
        ? await runQueryFixtureReplay(fixtureToRun)
        : await runServerQueryReplay(fixtureToRun, modeToRun);
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
      setSavedReplays(await loadSavedQueryReplays());
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
      setPromotedFixtures(await loadPromotedQueryFixtures());
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
  }

  function selectMode(nextMode: QueryReplayMode) {
    setMode(nextMode);
    setReplay(null);
    setError(null);
    setSaveError(null);
  }

  async function saveCurrentReplay() {
    if (!replay) return;
    setSaving(true);
    setSaveError(null);
    try {
      const artifact = buildQueryReplayArtifact(fixture, replay, mode, providerStatus[mode].model);
      const savedPath = await saveReplayArtifact(artifact);
      setReplay((current) => current ? { ...current, savedPath } : current);
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
      const result = await promoteQueryReplay(path);
      setPromoteResult(result);
      await refreshPromotedFixtures();
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPromotingPath(null);
    }
  }

  const usage = summarizeUsage(replay?.trace ?? []);
  const modelName = usage.modelName || providerStatus[mode].model;
  const costEstimate = estimateCost(mode, usage, modelName);
  const latestReviewPath = replay?.savedPath ?? savedReplays.find((savedReplay) => savedReplay.fixture.id === fixture.id && savedReplay.provider.id === mode)?.path;
  const renderedPrompt = renderPromptTemplate(queryPromptPackage.system, {
    schema: querySchemaSummary(fixture.workspace),
    project_id: fixture.workspace.projectId,
    intent: fixture.intent,
  });

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Query Replay</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            <Boxes size={15} />
            <span>Home</span>
          </button>
          <ReplayModeSwitch
            ariaLabel="Query replay mode"
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
              {queryFixtures.map((candidate) => (
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

      <section className="metrics" aria-label="Query replay summary">
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
              <strong>{runId || replay?.runId || 0}</strong>
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
          <PromptPackagePanel
            promptPackage={queryPromptPackage}
            renderedPrompt={{ label: 'Rendered for fixture', prompt: renderedPrompt }}
          />

          <TracePanel running={running} trace={replay?.trace ?? []} />
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
    </main>
  );
}
