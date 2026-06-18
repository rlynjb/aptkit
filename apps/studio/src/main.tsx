import React from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, BadgeCheck, Boxes, BrainCircuit, CircleDollarSign, Gauge, Play, Route, ShieldCheck, Wrench } from 'lucide-react';
import { RecommendationAgent, FixtureModelProvider, type Anomaly, type Diagnosis, type Recommendation, type WorkspaceDescriptor } from '@aptkit/agent-recommendation';
import { assertRecommendationShape } from '@aptkit/evals';
import type { CapabilityEvent, ModelResponse } from '@aptkit/runtime';
import { InMemoryToolRegistry, type ToolDefinition, type ToolHandler } from '@aptkit/tools';
import fixtureData from '../../../packages/agents/recommendation/fixtures/sp-revenue-drop.json';
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
  evalIssues: string[];
  modelTurns: number;
  completedAt: string;
  runId: number;
};

type ReplayResult = Omit<ReplayState, 'completedAt' | 'runId'>;

const fixture = fixtureData as RecommendationFixture;

function runFixtureReplay(): Promise<ReplayResult> {
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
      evalIssues: evalResult.issues.map((issue) => `${issue.path}: ${issue.message}`),
      modelTurns: model.requests.length,
    };
  });
}

function App() {
  const [replay, setReplay] = React.useState<ReplayState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [runId, setRunId] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const runCounter = React.useRef(0);

  const startReplay = React.useCallback(async () => {
    const nextRunId = runCounter.current + 1;
    runCounter.current = nextRunId;
    setRunId(nextRunId);
    setRunning(true);
    setError(null);
    setReplay(null);
    try {
      const result = await runFixtureReplay();
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

  const totalTokens = replay?.trace.reduce((sum, event) => {
    if (event.type !== 'model_usage') return sum;
    return sum + (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
  }, 0) ?? 0;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Recommendation Agent Replay</h1>
        </div>
        <button className="runButton" onClick={startReplay} disabled={running}>
          <Play size={17} aria-hidden="true" />
          <span>{running ? 'Running' : 'Run Fixture'}</span>
        </button>
      </header>

      <section className="metrics" aria-label="Replay summary">
        <Metric icon={<BadgeCheck size={18} />} label="Eval" value={error ? 'Error' : replay?.evalOk ? 'Passing' : running ? 'Running' : 'Pending'} tone={replay?.evalOk ? 'good' : 'neutral'} />
        <Metric icon={<BrainCircuit size={18} />} label="Model Turns" value={String(replay?.modelTurns ?? 0)} />
        <Metric icon={<Wrench size={18} />} label="Tool Calls" value={String(replay?.trace.filter((event) => event.type === 'tool_call_end').length ?? 0)} />
        <Metric icon={<Gauge size={18} />} label="Run" value={replay ? `#${replay.runId}` : running ? `#${runId}` : '0'} />
      </section>

      <div className="layout">
        <section className="leftPane">
          <Panel title="Fixture" icon={<Boxes size={17} />}>
            <div className="kv">
              <span>ID</span>
              <strong>{fixture.id}</strong>
              <span>Status</span>
              <strong>{error ? 'error' : running ? 'running' : replay ? `completed at ${replay.completedAt}` : 'not run'}</strong>
              <span>Workspace</span>
              <strong>{fixture.workspace.projectName}</strong>
              <span>Tokens</span>
              <strong>{totalTokens.toLocaleString()}</strong>
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
            {running ? <div className="emptyState">Running fixture replay...</div> : null}
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

function Metric({ icon, label, value, tone = 'neutral' }: { icon: React.ReactNode; label: string; value: string; tone?: 'neutral' | 'good' }) {
  return (
    <div className={`metric ${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

createRoot(document.getElementById('root')!).render(<App />);
