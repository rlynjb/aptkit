import React from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, BadgeCheck, Boxes, BrainCircuit, Check, ChevronDown, CircleDollarSign, Clipboard, Cloud, Gauge, History, KeyRound, Play, RefreshCw, Route, Save, ShieldCheck, Timer } from 'lucide-react';
import { RecommendationAgent, FixtureModelProvider, type Anomaly, type Diagnosis, type Recommendation, type WorkspaceDescriptor } from '@aptkit/agent-recommendation';
import { assertRecommendationShape } from '@aptkit/evals';
import type { CapabilityEvent, ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import electronicsSpikeFixture from '../../../packages/agents/recommendation/fixtures/electronics-spike.json';
import spRevenueDropFixture from '../../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
import voucherDropoffFixture from '../../../packages/agents/recommendation/fixtures/voucher-dropoff.json';
import './styles.css';

type FixtureTool = ToolDefinition & { result: unknown };

type RecommendationFixture = {
  id: string;
  description: string;
  workspace: WorkspaceDescriptor;
  anomaly: Anomaly;
  diagnosis: Diagnosis;
  tools: FixtureTool[];
  modelResponses: ModelResponse[];
};

type ReplayState = {
  recommendations: Recommendation[];
  trace: CapabilityEvent[];
  evalOk: boolean;
  evalIssueDetails: { path: string; message: string }[];
  evalIssues: string[];
  modelTurns: number;
  durationMs: number;
  completedAt: string;
  runId: number;
  savedPath?: string;
};

type ReplayResult = Omit<ReplayState, 'completedAt' | 'runId'>;

type ReplayMode = 'fixture' | 'anthropic' | 'openai';

type ProviderStatus = Record<ReplayMode, { available: boolean; model: string }>;

type ReplayArtifact = {
  schemaVersion: 1;
  createdAt: string;
  durationMs: number;
  provider: {
    id: ReplayMode;
    model: string;
  };
  fixture: {
    id: string;
    description: string;
    path: string;
  };
  recommendations: Recommendation[];
  trace: CapabilityEvent[];
  eval: {
    name: string;
    ok: boolean;
    issues: { path: string; message: string }[];
  };
  modelTurns: number;
};

type SavedReplaySummary = {
  path: string;
  createdAt: string;
  provider: { id: string; model: string };
  fixture: { id: string; description?: string; path?: string };
  evalOk: boolean;
  issues: { path: string; message: string }[];
  recommendationCount: number;
  durationMs: number;
  modelTurns: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
};

type PromoteResult = {
  path: string;
  id: string;
  sourceArtifact: string;
  recommendationCount: number;
};

const fixtures = [
  spRevenueDropFixture,
  electronicsSpikeFixture,
  voucherDropoffFixture,
] as RecommendationFixture[];

function runFixtureReplay(fixture: RecommendationFixture): Promise<ReplayResult> {
  const startedAt = performance.now();
  const handlers: Record<string, ToolHandler> = {};
  for (const tool of fixture.tools) {
    handlers[tool.name] = () => tool.result;
  }

  const model = new FixtureModelProvider(fixture.modelResponses);
  const tools = new InMemoryToolRegistry(fixture.tools, handlers);
  const trace: CapabilityEvent[] = [];
  const idGenerator = (() => {
    let index = 0;
    return () => `${fixture.id}-studio-${++index}`;
  })();

  const agent = new RecommendationAgent({
    model,
    tools,
    workspace: fixture.workspace,
    idGenerator,
    trace: { emit: (event) => trace.push(event) },
  });

  return agent.propose(fixture.anomaly, fixture.diagnosis).then((recommendations) => {
    const evalResult = assertRecommendationShape(recommendations);
    return {
      recommendations,
      trace,
      evalOk: evalResult.ok,
      evalIssueDetails: evalResult.issues,
      evalIssues: evalResult.issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
      durationMs: Math.round(performance.now() - startedAt),
    };
  });
}

async function runServerReplay(fixture: RecommendationFixture, mode: Exclude<ReplayMode, 'fixture'>): Promise<ReplayResult> {
  const response = await fetch('/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fixtureId: fixture.id, mode }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'live replay failed');
  }
  return {
    recommendations: payload.recommendations,
    trace: payload.trace,
    evalOk: payload.eval.ok,
    evalIssueDetails: payload.eval.issues,
    evalIssues: payload.eval.issues.map((issue: { path: string; message: string }) => `${issue.path}: ${issue.message}`),
    modelTurns: payload.modelTurns,
    durationMs: payload.durationMs,
  };
}

async function saveReplayArtifact(artifact: ReplayArtifact): Promise<string> {
  const response = await fetch('/api/replay/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ artifact }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'save replay failed');
  }
  return payload.path;
}

async function loadSavedReplays(): Promise<SavedReplaySummary[]> {
  const response = await fetch('/api/replays');
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'load replays failed');
  }
  return payload.replays;
}

