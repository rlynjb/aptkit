import React from 'react';
import { BadgeCheck, Boxes, BrainCircuit, CircleDollarSign, FileText, Gauge, ListChecks, Scale, Timer } from 'lucide-react';
import { runServerRubricImprovementReplay } from './api';
import { AgentReplayShell, type AgentReplayShellContext } from './AgentReplayShell';
import { runRubricImprovementFixtureReplay } from './agent-runners';
import { EvalPanel, Metric, Panel, ProviderStatusPanel, TracePanel } from './components';
import { rubricImprovementFixtures } from './fixtures';
import { formatCost, formatDuration } from './replay-artifacts';
import { STATIC_DEMO } from './env';
import type { RubricImprovementFixture, RubricImprovementReplayMode, RubricImprovementReplayResult } from './types';

type RubricShellContext = AgentReplayShellContext<
RubricImprovementFixture,
RubricImprovementReplayMode,
RubricImprovementReplayResult
>;

export function RubricImprovementWorkspace({ onHome }: { onHome: () => void }) {
  return (
    <AgentReplayShell
      ariaLabel="Rubric improvement replay mode"
      fixtures={rubricImprovementFixtures}
      getFixtureId={(fixture) => fixture.id}
      initialMode="fixture"
      metricItems={rubricMetrics}
      modeClassName="monitoringModeSwitch"
      modes={[
        { mode: 'fixture', label: 'Fixture' },
        { mode: 'openai', label: 'OpenAI' },
      ]}
      onHome={onHome}
      renderPanels={rubricPanels}
      runFixture={runRubricImprovementFixtureReplay}
      runServer={runServerRubricImprovementReplay}
      title="Rubric Improvement Agent"
    />
  );
}

function rubricMetrics(context: RubricShellContext) {
  const result = context.replay?.result;
  return (
    <>
      <Metric icon={<BadgeCheck size={18} />} label="Eval" value={context.error ? 'Error' : context.replay?.evalOk ? 'Passing' : context.running ? 'Running' : 'Pending'} tone={context.replay?.evalOk ? 'good' : 'neutral'} />
      <Metric icon={<Scale size={18} />} label="Verdict" value={result?.judgment.verdict ?? 'Pending'} />
      <Metric icon={<ListChecks size={18} />} label="Weakest" value={result?.weakestDimension ?? 'Pending'} />
      <Metric icon={<BrainCircuit size={18} />} label="Model" value={context.modelName} />
      <Metric icon={<Gauge size={18} />} label="Tokens" value={context.usage.totalTokens.toLocaleString()} />
      <Metric icon={<CircleDollarSign size={18} />} label="Est. Cost" value={formatCost(context.costEstimate)} />
      <Metric icon={<Timer size={18} />} label="Duration" value={context.replay ? formatDuration(context.replay.durationMs) : context.running ? 'Running' : '0ms'} />
      <Metric icon={<Boxes size={18} />} label="Run" value={`#${context.runId || context.replay?.runId || 0}`} />
    </>
  );
}

function rubricPanels(context: RubricShellContext) {
  const { error, fixture, mode, providerStatus, replay, running, usage, visibleTrace } = context;
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
            <span>Mode</span>
            <strong>{mode} / {providerStatus[mode].model}{providerStatus[mode].available ? '' : ' unavailable'}</strong>
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

        <Panel title="Workflow" icon={<FileText size={17} />}>
          <div className="workflow">
            <div className="layerCallout">
              <strong>{mode === 'fixture' ? 'Fake model + fake tools' : 'Real model + fake tools'}</strong>
              <span>{mode === 'fixture' ? 'Deterministic rubric replay for UI validation.' : 'OpenAI scores controlled fixture data through AptKit agent/tool seams.'}</span>
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
          {running ? <div className="emptyState compact">Scoring rubric...</div> : null}
          {!providerStatus[mode].available ? <div className="errorState">{STATIC_DEMO ? 'Live model replay is available in local dev only — this is a static fixture demo.' : 'Set OPENAI_API_KEY and restart Studio to enable OpenAI rubric improvement replay.'}</div> : null}
          {error ? <div className="errorState">{error}</div> : null}
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
          ) : !running && !error ? (
            <div className="emptyState compact">No judgment yet.</div>
          ) : null}
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
        <ProviderStatusPanel
          mode={mode}
          providerStatus={providerStatus}
          supportedModes={['fixture', 'openai']}
          trace={visibleTrace}
        />
        <TracePanel running={running} trace={visibleTrace} />
      </aside>
    </div>
  );
}
