import React from 'react';
import { BadgeCheck, Boxes, BrainCircuit, FileText, Gauge, ListChecks, Play, Scale, Timer } from 'lucide-react';
import { runRubricImprovementFixtureReplay } from './agent-runners';
import { EvalPanel, Metric, Panel, TracePanel } from './components';
import { rubricImprovementFixtures } from './fixtures';
import { formatDuration, summarizeUsage } from './replay-artifacts';
import type { RubricImprovementReplayState } from './types';

export function RubricImprovementWorkspace({ onHome }: { onHome: () => void }) {
  const [selectedFixtureId, setSelectedFixtureId] = React.useState(rubricImprovementFixtures[0].id);
  const [replay, setReplay] = React.useState<RubricImprovementReplayState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [runId, setRunId] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const runCounter = React.useRef(0);
  const selectedFixtureRef = React.useRef(rubricImprovementFixtures[0]);
  const fixture = rubricImprovementFixtures.find((candidate) => candidate.id === selectedFixtureId) ?? rubricImprovementFixtures[0];
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
      const result = await runRubricImprovementFixtureReplay(fixtureToRun);
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
  const result = replay?.result;
  const dimensionRows = result
    ? fixture.rubric.dimensions.map((dimension) => ({
      id: dimension.id,
      label: dimension.label,
      score: result.judgment.dimensions[dimension.id]?.score ?? 0,
      reason: result.judgment.dimensions[dimension.id]?.reason ?? 'Not scored',
      weak: result.weakestDimension === dimension.id,
    }))
    : [];

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Rubric Improvement Agent</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            <Boxes size={15} />
            <span>Home</span>
          </button>
          <label className="fixtureSelect">
            <span>Fixture</span>
            <select value={selectedFixtureId} onChange={selectFixture} disabled={running}>
              {rubricImprovementFixtures.map((candidate) => (
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

      <section className="metrics" aria-label="Rubric improvement summary">
        <Metric icon={<BadgeCheck size={18} />} label="Eval" value={error ? 'Error' : replay?.evalOk ? 'Passing' : running ? 'Running' : 'Pending'} tone={replay?.evalOk ? 'good' : 'neutral'} />
        <Metric icon={<Scale size={18} />} label="Verdict" value={result?.judgment.verdict ?? 'Pending'} />
        <Metric icon={<ListChecks size={18} />} label="Weakest" value={result?.weakestDimension ?? 'Pending'} />
        <Metric icon={<BrainCircuit size={18} />} label="Model" value="fixture-model" />
        <Metric icon={<Gauge size={18} />} label="Tokens" value={usage.totalTokens.toLocaleString()} />
        <Metric icon={<Timer size={18} />} label="Duration" value={replay ? formatDuration(replay.durationMs) : running ? 'Running' : '0ms'} />
      </section>

      <div className="layout">
        <section className="leftPane">
          <Panel title="Fixture" icon={<Boxes size={17} />}>
            <div className="kv">
              <span>ID</span>
              <strong>{fixture.id}</strong>
              <span>Rubric</span>
              <strong>{fixture.rubric.title}</strong>
              <span>Status</span>
              <strong>{error ? 'error' : running ? 'running' : replay ? `completed at ${replay.completedAt}` : 'not run'}</strong>
              <span>Run</span>
              <strong>{runId || replay?.runId || 0}</strong>
              <span>Turns</span>
              <strong>{replay?.modelTurns ?? 0}</strong>
            </div>
          </Panel>

          <Panel title="Workflow" icon={<FileText size={17} />}>
            <div className="workflow">
              <div className="layerCallout">
                <strong>Fake model + fake tools</strong>
                <span>The model can call rubric-history tools before producing structured improvement feedback.</span>
              </div>
              <ol className="workflowSteps">
                <li>Load the rubric and subject</li>
                <li>Read recent judgment history</li>
                <li>Score each rubric dimension</li>
                <li>Return one next action and optional drill</li>
              </ol>
            </div>
          </Panel>

          <EvalPanel
            error={error}
            evalOk={replay?.evalOk}
            issues={replay?.evalIssues ?? []}
            passedLabel="rubric improvement output valid"
            running={running}
          />
        </section>

        <section className="mainPane">
          <Panel title="Subject" icon={<FileText size={17} />}>
            <p className="answerText">{fixture.subject}</p>
          </Panel>

          <Panel title="Judgment" icon={<Scale size={17} />}>
            {result ? (
              <div className="rubricJudgment">
                <div className="reviewBanner ready">
                  <strong>{result.judgment.fix}</strong>
                  <span>{result.judgment.reasoning}</span>
                </div>
                <div className="scoreGrid">
                  {dimensionRows.map((dimension) => (
                    <div className={dimension.weak ? 'weakDimension' : ''} key={dimension.id}>
                      <span>{dimension.label}</span>
                      <strong>{dimension.score}</strong>
                      <p>{dimension.reason}</p>
                    </div>
                  ))}
                </div>
                {result.judgment.checks ? (
                  <div className="capabilityChecks">
                    {Object.entries(result.judgment.checks).map(([check, passed]) => (
                      <span className={passed ? 'passed' : ''} key={check}>{check}</span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="emptyState compact">{running ? 'Scoring rubric...' : 'No judgment yet.'}</div>
            )}
          </Panel>

          <Panel title="Next Improvement" icon={<ListChecks size={17} />}>
            {result ? (
              <div className="utilityPreview">
                <div className="layerCallout">
                  <strong>{result.nextAction}</strong>
                  <span>Focus dimension: {result.weakestDimension}</span>
                </div>
                {result.nextDrill ? (
                  <div className="reviewGrid">
                    <div>
                      <span>Prompt</span>
                      <strong>{result.nextDrill.prompt}</strong>
                    </div>
                    <div>
                      <span>Goal</span>
                      <strong>{result.nextDrill.goal}</strong>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="emptyState compact">{running ? 'Preparing next action...' : 'No improvement yet.'}</div>
            )}
          </Panel>
        </section>

        <aside className="rightPane">
          <TracePanel running={running} trace={replay?.trace ?? []} />
        </aside>
      </div>
    </main>
  );
}