async function promoteReplay(path: string): Promise<PromoteResult> {
  const response = await fetch('/api/replays/promote', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error ?? 'promote replay failed');
  }
  return payload;
}

function App() {
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
  const [promotingPath, setPromotingPath] = React.useState<string | null>(null);
  const [promoteResult, setPromoteResult] = React.useState<PromoteResult | null>(null);
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

  function selectFixture(event: React.ChangeEvent<HTMLSelectElement>) {
    setSelectedFixtureId(event.target.value);
    setReplay(null);
    setError(null);
    setSaveError(null);
  }

  function selectMode(nextMode: ReplayMode) {
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
      const artifact = buildReplayArtifact(fixture, replay, mode, providerStatus[mode].model);
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
      const result = await promoteReplay(path);
      setPromoteResult(result);
    } catch (caught) {
      setHistoryError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPromotingPath(null);
    }
  }

  const usage = summarizeUsage(replay?.trace ?? []);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Recommendation Agent Replay</h1>
        </div>
        <div className="topbarActions">
          <div className="modeSwitch" aria-label="Replay mode">
            <ModeButton
              active={mode === 'fixture'}
              available
              icon={<Boxes size={15} />}
              label="Fixture"
              onClick={() => selectMode('fixture')}
            />
            <ModeButton
              active={mode === 'anthropic'}
              available={providerStatus.anthropic.available}
              icon={<Cloud size={15} />}
              label="Anthropic"
              onClick={() => selectMode('anthropic')}
            />
            <ModeButton
              active={mode === 'openai'}
              available={providerStatus.openai.available}
              icon={<KeyRound size={15} />}
              label="OpenAI"
              onClick={() => selectMode('openai')}
            />
          </div>
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
        <Metric icon={<BrainCircuit size={18} />} label="Model" value={usage.modelName || providerStatus[mode].model} />
        <Metric icon={<Gauge size={18} />} label="Tokens" value={usage.totalTokens.toLocaleString()} />
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

          <ReplayHistoryPanel
            replays={savedReplays}
            loading={historyLoading}
            error={historyError}
            promotingPath={promotingPath}
            promoteResult={promoteResult}
            onRefresh={() => void refreshReplayHistory()}
            onPromote={(path) => void promoteSavedReplay(path)}
          />

          <Panel title="Trace" icon={<BrainCircuit size={17} />}>
            {running ? <div className="emptyState compact">Collecting trace events...</div> : null}
            <div className="traceList">
              {(replay?.trace ?? []).map((event, index) => (
                <TraceItem event={event} index={index} key={`${event.type}-${index}`} />
              ))}
            </div>
          </Panel>

          <Panel title="Eval" icon={<ShieldCheck size={17} />}>
            <div className={error ? 'evalError' : replay?.evalOk ? 'evalPass' : 'evalPending'}>
              {error ? 'replay failed' : replay?.evalOk ? 'recommendation-shape passed' : running ? 'replay running' : 'waiting for replay'}
            </div>
            {replay?.evalIssues.length ? (
              <ul className="issueList">
                {replay.evalIssues.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            ) : null}
          </Panel>
        </aside>
      </div>
    </main>
  );
}

function buildReplayArtifact(
  fixture: RecommendationFixture,
  replay: ReplayState,
  mode: ReplayMode,
  fallbackModel: string,
): ReplayArtifact {
  const usage = summarizeUsage(replay.trace);
  return {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    durationMs: replay.durationMs,
    provider: {
      id: mode,
      model: usage.modelName || fallbackModel,
    },
    fixture: {
      id: fixture.id,
      description: fixture.description,
      path: fixturePath(fixture.id),
    },
    recommendations: replay.recommendations,
    trace: replay.trace,
    eval: {
      name: 'recommendation-shape',
      ok: replay.evalOk,
      issues: replay.evalIssueDetails,
    },
    modelTurns: replay.modelTurns,
  };
}

