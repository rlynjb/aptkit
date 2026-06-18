import React from 'react';
import { Boxes, BrainCircuit, ChevronDown, Database, FileJson, Gauge, KeyRound, Play, Rows3, Timer } from 'lucide-react';
import {
  FixtureSyntheticEcommerceDataSource,
  SyntheticEcommerceToolRegistry,
  syntheticEcommerceToolDefinitions,
} from '@aptkit/provider-synthetic';
import { loadProviderStatus, runServerSyntheticTool, type SyntheticToolMode } from './api';
import { Metric, Panel, ReplayModeSwitch } from './components';
import type { ProviderStatus } from './types';

type ToolRunState = {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  completedAt: string;
  mode: SyntheticToolMode;
  provider: { id: SyntheticToolMode; model: string };
};

const toolArgs: Record<string, Record<string, unknown>> = {
  get_project_overview: {},
  get_metric_timeseries: {
    metric: 'revenue',
    dimension: 'state',
    segment: 'SP',
    granularity: 'week',
  },
  get_anomaly_context: {
    metric: 'revenue',
    dimension: 'state',
    segment: 'SP',
  },
};

export function SyntheticDataWorkspace({ onHome }: { onHome: () => void }) {
  const dataSource = React.useMemo(() => new FixtureSyntheticEcommerceDataSource(), []);
  const registry = React.useMemo(() => new SyntheticEcommerceToolRegistry({ dataSource }), [dataSource]);
  const tools = React.useMemo(() => registry.listTools(), [registry]);
  const [mode, setMode] = React.useState<SyntheticToolMode>('fixture');
  const [providerStatus, setProviderStatus] = React.useState<ProviderStatus>({
    fixture: { available: true, model: 'fixture-model' },
    anthropic: { available: false, model: 'claude-sonnet-4-6' },
    openai: { available: false, model: 'gpt-4.1' },
  });
  const [selectedToolName, setSelectedToolName] = React.useState(tools[0]?.name ?? 'get_project_overview');
  const [run, setRun] = React.useState<ToolRunState | null>(null);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const selectedTool = tools.find((tool) => tool.name === selectedToolName) ?? tools[0];
  const selectedArgs = toolArgs[selectedToolName] ?? {};
  const dataHorizonLabel = dataSource.workspace.dataHorizon
    ? `${dataSource.workspace.dataHorizon.durationDays} days`
    : 'unknown';
  const providerModel = mode === 'openai' ? providerStatus.openai.model : 'fixture-model';

  React.useEffect(() => {
    loadProviderStatus()
      .then(setProviderStatus)
      .catch(() => {
        setProviderStatus((current) => current);
      });
  }, []);

  const runTool = React.useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      if (mode === 'openai') {
        const response = await runServerSyntheticTool(selectedToolName, selectedArgs, mode);
        setRun({
          name: selectedToolName,
          args: selectedArgs,
          result: response.result,
          durationMs: response.durationMs,
          completedAt: new Date().toLocaleTimeString(),
          mode,
          provider: response.provider,
        });
        return;
      }

      const response = await registry.callTool(selectedToolName, selectedArgs);
      setRun({
        name: selectedToolName,
        args: selectedArgs,
        result: response.result,
        durationMs: response.durationMs,
        completedAt: new Date().toLocaleTimeString(),
        mode,
        provider: { id: 'fixture', model: 'fixture-model' },
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  }, [mode, registry, selectedArgs, selectedToolName]);

  React.useEffect(() => {
    void runTool();
  }, [runTool]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">AptKit Studio</p>
          <h1>Synthetic Data Provider</h1>
        </div>
        <div className="topbarActions">
          <button className="secondaryAction topbarHome" type="button" onClick={onHome}>
            <Boxes size={15} />
            <span>Home</span>
          </button>
          <ReplayModeSwitch
            ariaLabel="Synthetic provider mode"
            className="monitoringModeSwitch"
            mode={mode}
            onSelect={(nextMode) => {
              setMode(nextMode);
              setRun(null);
              setError(null);
            }}
            options={[
              { mode: 'fixture', available: true, icon: <Boxes size={15} />, label: 'Fixture' },
              { mode: 'openai', available: providerStatus.openai.available, icon: <KeyRound size={15} />, label: 'OpenAI' },
            ]}
          />
          <label className="fixtureSelect">
            <span>Tool</span>
            <ChevronDown size={16} aria-hidden="true" />
            <select value={selectedToolName} onChange={(event) => setSelectedToolName(event.target.value)} disabled={running}>
              {tools.map((tool) => (
                <option key={tool.name} value={tool.name}>
                  {tool.name}
                </option>
              ))}
            </select>
          </label>
          <button className="runButton" type="button" onClick={() => void runTool()} disabled={running || !providerStatus[mode].available}>
            <Play size={17} aria-hidden="true" />
            <span>{running ? 'Running' : mode === 'openai' ? 'Run OpenAI' : 'Run Fixture'}</span>
          </button>
        </div>
      </header>

      <section className="metrics" aria-label="Synthetic data provider summary">
        <Metric icon={<Database size={18} />} label="Mode" value={mode} tone={providerStatus[mode].available ? 'good' : 'neutral'} />
        <Metric icon={<Rows3 size={18} />} label="Tools" value={tools.length.toString()} />
        <Metric icon={<BrainCircuit size={18} />} label="Model" value={providerModel} />
        <Metric icon={<Gauge size={18} />} label="Events" value={dataSource.workspace.totalEvents.toLocaleString()} />
        <Metric icon={<Timer size={18} />} label="Horizon" value={dataHorizonLabel} />
      </section>

      <div className="layout syntheticLayout">
        <section className="leftPane">
          <Panel title="Provider" icon={<Database size={17} />}>
            <div className="kv">
              <span>ID</span>
              <strong>{dataSource.workspace.projectId}</strong>
              <span>Scenario</span>
              <strong>{dataSource.scenarioId}</strong>
              <span>Mode</span>
              <strong>{mode} / {providerModel}{providerStatus[mode].available ? '' : ' unavailable'}</strong>
              <span>Events</span>
              <strong>{dataSource.workspace.events.map((event) => event.name).join(', ')}</strong>
              <span>Catalogs</span>
              <strong>{dataSource.workspace.catalogs.map((catalog) => catalog.name).join(', ')}</strong>
            </div>
          </Panel>

          <Panel title="Source Boundary" icon={<BrainCircuit size={17} />}>
            <div className="workflow">
              <div className="layerCallout">
                <strong>{mode === 'openai' ? 'OpenAI source active' : 'Fixture source active'}</strong>
                <span>{mode === 'openai' ? 'A server endpoint calls OpenAI and returns synthetic provider JSON without exposing the API key.' : 'Deterministic workspace metadata, metric series, and anomaly context run directly in the browser.'}</span>
              </div>
              <div className="layerCallout">
                <strong>Same tool contract</strong>
                <span>Fixture and OpenAI modes both use the same data source interface and ToolRegistry adapter.</span>
              </div>
              <ol className="workflowSteps">
                <li>Data source owns synthetic ecommerce records</li>
                <li>ToolRegistry exposes provider methods to agents</li>
                <li>Agents consume tools without knowing fixture vs model source</li>
              </ol>
            </div>
          </Panel>
        </section>

        <section className="mainPane">
          <Panel title="Tool Output" icon={<FileJson size={17} />}>
            {!providerStatus[mode].available ? <div className="errorState compact">Set OPENAI_API_KEY and restart Studio to enable OpenAI synthetic data.</div> : null}
            {error ? <div className="errorState">{error}</div> : null}
            {run ? (
              <div className="jsonViewer">
                <div className="jsonViewerHeader">
                  <strong>{run.name}</strong>
                  <span>{run.mode} / {run.provider.model} / {run.completedAt} / {run.durationMs}ms</span>
                </div>
                <pre>{JSON.stringify({ args: run.args, result: run.result }, null, 2)}</pre>
              </div>
            ) : (
              <div className="emptyState">{running ? 'Running provider tool' : 'No provider run yet'}</div>
            )}
          </Panel>
        </section>

        <section className="rightPane">
          <Panel title="Tool Definitions" icon={<Rows3 size={17} />}>
            <div className="toolDefinitionList">
              {syntheticEcommerceToolDefinitions.map((tool) => (
                <button
                  key={tool.name}
                  className={tool.name === selectedToolName ? 'toolDefinition active' : 'toolDefinition'}
                  type="button"
                  onClick={() => setSelectedToolName(tool.name)}
                >
                  <strong>{tool.name}</strong>
                  <span>{tool.description}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel title="Selected Schema" icon={<FileJson size={17} />}>
            {selectedTool ? (
              <div className="jsonViewer compact">
                <pre>{JSON.stringify(selectedTool.inputSchema, null, 2)}</pre>
              </div>
            ) : null}
          </Panel>
        </section>
      </div>
    </main>
  );
}
