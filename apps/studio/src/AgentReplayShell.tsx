import React from 'react';
import { Boxes, ChevronDown, Cloud, KeyRound, Play } from 'lucide-react';
import type { CapabilityEvent, CostEstimate, TokenUsageSummary } from '@aptkit/runtime';
import { loadProviderStatus } from './api';
import { ReplayModeSwitch } from './components';
import { STATIC_DEMO } from './env';
import { estimateCost, summarizeUsage } from './replay-artifacts';
import type { ProviderStatus } from './types';

export type ReplayModeOption<M extends string> = {
  mode: M;
  label: string;
  icon?: React.ReactNode;
};

export type ReplayResultBase = {
  trace: CapabilityEvent[];
  evalOk: boolean;
  evalIssueDetails: { path: string; message: string }[];
  evalIssues: string[];
  modelTurns: number;
  durationMs: number;
};

export type ReplayStateFor<R extends ReplayResultBase> = R & {
  completedAt: string;
  runId: number;
};

export type AgentReplayShellContext<F, M extends string, R extends ReplayResultBase> = {
  fixture: F;
  mode: M;
  providerStatus: ProviderStatus;
  replay: ReplayStateFor<R> | null;
  visibleTrace: CapabilityEvent[];
  usage: TokenUsageSummary;
  modelName: string;
  costEstimate: CostEstimate | undefined;
  running: boolean;
  runId: number;
  error: string | null;
  setReplay: React.Dispatch<React.SetStateAction<ReplayStateFor<R> | null>>;
  setRunId: React.Dispatch<React.SetStateAction<number>>;
  startReplay: () => Promise<void>;
  selectMode: (mode: M) => void;
};

export function AgentReplayShell<F, M extends string, R extends ReplayResultBase>({
  ariaLabel,
  fixtureLabel = 'Fixture',
  fixtures,
  getFixtureId,
  initialMode,
  metricItems,
  modeClassName,
  modes,
  onFixtureChange,
  onHome,
  onModeChange,
  renderPanels,
  runFixture,
  runServer,
  title,
}: {
  ariaLabel: string;
  fixtureLabel?: string;
  fixtures: F[];
  getFixtureId: (fixture: F) => string;
  initialMode: M;
  metricItems: (context: AgentReplayShellContext<F, M, R>) => React.ReactNode;
  modeClassName?: string;
  modes: ReplayModeOption<M>[];
  onFixtureChange?: () => void;
  onHome: () => void;
  onModeChange?: () => void;
  renderPanels: (context: AgentReplayShellContext<F, M, R>) => React.ReactNode;
  runFixture: (fixture: F) => Promise<R>;
  runServer: (
    fixture: F,
    mode: Exclude<M, 'fixture'>,
    options: { onEvent?: (event: CapabilityEvent) => void },
  ) => Promise<R>;
  title: string;
}) {
  const [selectedFixtureId, setSelectedFixtureId] = React.useState(getFixtureId(fixtures[0]));
  const [mode, setMode] = React.useState<M>(initialMode);
  const [providerStatus, setProviderStatus] = React.useState<ProviderStatus>({
    fixture: { available: true, model: 'fixture-model' },
    anthropic: { available: false, model: 'claude-sonnet-4-6' },
    openai: { available: false, model: 'gpt-4.1' },
  });
  const [replay, setReplay] = React.useState<ReplayStateFor<R> | null>(null);
  const [liveTrace, setLiveTrace] = React.useState<CapabilityEvent[]>([]);
  const [running, setRunning] = React.useState(false);
  const [runId, setRunId] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);
  const runCounter = React.useRef(0);
  const selectedFixtureRef = React.useRef(fixtures[0]);
  const modeRef = React.useRef(mode);
  const fixture = fixtures.find((candidate) => getFixtureId(candidate) === selectedFixtureId) ?? fixtures[0];
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
    setReplay(null);
    setLiveTrace([]);
    try {
      const onEvent = (event: CapabilityEvent) => {
        setLiveTrace((current) => runCounter.current === nextRunId ? [...current, event] : current);
      };
      const result = modeToRun === 'fixture'
        ? await runFixture(fixtureToRun)
        : await runServer(fixtureToRun, modeToRun as Exclude<M, 'fixture'>, { onEvent });
      setLiveTrace(result.trace);
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
  }, [runFixture, runServer]);

  React.useEffect(() => {
    void startReplay();
  }, [startReplay]);

  React.useEffect(() => {
    if (STATIC_DEMO) return;
    loadProviderStatus()
      .then(setProviderStatus)
      .catch(() => {
        setProviderStatus((current) => current);
      });
  }, []);

  function selectFixture(event: React.ChangeEvent<HTMLSelectElement>) {
    setSelectedFixtureId(event.target.value);
    setReplay(null);
    setLiveTrace([]);
    setError(null);
    onFixtureChange?.();
  }

  function selectMode(nextMode: M) {
    setMode(nextMode);
    setReplay(null);
    setLiveTrace([]);
    setError(null);
    onModeChange?.();
  }

  const visibleTrace = replay?.trace ?? liveTrace;
  const usage = summarizeUsage(visibleTrace);
  const modelName = usage.modelName || providerStatus[providerKey(mode)].model;
  const costEstimate = estimateCost(mode, usage, modelName);
  const context: AgentReplayShellContext<F, M, R> = {
    fixture,
    mode,
    providerStatus,
    replay,
    visibleTrace,
    usage,
    modelName,
    costEstimate,
    running,
    runId,
    error,
    setReplay,
    setRunId,
    startReplay,
    selectMode,
  };

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>{title}</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            <Boxes size={15} />
            <span>Home</span>
          </button>
          <ReplayModeSwitch
            ariaLabel={ariaLabel}
            className={modeClassName}
            mode={mode}
            onSelect={selectMode}
            options={modes.map((option) => ({
              ...option,
              available: providerStatus[providerKey(option.mode)].available,
              icon: option.icon ?? defaultModeIcon(option.mode),
            }))}
          />
          <label className="fixtureSelect">
            <span>{fixtureLabel}</span>
            <ChevronDown size={16} aria-hidden="true" />
            <select value={selectedFixtureId} onChange={selectFixture} disabled={running}>
              {fixtures.map((candidate) => {
                const id = getFixtureId(candidate);
                return (
                  <option key={id} value={id}>
                    {id}
                  </option>
                );
              })}
            </select>
          </label>
          <button className="runButton" onClick={startReplay} disabled={running || !providerStatus[providerKey(mode)].available}>
            <Play size={17} aria-hidden="true" />
            <span>{running ? 'Running' : mode === 'fixture' ? 'Run Fixture' : `Run ${modeLabel(mode)}`}</span>
          </button>
        </div>
      </header>

      <section className="metrics" aria-label={`${title} summary`}>
        {metricItems(context)}
      </section>

      {renderPanels(context)}
    </main>
  );
}

function providerKey(mode: string): keyof ProviderStatus {
  if (mode === 'anthropic') return 'anthropic';
  if (mode === 'openai') return 'openai';
  return 'fixture';
}

function modeLabel(mode: string): string {
  if (mode === 'openai') return 'OpenAI';
  if (mode === 'anthropic') return 'Anthropic';
  return mode;
}

function defaultModeIcon(mode: string): React.ReactNode {
  if (mode === 'openai') return <KeyRound size={15} />;
  if (mode === 'anthropic') return <Cloud size={15} />;
  return <Boxes size={15} />;
}
