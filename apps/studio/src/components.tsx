import React from 'react';
import { BrainCircuit, FileText, ShieldCheck } from 'lucide-react';
import type { PromptPackage } from '@aptkit/prompts';
import type { CapabilityEvent } from '@aptkit/runtime';

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

export function TracePanel({ running, trace }: { running: boolean; trace: CapabilityEvent[] }) {
  return (
    <Panel title="Trace" icon={<BrainCircuit size={17} />}>
      {running ? <div className="emptyState compact">Collecting trace events...</div> : null}
      <div className="traceList">
        {trace.map((event, index) => (
          <TraceItem event={event} index={index} key={`${event.type}-${index}`} />
        ))}
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

export function PromptPackagePanel({ promptPackage }: { promptPackage: PromptPackage }) {
  const lineCount = promptPackage.system.split('\n').length;
  const characterCount = promptPackage.system.length;

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
