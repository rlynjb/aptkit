import React from 'react';
import { Boxes, BrainCircuit, Cloud, FileText, KeyRound, ShieldCheck } from 'lucide-react';
import type { PromptPackage } from '@aptkit/prompts';
import type { CapabilityEvent } from '@aptkit/runtime';
import type { ProviderStatus, ReplayMode } from './types';

export function Metric({ icon, label, value, tone = 'neutral' }: { icon: React.ReactNode; label: string; value: string; tone?: 'neutral' | 'good' }) {
  return (
    <div className={`metric ${tone}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function ModeButton({
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

export function ReplayModeSwitch<M extends string>({
  ariaLabel,
  className = '',
  mode,
  options,
  onSelect,
}: {
  ariaLabel: string;
  className?: string;
  mode: M;
  options: { mode: M; available: boolean; icon: React.ReactNode; label: string }[];
  onSelect: (mode: M) => void;
}) {
  return (
    <div className={`modeSwitch ${className}`.trim()} aria-label={ariaLabel}>
      {options.map((option) => (
        <ModeButton
          active={mode === option.mode}
          available={option.available}
          icon={option.icon}
          key={option.mode}
          label={option.label}
          onClick={() => onSelect(option.mode)}
        />
      ))}
    </div>
  );
}

export function Panel({ title, icon, children, wide = false }: { title: string; icon: React.ReactNode; children: React.ReactNode; wide?: boolean }) {
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

type TraceFilter = 'all' | 'model' | 'tools' | 'warnings';

export function TracePanel({ running, trace }: { running: boolean; trace: CapabilityEvent[] }) {
  const [filter, setFilter] = React.useState<TraceFilter>('all');
  const summary = summarizeTrace(trace);
  const visibleTrace = trace.filter((event) => traceFilterMatches(event, filter));

  return (
    <Panel title="Trace" icon={<BrainCircuit size={17} />}>
      {running ? <div className="emptyState compact">Collecting trace events...</div> : null}
      <div className="traceSummary" aria-label="Trace summary">
        <div>
          <span>Turns</span>
          <strong>{summary.turns}</strong>
        </div>
        <div>
          <span>Tools</span>
          <strong>{summary.toolCalls}</strong>
        </div>
        <div>
          <span>Warnings</span>
          <strong>{summary.warningCount}</strong>
        </div>
        <div>
          <span>Tokens</span>
          <strong>{summary.tokens.toLocaleString()}</strong>
        </div>
        <div>
          <span>{running ? 'Running' : 'Elapsed'}</span>
          <strong>{summary.elapsedMs === null ? '0ms' : formatTraceDuration(summary.elapsedMs)}</strong>
        </div>
      </div>
      <div className="traceFilters" aria-label="Trace filters">
        {(['all', 'model', 'tools', 'warnings'] as TraceFilter[]).map((option) => (
          <button
            className={filter === option ? 'active' : ''}
            key={option}
            onClick={() => setFilter(option)}
            type="button"
          >
            {option}
          </button>
        ))}
      </div>
      {!running && trace.length ? <div className="traceComplete">Final replay result received</div> : null}
      <div className="traceList">
        {visibleTrace.map((event, index) => (
          <TraceItem event={event} index={index} key={`${event.type}-${index}`} />
        ))}
        {!visibleTrace.length ? <div className="emptyState compact">No events for this filter.</div> : null}
      </div>
    </Panel>
  );
}

export function EvalPanel({
  error,
  evalOk,
  issues,
  passedLabel,
  running,
}: {
  error: string | null;
  evalOk: boolean | undefined;
  issues: string[];
  passedLabel: string;
  running: boolean;
}) {
  return (
    <Panel title="Eval" icon={<ShieldCheck size={17} />}>
      <div className={error ? 'evalError' : evalOk ? 'evalPass' : 'evalPending'}>
        {error ? 'replay failed' : evalOk ? passedLabel : running ? 'replay running' : 'waiting for replay'}
      </div>
      {issues.length ? (
        <ul className="issueList">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      ) : null}
    </Panel>
  );
}

export function PromptPackagePanel({
  promptPackage,
  renderedPrompt,
}: {
  promptPackage: PromptPackage;
  renderedPrompt?: { label: string; prompt: string };
}) {
  const lineCount = promptPackage.system.split('\n').length;
  const characterCount = promptPackage.system.length;
  const renderedLineCount = renderedPrompt?.prompt.split('\n').length ?? 0;

  return (
    <Panel title="Prompt Package" icon={<FileText size={17} />}>
      <div className="promptPackage">
        <div className="promptPackageHeader">
          <div>
            <strong>{promptPackage.id}</strong>
            <span>{promptPackage.description}</span>
          </div>
          <em>v{promptPackage.version}</em>
        </div>
        <div className="promptStats">
          <div>
            <span>Capability</span>
            <strong>{promptPackage.capabilityId}</strong>
          </div>
          <div>
            <span>Template</span>
            <strong>{lineCount} lines / {characterCount.toLocaleString()} chars</strong>
          </div>
        </div>
        <div className="promptVariables">
          <span>Variables</span>
          <div>
            {promptPackage.variables.map((variable) => (
              <code key={variable.name}>{variable.name}</code>
            ))}
          </div>
        </div>
        <details className="promptPreview">
          <summary>System prompt</summary>
          <pre>{promptPackage.system}</pre>
        </details>
        {renderedPrompt ? (
          <details className="promptPreview rendered">
            <summary>{renderedPrompt.label} ({renderedLineCount} lines)</summary>
            <pre>{renderedPrompt.prompt}</pre>
          </details>
        ) : null}
      </div>
    </Panel>
  );
}

export function ProviderStatusPanel<M extends ReplayMode>({
  mode,
  providerStatus,
  supportedModes,
  trace,
}: {
  mode: M;
  providerStatus: ProviderStatus;
  supportedModes: readonly M[];
  trace: CapabilityEvent[];
}) {
  const fallback = fallbackSummary(mode, providerStatus);
  const warnings = trace.filter(isProviderFallbackWarning);

  return (
    <Panel title="Providers" icon={<KeyRound size={17} />}>
      <div className="providerStatusPanel">
        <div className="providerStatusList">
          {providerRows(providerStatus, supportedModes).map((provider) => (
            <div className={`providerStatusRow ${provider.available ? 'ready' : 'missing'} ${provider.id === mode ? 'active' : ''}`} key={provider.id}>
              <div>
                {provider.icon}
                <strong>{provider.label}</strong>
              </div>
              <span>{provider.badge}</span>
              <code>{provider.model}</code>
            </div>
          ))}
        </div>
        <div className={fallback.available ? 'providerFallback ready' : 'providerFallback'}>
          <strong>{fallback.title}</strong>
          <span>{fallback.detail}</span>
        </div>
        {warnings.length ? (
          <div className="providerWarnings">
            {warnings.slice(-3).map((event, index) => (
              <p key={`${event.timestamp}-${index}`}>{event.message}</p>
            ))}
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

export function TraceItem({ event, index }: { event: CapabilityEvent; index: number }) {
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
  const payload = tracePayload(event);

  return (
    <div className={`traceItem ${traceTone(event)}`}>
      <span>{String(index + 1).padStart(2, '0')}</span>
      <div>
        <strong>{event.type}</strong>
        <p>{detail}</p>
        {payload ? (
          <details className="tracePayload">
            <summary>{payload.label}</summary>
            <pre>{payload.value}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}

function providerRows<M extends ReplayMode>(
  providerStatus: ProviderStatus,
  supportedModes: readonly M[],
): { id: ReplayMode; label: string; available: boolean; model: string; badge: string; icon: React.ReactNode }[] {
  return (['fixture', 'openai', 'anthropic'] as ReplayMode[]).map((id) => {
    const status = providerStatus[id];
    const primary = supportedModes.includes(id as M);
    return {
      id,
      label: providerLabel(id),
      available: status.available,
      model: status.model,
      badge: id === 'fixture'
        ? 'ready'
        : status.available
          ? primary ? 'primary ready' : 'fallback ready'
          : 'missing key',
      icon: providerIcon(id),
    };
  });
}

function isProviderFallbackWarning(event: CapabilityEvent): event is Extract<CapabilityEvent, { type: 'warning' }> {
  return event.type === 'warning' && /fallback provider|Provider .* failed/.test(event.message);
}

function fallbackSummary(mode: ReplayMode, providerStatus: ProviderStatus): { title: string; detail: string; available: boolean } {
  if (mode === 'fixture') {
    return {
      title: 'Fixture mode',
      detail: 'Uses recorded fake model responses and fixture tools.',
      available: true,
    };
  }

  const fallbackMode: ReplayMode = mode === 'openai' ? 'anthropic' : 'openai';
  const fallback = providerStatus[fallbackMode];
  if (fallback.available) {
    return {
      title: `${providerLabel(mode)} fallback ready`,
      detail: `${providerLabel(mode)} can fail over to ${providerLabel(fallbackMode)} (${fallback.model}).`,
      available: true,
    };
  }

  return {
    title: 'No fallback configured',
    detail: `Set ${fallbackMode === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY'} to enable ${providerLabel(fallbackMode)} fallback.`,
    available: false,
  };
}

function providerLabel(mode: ReplayMode): string {
  if (mode === 'openai') return 'OpenAI';
  if (mode === 'anthropic') return 'Anthropic';
  return 'Fixture';
}

function providerIcon(mode: ReplayMode): React.ReactNode {
  if (mode === 'openai') return <KeyRound size={15} />;
  if (mode === 'anthropic') return <Cloud size={15} />;
  return <Boxes size={15} />;
}

function summarizeTrace(trace: CapabilityEvent[]) {
  const usageEvents = trace.filter((event): event is Extract<CapabilityEvent, { type: 'model_usage' }> => event.type === 'model_usage');
  const timestamps = trace
    .map((event) => Date.parse(event.timestamp))
    .filter((time) => Number.isFinite(time));
  const startedAt = timestamps.length ? Math.min(...timestamps) : null;
  const endedAt = timestamps.length ? Math.max(...timestamps) : null;

  return {
    turns: usageEvents.length,
    toolCalls: trace.filter((event) => event.type === 'tool_call_start').length,
    warningCount: trace.filter((event) => event.type === 'warning' || event.type === 'error').length,
    tokens: usageEvents.reduce((sum, event) => sum + (event.inputTokens ?? 0) + (event.outputTokens ?? 0), 0),
    elapsedMs: startedAt === null || endedAt === null ? null : Math.max(0, endedAt - startedAt),
  };
}

function traceFilterMatches(event: CapabilityEvent, filter: TraceFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'model') return event.type === 'model_usage' || event.type === 'step';
  if (filter === 'tools') return event.type === 'tool_call_start' || event.type === 'tool_call_end';
  return event.type === 'warning' || event.type === 'error';
}

function tracePayload(event: CapabilityEvent): { label: string; value: string } | null {
  if (event.type === 'tool_call_start') return { label: 'Arguments', value: formatPayload(event.args) };
  if (event.type === 'tool_call_end' && event.result !== undefined) return { label: 'Result', value: formatPayload(event.result) };
  if (event.type === 'tool_call_end' && event.error) return { label: 'Error', value: event.error };
  if (event.type === 'step' && event.content.length > 120) return { label: 'Full step', value: event.content };
  return null;
}

function traceTone(event: CapabilityEvent): string {
  if (event.type === 'error') return 'error';
  if (event.type === 'warning') return 'warning';
  if (event.type === 'tool_call_end') return event.error ? 'error' : 'success';
  return '';
}

function formatPayload(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatTraceDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}