function fixturePath(fixtureId: string): string {
  const knownPaths: Record<string, string> = {
    [spRevenueDropFixture.id]: 'packages/agents/recommendation/fixtures/sp-revenue-drop.json',
    [electronicsSpikeFixture.id]: 'packages/agents/recommendation/fixtures/electronics-spike.json',
    [voucherDropoffFixture.id]: 'packages/agents/recommendation/fixtures/voucher-dropoff.json',
  };
  return knownPaths[fixtureId] ?? `packages/agents/recommendation/fixtures/${fixtureId}.json`;
}

function summarizeUsage(trace: CapabilityEvent[]) {
  return trace.reduce(
    (summary, event) => {
      if (event.type !== 'model_usage') return summary;
      return {
        inputTokens: summary.inputTokens + (event.inputTokens ?? 0),
        outputTokens: summary.outputTokens + (event.outputTokens ?? 0),
        totalTokens: summary.totalTokens + (event.inputTokens ?? 0) + (event.outputTokens ?? 0),
        modelName: event.model || summary.modelName,
      };
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0, modelName: '' },
  );
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function WorkflowPanel({
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
        <div className="saveReplay">
          <button type="button" onClick={onSave} disabled={!replay || saving}>
            <Save size={15} />
            <span>{saving ? 'Saving' : replay?.savedPath ? 'Saved' : 'Save Replay'}</span>
          </button>
          <code>{replay?.savedPath ?? 'No saved artifact yet'}</code>
          {saveError ? <p>{saveError}</p> : null}
        </div>
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

function ReplayHistoryPanel({
  replays,
  loading,
  error,
  promotingPath,
  promoteResult,
  onRefresh,
  onPromote,
}: {
  replays: SavedReplaySummary[];
  loading: boolean;
  error: string | null;
  promotingPath: string | null;
  promoteResult: PromoteResult | null;
  onRefresh: () => void;
  onPromote: (path: string) => void;
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
        {promoteResult ? (
          <div className="historySuccess">
            <strong>Promoted</strong>
            <code>{promoteResult.path}</code>
          </div>
        ) : null}
        {!loading && visibleReplays.length === 0 ? <div className="emptyState compact">No saved replays found.</div> : null}
        <div className="historyList">
          {visibleReplays.map((replay) => (
            <article className="historyItem" key={replay.path}>
              <div className="historyHeader">
                <strong>{replay.fixture.id}</strong>
                <span className={replay.evalOk ? 'statusPill good' : 'statusPill bad'}>{replay.evalOk ? 'pass' : 'fail'}</span>
              </div>
              <div className="historyMeta">
                <span>{replay.provider.id} / {replay.provider.model}</span>
                <span>{replay.recommendationCount} recs</span>
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
                onClick={() => onPromote(replay.path)}
                disabled={!replay.evalOk || promotingPath === replay.path}
              >
                <Save size={15} />
                <span>{promotingPath === replay.path ? 'Promoting' : 'Promote'}</span>
              </button>
            </article>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function Metric({ icon, label, value, tone = 'neutral' }: { icon: React.ReactNode; label: string; value: string; tone?: 'neutral' | 'good' }) {
  return (
    <div className={`metric ${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ModeButton({
  active,
  available,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  available: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={active ? 'modeButton active' : 'modeButton'} disabled={!available} onClick={onClick} type="button">
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Panel({ title, icon, children, wide = false }: { title: string; icon: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? 'panel wide' : 'panel'}>
      <header>
        {icon}
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

function TraceItem({ event, index }: { event: CapabilityEvent; index: number }) {
  const detail =
    event.type === 'model_usage'
      ? `${event.provider}/${event.model} · ${(event.inputTokens ?? 0) + (event.outputTokens ?? 0)} tokens`
      : event.type === 'tool_call_start'
        ? `${event.toolName}`
        : event.type === 'tool_call_end'
          ? `${event.toolName} · ${event.durationMs}ms`
          : event.type === 'step'
            ? event.content.slice(0, 120)
            : 'message' in event ? event.message : '';

  return (
    <div className="traceItem">
      <span>{String(index + 1).padStart(2, '0')}</span>
      <div>
        <strong>{event.type}</strong>
        <p>{detail}</p>
      </div>
    </div>
  );
}

const rootHost = window as Window & { __aptkitStudioRoot?: ReturnType<typeof createRoot> };
rootHost.__aptkitStudioRoot ??= createRoot(document.getElementById('root')!);
rootHost.__aptkitStudioRoot.render(<App />);
