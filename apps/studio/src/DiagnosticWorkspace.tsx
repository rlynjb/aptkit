import React from 'react';
import { Activity, BadgeCheck, Boxes, BrainCircuit, ChevronDown, Gauge, History, Play, Route, SearchCheck, Timer } from 'lucide-react';
import { runDiagnosticFixtureReplay } from './agent-runners';
import { EvalPanel, Metric, Panel, TracePanel } from './components';
import { diagnosticFixtures } from './fixtures';
import { formatDuration, summarizeUsage } from './replay-artifacts';
import type { DiagnosticReplayState } from './types';

export function DiagnosticWorkspace({ onHome }: { onHome: () => void }) {
  const [selectedFixtureId, setSelectedFixtureId] = React.useState(diagnosticFixtures[0].id);
  const [replay, setReplay] = React.useState<DiagnosticReplayState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [runId, setRunId] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const runCounter = React.useRef(0);
  const selectedFixtureRef = React.useRef(diagnosticFixtures[0]);
  const fixture = diagnosticFixtures.find((candidate) => candidate.id === selectedFixtureId) ?? diagnosticFixtures[0];
  selectedFixtureRef.current = fixture;

  const startReplay = React.useCallback(async () => {
    const fixtureToRun = selectedFixtureRef.current;
    const nextRunId = runCounter.current + 1;
    runCounter.current = nextRunId;
    setRunId(nextRunId);
    setRunning(true);
    setError(null);
    setReplay(null);
    try {
      const result = await runDiagnosticFixtureReplay(fixtureToRun);
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

  function selectFixture(event: React.ChangeEvent<HTMLSelectElement>) {
    setSelectedFixtureId(event.target.value);
    setReplay(null);
    setError(null);
  }

  const usage = summarizeUsage(replay?.trace ?? []);
  const diagnosis = replay?.diagnosis;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Diagnostic Investigation Replay</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            <Boxes size={15} />
            <span>Home</span>
          </button>
          <label className="fixtureSelect">
            <span>Fixture</span>
            <ChevronDown size={16} aria-hidden="true" />
            <select value={selectedFixtureId} onChange={selectFixture} disabled={running}>
              {diagnosticFixtures.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.id}
                </option>
              ))}
            </select>
          </label>
          <button className="runButton" onClick={startReplay} disabled={running}>
            <Play size={17} aria-hidden="true" />
            <span>{running ? 'Running' : 'Run Fixture'}</span>
          </button>
        </div>
      </header>

      <section className="metrics" aria-label="Diagnostic replay summary">
        <Metric icon={<BadgeCheck size={18} />} label="Eval" value={error ? 'Error' : replay?.evalOk ? 'Passing' : running ? 'Running' : 'Pending'} tone={replay?.evalOk ? 'good' : 'neutral'} />
        <Metric icon={<BrainCircuit size={18} />} label="Model" value="fixture-model" />
        <Metric icon={<Gauge size={18} />} label="Tokens" value={usage.totalTokens.toLocaleString()} />
        <Metric icon={<SearchCheck size={18} />} label="Confidence" value={diagnosis?.confidence ?? 'pending'} />
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
              <span>Workspace</span>
              <strong>{fixture.workspace.projectName}</strong>
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
            {running ? <div className="emptyState">Running fixture diagnostic replay...</div> : null}
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
          <TracePanel running={running} trace={replay?.trace ?? []} />

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
                <strong>Fake model + fake tools</strong>
                <span>Deterministic diagnostic replay for UI validation and regression checks.</span>
              </div>
              <ol className="workflowSteps">
                <li>Load anomaly fixture</li>
                <li>Test competing hypotheses</li>
                <li>Query context and timeseries tools</li>
                <li>Validate diagnosis JSON</li>
              </ol>
            </div>
          </Panel>
        </aside>
      </div>
    </main>
  );
}
